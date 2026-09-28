/**
 * Wires a saved PromotionRule to a real Shopify discount (DiscountAutomaticApp
 * or DiscountCodeApp), so the storefront/checkout actually sees it. Kept
 * separate from promotionRules.server.js so the DB CRUD stays free of
 * Shopify API calls.
 */

const METAFIELD_NAMESPACE = "$app:cartpromo";

const FUNCTION_HANDLE = {
  FREE_GIFT: "free-gift-discount",
  TIERED_DISCOUNT: "tiered-discount",
};

const CONFIG_KEY = {
  FREE_GIFT: "free-gift-config",
  TIERED_DISCOUNT: "tiered-discount-config",
};

const VARIABLES_KEY = {
  FREE_GIFT: "free-gift-variables",
  TIERED_DISCOUNT: "tiered-discount-variables",
};

function collectionIds(conditions) {
  return conditions.filter((c) => c.kind === "COLLECTION").map((c) => c.id);
}

function metafieldEntry(key, value) {
  return { namespace: METAFIELD_NAMESPACE, key, type: "json", value: JSON.stringify(value) };
}

function buildMetafields(rule) {
  const triggers = rule.triggers.map((t) => ({
    kind: t.kind,
    id: t.id,
    minQuantity: t.minQuantity ?? 1,
  }));

  if (rule.type === "FREE_GIFT") {
    const config = {
      triggerMatch: rule.triggerMatch,
      triggers,
      giftVariantIds: rule.config.gifts.map((g) => g.variantId),
    };
    const variables = { triggerCollectionIds: collectionIds(rule.triggers) };
    return [
      metafieldEntry(CONFIG_KEY.FREE_GIFT, config),
      metafieldEntry(VARIABLES_KEY.FREE_GIFT, variables),
    ];
  }

  const exclusions = (rule.config.exclusions ?? []).map((e) => ({ kind: e.kind, id: e.id }));
  const config = {
    triggerMatch: rule.triggerMatch,
    triggers,
    basis: rule.config.basis,
    tiers: rule.config.tiers,
    exclusions,
  };
  const variables = {
    triggerCollectionIds: collectionIds(rule.triggers),
    excludedCollectionIds: collectionIds(exclusions),
  };
  return [
    metafieldEntry(CONFIG_KEY.TIERED_DISCOUNT, config),
    metafieldEntry(VARIABLES_KEY.TIERED_DISCOUNT, variables),
  ];
}

function buildDiscountInput(rule) {
  return {
    title: rule.name,
    functionHandle: FUNCTION_HANDLE[rule.type],
    discountClasses: ["PRODUCT"],
    combinesWith: rule.combinesWith,
    startsAt: rule.startsAt ? new Date(rule.startsAt).toISOString() : new Date().toISOString(),
    endsAt: rule.endsAt ? new Date(rule.endsAt).toISOString() : null,
    metafields: buildMetafields(rule),
  };
}

const AUTOMATIC_CREATE = `#graphql
  mutation cartPromoAutomaticCreate($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const AUTOMATIC_UPDATE = `#graphql
  mutation cartPromoAutomaticUpdate($id: ID!, $discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const AUTOMATIC_DELETE = `#graphql
  mutation cartPromoAutomaticDelete($id: ID!) {
    discountAutomaticDelete(id: $id) {
      deletedAutomaticDiscountId
      userErrors { field message }
    }
  }
`;

const CODE_CREATE = `#graphql
  mutation cartPromoCodeCreate($discount: DiscountCodeAppInput!) {
    discountCodeAppCreate(codeAppDiscount: $discount) {
      codeAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const CODE_UPDATE = `#graphql
  mutation cartPromoCodeUpdate($id: ID!, $discount: DiscountCodeAppInput!) {
    discountCodeAppUpdate(id: $id, codeAppDiscount: $discount) {
      codeAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const CODE_DELETE = `#graphql
  mutation cartPromoCodeDelete($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
      userErrors { field message }
    }
  }
`;

async function run(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  const payload = json.data && Object.values(json.data)[0];
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((e) => e.message).join("; "));
  }
  return payload;
}

/**
 * Creates or updates the live Shopify discount for an ACTIVE rule, or removes
 * it for a DRAFT/DISABLED rule. Returns the discount gid (or null if removed).
 */
export async function syncShopifyDiscount(admin, rule) {
  if (rule.status !== "ACTIVE") {
    if (rule.shopifyDiscountId) {
      await removeShopifyDiscount(admin, rule);
    }
    return null;
  }

  const discountInput = buildDiscountInput(rule);

  if (rule.discountMethod === "CODE") {
    discountInput.code = rule.code;
    if (rule.shopifyDiscountId) {
      try {
        const result = await run(admin, CODE_UPDATE, { id: rule.shopifyDiscountId, discount: discountInput });
        return result.codeAppDiscount.discountId;
      } catch (error) {
        // Stale id: clean up whatever it points to, then create a fresh discount.
        if (!isMissingDiscountError(error)) throw error;
        await removeShopifyDiscount(admin, rule);
      }
    }
    const result = await run(admin, CODE_CREATE, { discount: discountInput });
    return result.codeAppDiscount.discountId;
  }

  if (rule.shopifyDiscountId) {
    try {
      const result = await run(admin, AUTOMATIC_UPDATE, { id: rule.shopifyDiscountId, discount: discountInput });
      return result.automaticAppDiscount.discountId;
    } catch (error) {
      if (!isMissingDiscountError(error)) throw error;
      await removeShopifyDiscount(admin, rule);
    }
  }
  const result = await run(admin, AUTOMATIC_CREATE, { discount: discountInput });
  return result.automaticAppDiscount.discountId;
}

function isMissingDiscountError(error) {
  return /does not exist|not found/i.test(error?.message ?? "");
}

// Idempotent: the discount may already be gone (deleted in Shopify admin), or
// the stored id may be of the other kind if the rule's method was changed.
export async function removeShopifyDiscount(admin, rule) {
  if (!rule.shopifyDiscountId) return;
  const [primary, fallback] =
    rule.discountMethod === "CODE" ? [CODE_DELETE, AUTOMATIC_DELETE] : [AUTOMATIC_DELETE, CODE_DELETE];
  try {
    await run(admin, primary, { id: rule.shopifyDiscountId });
  } catch (error) {
    if (!isMissingDiscountError(error)) throw error;
    try {
      await run(admin, fallback, { id: rule.shopifyDiscountId });
    } catch (fallbackError) {
      if (!isMissingDiscountError(fallbackError)) throw fallbackError;
    }
  }
}
