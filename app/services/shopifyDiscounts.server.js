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

function minRequirementConfig(rule) {
  const req = rule.minRequirement;
  return req && req.type && req.type !== "NONE" ? { type: req.type, value: Number(req.value) } : null;
}

function buildMetafields(rule) {
  const triggers = (rule.triggers ?? []).map((t) => ({
    kind: t.kind,
    id: t.id,
    minQuantity: t.minQuantity ?? 1,
  }));
  // Shown to customers on cart/checkout lines.
  const label = rule.cartLabel || rule.name;
  const minRequirement = minRequirementConfig(rule);

  if (rule.type === "FREE_GIFT") {
    const config = {
      triggerMatch: rule.triggerMatch,
      triggers,
      giftVariantIds: rule.config.gifts.map((g) => g.variantId),
      minRequirement,
      label,
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
    minRequirement,
    label,
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
    tags: Array.isArray(rule.tags) ? rule.tags : [],
  };
}

const DISCOUNT_CONTEXT_QUERY = `#graphql
  query cartPromoDiscountContext($id: ID!) {
    discountNode(id: $id) {
      discount {
        ... on DiscountAutomaticApp {
          context {
            __typename
            ... on DiscountCustomers { customers { id } }
            ... on DiscountCustomerSegments { segments { id } }
          }
        }
        ... on DiscountCodeApp {
          context {
            __typename
            ... on DiscountCustomers { customers { id } }
            ... on DiscountCustomerSegments { segments { id } }
          }
        }
      }
    }
  }
`;

// Customer/segment context is add/remove based, so an update must remove the
// ids that are no longer selected (read from the live discount).
async function fetchCurrentContextIds(admin, discountId) {
  if (!discountId) return { customers: [], segments: [] };
  try {
    const payload = await run(admin, DISCOUNT_CONTEXT_QUERY, { id: discountId });
    const context = payload?.discount?.context;
    return {
      customers: (context?.customers ?? []).map((c) => c.id),
      segments: (context?.segments ?? []).map((s) => s.id),
    };
  } catch {
    return { customers: [], segments: [] };
  }
}

async function buildContext(admin, rule) {
  const eligibility = rule.eligibility;
  if (!eligibility || eligibility.type === "ALL") {
    return { all: "ALL" };
  }
  const current = await fetchCurrentContextIds(admin, rule.shopifyDiscountId);
  if (eligibility.type === "SEGMENTS") {
    const ids = eligibility.segments.map((s) => s.id);
    return {
      customerSegments: { add: ids, remove: current.segments.filter((id) => !ids.includes(id)) },
    };
  }
  const ids = eligibility.customers.map((c) => c.id);
  return {
    customers: { add: ids, remove: current.customers.filter((id) => !ids.includes(id)) },
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
  discountInput.context = await buildContext(admin, rule);

  if (rule.discountMethod === "CODE") {
    discountInput.code = rule.code;
    discountInput.usageLimit = rule.usageLimit ?? null;
    discountInput.appliesOncePerCustomer = Boolean(rule.oncePerCustomer);
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

/**
 * Of the given discount gids, returns those that no longer exist in Shopify
 * (deleted in admin). Returns [] if the lookup itself fails, so callers never
 * act on a transient API error.
 */
export async function findMissingDiscountIds(admin, discountIds) {
  if (!discountIds.length) return [];
  try {
    const response = await admin.graphql(
      `#graphql
        query cartPromoDiscountsExist($ids: [ID!]!) { nodes(ids: $ids) { id } }
      `,
      { variables: { ids: discountIds } },
    );
    const json = await response.json();
    if (json.errors?.length || !Array.isArray(json.data?.nodes)) return [];
    return discountIds.filter((_, i) => json.data.nodes[i] === null);
  } catch {
    return [];
  }
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
