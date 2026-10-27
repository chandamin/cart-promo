/**
 * Orchestrates promotionRules.server.js (DB CRUD) and shopifyDiscounts.server.js
 * (live Shopify discount) together. Both the admin UI actions and the public
 * API routes (api.promotions.*) go through this module rather than calling either
 * service directly, so activation/deactivation behavior stays in one place.
 */
import { Prisma } from "@prisma/client";
import {
  RuleFieldError,
  RULE_STATUSES,
  deleteRule,
  deleteRuleByShopifyDiscountId,
  disableRuleByShopifyDiscountId,
  findRule,
  findRuleWithCode,
  getRule,
  insertRecord,
  patchRule,
  prepareRecord,
  setStatus,
} from "./promotionRules.server";
import {
  fetchDiscountStates,
  findDiscountIdByCode,
  removeShopifyDiscount,
  syncShopifyDiscount,
} from "./shopifyDiscounts.server";

/**
 * Saving a rule changes two things that must never disagree: our database row
 * and the live Shopify discount. The Shopify call always goes first and the
 * database is only written once it succeeded, so a failed save leaves both
 * exactly as they were (the error is shown, the old record stays).
 *
 * The one exception is turning a rule OFF: deleting its Shopify discount fires
 * the discounts/delete webhook, which removes any ACTIVE rule behind that
 * discount, so the status leaves ACTIVE first and goes back if the delete fails.
 */

const DEFAULT_COMBINES = { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false };

export async function saveRule(admin, shop, id, input) {
  // Validates, and returns the fields exactly as they will be stored.
  const record = prepareRecord(shop, input);
  const existing = id === "new" ? null : await getRule(shop, id);

  await assertCodeAvailable(admin, shop, record, existing);

  if (!existing) {
    // The Function needs the rule id (to tell a gift line from a paid product),
    // so the row exists before the discount does. It starts as DRAFT, which the
    // storefront ignores, and is removed again if the discount can't be created.
    const created = await insertRecord({ ...record, status: "DRAFT" });
    try {
      return await applyChange(admin, shop, created, record);
    } catch (error) {
      await deleteRule(shop, created.id).catch(() => {});
      throw error;
    }
  }
  return applyChange(admin, shop, existing, record);
}

