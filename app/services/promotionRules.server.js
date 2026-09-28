import prisma from "../db.server";

/**
 * CRUD + validation for PromotionRule, kept free of any Shopify API calls so
 * the same functions can be called from admin UI actions today and from a
 * future token-authenticated API route without changes.
 */

export const RULE_TYPES = /** @type {const} */ (["FREE_GIFT", "TIERED_DISCOUNT"]);
export const RULE_STATUSES = /** @type {const} */ (["DRAFT", "ACTIVE", "DISABLED"]);
export const DISCOUNT_METHODS = /** @type {const} */ (["AUTOMATIC", "CODE"]);

function validateConditionList(list, label) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`At least one ${label} (product or collection) is required.`);
  }
  for (const entry of list) {
    if (!["PRODUCT", "COLLECTION"].includes(entry.kind)) {
      throw new Error(`Invalid ${label} kind: ${entry.kind}`);
    }
    if (!entry.id) {
      throw new Error(`Each ${label} needs a selected product or collection.`);
    }
  }
}

function validateTriggers(triggers) {
  validateConditionList(triggers, "cart trigger");
}

function validateFreeGiftConfig(config) {
  if (!Array.isArray(config.gifts) || config.gifts.length === 0) {
    throw new Error("At least one gift product is required.");
  }
  for (const gift of config.gifts) {
    if (!gift.variantId || !gift.productId) {
      throw new Error("Each gift option needs a product and variant.");
    }
  }
}

function validateTieredConfig(config) {
  if (!["QUANTITY", "AMOUNT"].includes(config.basis)) {
    throw new Error(`Invalid tier basis: ${config.basis}`);
  }
  if (!Array.isArray(config.tiers) || config.tiers.length === 0) {
    throw new Error("At least one tier is required.");
  }
  let lastThreshold = -Infinity;
  for (const tier of [...config.tiers].sort((a, b) => a.threshold - b.threshold)) {
    // A blank threshold arrives as 0, which would make the tier always apply.
    if (!(tier.threshold > 0) || !(tier.threshold > lastThreshold)) {
      throw new Error("Tier thresholds must be positive and strictly increasing.");
    }
    if (!["PERCENTAGE", "FIXED_AMOUNT"].includes(tier.rewardType)) {
      throw new Error(`Invalid tier reward type: ${tier.rewardType}`);
    }
    if (!(tier.value > 0)) {
      throw new Error("Tier reward value must be greater than zero.");
    }
    if (tier.rewardType === "PERCENTAGE" && tier.value > 100) {
      throw new Error("A percentage tier can't be more than 100% off.");
    }
    lastThreshold = tier.threshold;
  }
  if (config.exclusions?.length) {
    validateConditionList(config.exclusions, "exclusion");
  }
}

const CONFIG_VALIDATORS = {
  FREE_GIFT: validateFreeGiftConfig,
  TIERED_DISCOUNT: validateTieredConfig,
};

function validateRuleInput(input) {
  if (!RULE_TYPES.includes(input.type)) {
    throw new Error(`Invalid promotion type: ${input.type}`);
  }
  if (!input.name?.trim()) {
    throw new Error("Name is required.");
  }
  if (!DISCOUNT_METHODS.includes(input.discountMethod)) {
    throw new Error(`Invalid discount method: ${input.discountMethod}`);
  }
  if (input.discountMethod === "CODE" && !input.code?.trim()) {
    throw new Error("A discount code is required when the discount method is CODE.");
  }
  validateTriggers(input.triggers);
  CONFIG_VALIDATORS[input.type](input.config);
  if (input.type === "TIERED_DISCOUNT") {
    validateNoExcludedTriggers(input.triggers, input.config.exclusions);
  }
}

// An excluded product never counts toward tiers, so excluding a product that is
// itself a trigger makes the rule silently unreachable for it.
function validateNoExcludedTriggers(triggers, exclusions = []) {
  const excluded = new Set(exclusions.filter((e) => e.kind === "PRODUCT").map((e) => e.id));
  const overlap = triggers.filter((t) => t.kind === "PRODUCT" && excluded.has(t.id));
  if (overlap.length) {
    const names = overlap.map((t) => t.title ?? t.id).join(", ");
    throw new Error(`These products are both a cart condition and excluded: ${names}`);
  }
}

function toRecord(input) {
  return {
    shop: input.shop,
    type: input.type,
    name: input.name.trim(),
    status: input.status ?? "DRAFT",
    discountMethod: input.discountMethod,
    code: input.discountMethod === "CODE" ? input.code.trim() : null,
    combinesWith: input.combinesWith ?? {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    },
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
    triggers: input.triggers,
    triggerMatch: input.triggerMatch ?? "ANY",
    config: input.config,
  };
}

export async function listRules(shop) {
  return prisma.promotionRule.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });
}

// Also honors the schedule, matching when Shopify actually runs the discount —
// otherwise the storefront would add a gift the Function won't make free yet.
export async function listActiveRules(shop, type) {
  const now = new Date();
  return prisma.promotionRule.findMany({
    where: {
      shop,
      type,
      status: "ACTIVE",
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
    },
  });
}

export async function getRule(shop, id) {
  const rule = await prisma.promotionRule.findFirst({ where: { shop, id } });
  if (!rule) {
    throw new Error("Promotion rule not found.");
  }
  return rule;
}

export async function createRule(shop, input) {
  const record = { ...input, shop };
  validateRuleInput(record);
  return prisma.promotionRule.create({ data: toRecord(record) });
}

export async function updateRule(shop, id, input) {
  await getRule(shop, id); // 404s if missing/not owned by shop
  const record = { ...input, shop };
  validateRuleInput(record);
  return prisma.promotionRule.update({
    where: { id },
    data: toRecord(record),
  });
}

export async function deleteRule(shop, id) {
  await getRule(shop, id);
  return prisma.promotionRule.delete({ where: { id } });
}

/**
 * Called when a discount is deleted in Shopify admin: removes the rule that
 * owns it so the app never shows (or offers gifts for) a rule with no live
 * discount behind it.
 *
 * Only ACTIVE rules are removed. Deactivating a rule (DRAFT/DISABLED) also
 * deletes its Shopify discount, and that delete fires the same webhook; the
 * status is changed before the delete, so those rules are left alone.
 */
export async function deleteRuleByShopifyDiscountId(shop, shopifyDiscountId) {
  return prisma.promotionRule.deleteMany({
    where: { shop, shopifyDiscountId, status: "ACTIVE" },
  });
}

export async function setStatus(shop, id, status) {
  if (!RULE_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  await getRule(shop, id);
  return prisma.promotionRule.update({ where: { id }, data: { status } });
}

export async function setShopifyDiscountId(shop, id, shopifyDiscountId) {
  await getRule(shop, id);
  return prisma.promotionRule.update({ where: { id }, data: { shopifyDiscountId } });
}