export async function changeRuleStatus(admin, shop, id, status) {
  if (!RULE_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const existing = await getRule(shop, id);
  return applyChange(admin, shop, existing, { status });
}

/** Applies `fields` (a full record or just `{ status }`) to `existing`, Shopify first. */
async function applyChange(admin, shop, existing, fields) {
  const next = { ...existing, ...fields };

  if (next.status === "ACTIVE") {
    const { discountId, staleDiscountId } = await syncShopifyDiscount(admin, next);
    let saved;
    try {
      saved = await patchRule(shop, existing.id, { ...fields, shopifyDiscountId: discountId });
    } catch (error) {
      // Couldn't record the new discount: don't leave it live without a rule.
      if (discountId !== existing.shopifyDiscountId) {
        await removeShopifyDiscount(admin, { ...next, shopifyDiscountId: discountId }).catch(() => {});
      }
      throw error;
    }
    if (staleDiscountId) {
      await removeStaleDiscount(admin, shop, existing, saved, staleDiscountId);
    }
    return saved;
  }

  // Turning off (or saving a draft): the discount goes, the rule stays.
  if (existing.status === "ACTIVE") {
    await patchRule(shop, existing.id, { status: next.status });
  }
  if (existing.shopifyDiscountId) {
    try {
      await removeShopifyDiscount(admin, existing);
    } catch (error) {
      if (existing.status === "ACTIVE") {
        await patchRule(shop, existing.id, { status: existing.status }).catch(() => {});
      }
      throw error;
    }
  }
  return patchRule(shop, existing.id, { ...fields, shopifyDiscountId: null });
}

/**
 * After a method switch the old discount is deleted. If that fails, both would
 * stay live (and the old code would keep working with no rule behind it), so
 * the change is rolled back: the old record returns and the new discount goes.
 */
async function removeStaleDiscount(admin, shop, before, saved, staleDiscountId) {
  try {
    await removeShopifyDiscount(admin, { ...before, shopifyDiscountId: staleDiscountId });
  } catch (error) {
    await patchRule(shop, before.id, snapshot(before));
    await removeShopifyDiscount(admin, saved).catch(() => {});
    throw error;
  }
}

function snapshot(rule) {
  return {
    type: rule.type,
    name: rule.name,
    status: rule.status,
    discountMethod: rule.discountMethod,
    code: rule.code,
    combinesWith: rule.combinesWith ?? DEFAULT_COMBINES,
    startsAt: rule.startsAt,
    endsAt: rule.endsAt,
    triggers: rule.triggers,
    triggerMatch: rule.triggerMatch,
    config: rule.config,
    // Nullable Json columns need Prisma's explicit null to be written back.
    minRequirement: rule.minRequirement ?? Prisma.DbNull,
    eligibility: rule.eligibility ?? Prisma.DbNull,
    usageLimit: rule.usageLimit,
    oncePerCustomer: rule.oncePerCustomer,
    tags: rule.tags ?? Prisma.DbNull,
    cartLabel: rule.cartLabel,
    shopifyDiscountId: rule.shopifyDiscountId,
  };
}

/** A code can belong to one discount only: say so on save, not on Enable. */
async function assertCodeAvailable(admin, shop, record, existing) {
  if (record.discountMethod !== "CODE" || !record.code) return;

  const sameShopRule = await findRuleWithCode(shop, record.code, existing?.id ?? null);
  const usedByShopify = await findDiscountIdByCode(admin, record.code);
  const ownDiscount = existing?.shopifyDiscountId ?? null;
  if (sameShopRule || (usedByShopify && usedByShopify !== ownDiscount)) {
    throw new RuleFieldError("code", "This code is already used by another discount.");
  }
}

/**
 * Brings rules back in step with what the merchant did on Shopify's own
 * discount page, and returns them as they now stand:
 *  - discount deleted in Shopify -> the rule is removed from the list;
 *  - discount deactivated in Shopify -> the rule is marked DISABLED.
 *
 * The discounts/delete and discounts/update webhooks do both live; this repeats
 * the check on read so the app is still right about changes those webhooks
 * missed (app offline, webhook not yet registered) — without it the storefront
 * goes on offering a gift that Shopify no longer makes free.
 *
 * Callers that act on rules (rather than list them) must still check `status`.
 */
export async function reconcileWithShopify(admin, shop, rules) {
  const linked = rules.filter((rule) => rule.status === "ACTIVE" && rule.shopifyDiscountId);
  if (!linked.length) return rules;

  const { missing, expired } = await fetchDiscountStates(
    admin,
    linked.map((rule) => rule.shopifyDiscountId),
  );
  for (const discountId of missing) {
    await deleteRuleByShopifyDiscountId(shop, discountId);
  }
  for (const discountId of expired) {
    await disableRuleByShopifyDiscountId(shop, discountId);
  }

  return rules
    .filter((rule) => !(rule.status === "ACTIVE" && missing.includes(rule.shopifyDiscountId)))
    .map((rule) =>
      rule.status === "ACTIVE" && expired.includes(rule.shopifyDiscountId)
        ? { ...rule, status: "DISABLED" }
        : rule,
    );
}

export async function removeRule(admin, shop, id) {
  const rule = await findRule(shop, id);
  // Already gone: the discounts/delete webhook removed it, or this is a second
  // click. Nothing to do, and reporting it as an error only confuses.
  if (!rule) return;

  // Deleting the discount fires discounts/delete, whose handler removes the
  // rule behind any ACTIVE discount. Drop out of ACTIVE first, or that webhook
  // deletes this row mid-flight and the delete below fails as "not found".
  // Doing it in this order also means a failed Shopify delete leaves the rule
  // in place to retry, rather than a live discount with no rule behind it.
  if (rule.status === "ACTIVE") {
    await setStatus(shop, id, "DISABLED");
  }
  await removeShopifyDiscount(admin, rule);
  await deleteRule(shop, id);
}
