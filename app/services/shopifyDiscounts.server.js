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
      // The Function only discounts gift lines tagged with this id in their
      // `_cartpromo_rule` property, and never more than one unit per rule.
      ruleId: rule.id,
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

// The stored gid says which kind of discount it is: code discounts are
// DiscountCodeNode, automatic ones DiscountAutomaticNode. Shopify cannot turn
// one into the other, and each kind's update/delete mutation rejects the
// other's ids with "Invalid id".
function discountKind(discountId) {
  if (/DiscountCodeNode/.test(discountId ?? "")) return "CODE";
  if (/DiscountAutomaticNode/.test(discountId ?? "")) return "AUTOMATIC";
  return null;
}

/**
 * Creates or updates the live Shopify discount for an ACTIVE rule.
 *
 * Resolves to `{ discountId, staleDiscountId }`. `staleDiscountId` is set when
 * the method was switched (code <-> automatic): Shopify can't change a
 * discount's type in place, so the new discount is created FIRST and the old
 * one is left for the caller to delete once the new id is safely stored. A
 * failure anywhere before that leaves the old discount and stored id untouched.
 *
 * For a non-ACTIVE rule nothing is created; use removeShopifyDiscount.
 */
export async function syncShopifyDiscount(admin, rule) {
  if (rule.status !== "ACTIVE") {
    return { discountId: rule.shopifyDiscountId ?? null, staleDiscountId: null };
  }

  let existingId = rule.shopifyDiscountId ?? null;
  let staleDiscountId = null;

  if (existingId) {
    const storedKind = discountKind(existingId);
    if ((await findMissingDiscountIds(admin, [existingId])).length) {
      // Deleted in Shopify admin: nothing to update or clean up, just create anew.
      existingId = null;
    } else if (storedKind && storedKind !== rule.discountMethod) {
      staleDiscountId = existingId;
      existingId = null;
    }
  }

  const discountInput = buildDiscountInput(rule);
  // Context (customers/segments) is diffed against the live discount we update,
  // not against the stale one we are replacing.
  discountInput.context = await buildContext(admin, { ...rule, shopifyDiscountId: existingId });

  const isCode = rule.discountMethod === "CODE";
  if (isCode) {
    discountInput.code = rule.code;
    discountInput.usageLimit = rule.usageLimit ?? null;
    discountInput.appliesOncePerCustomer = Boolean(rule.oncePerCustomer);
  }
  const [updateMutation, createMutation] = isCode ? [CODE_UPDATE, CODE_CREATE] : [AUTOMATIC_UPDATE, AUTOMATIC_CREATE];
  const pick = (result) => (isCode ? result.codeAppDiscount : result.automaticAppDiscount).discountId;

  if (existingId) {
    try {
      return { discountId: pick(await run(admin, updateMutation, { id: existingId, discount: discountInput })), staleDiscountId };
    } catch (error) {
      // Stale id that slipped past the existence check: replace it.
      if (!isMissingDiscountError(error)) throw error;
    }
  }
  return { discountId: pick(await run(admin, createMutation, { discount: discountInput })), staleDiscountId };
}

/** Does a Shopify discount already use this code? Resolves to its gid, or null. */
export async function findDiscountIdByCode(admin, code) {
  try {
    const response = await admin.graphql(
      `#graphql
        query cartPromoCodeLookup($code: String!) {
          codeDiscountNodeByCode(code: $code) { id }
        }
      `,
      { variables: { code } },
    );
    const json = await response.json();
    if (json.errors?.length) return null;
    return json.data?.codeDiscountNodeByCode?.id ?? null;
  } catch {
    // Can't tell: let Shopify's own uniqueness check have the last word.
    return null;
  }
}

const DISCOUNT_STATES_QUERY = `#graphql
  query cartPromoDiscountStates($ids: [ID!]!) {
    nodes(ids: $ids) {
      id
      ... on DiscountAutomaticNode {
        automaticDiscount {
          ... on DiscountAutomaticApp { status }
        }
      }
      ... on DiscountCodeNode {
        codeDiscount {
          ... on DiscountCodeApp { status }
        }
      }
      ... on DiscountNode {
        discount {
          ... on DiscountAutomaticApp { status }
          ... on DiscountCodeApp { status }
        }
      }
    }
  }
`;

// The discount gid we store can be a DiscountAutomaticNode, a DiscountCodeNode
// or a DiscountNode depending on the mutation that produced it, so the status
// is read from whichever of the three shapes came back.
function discountStatus(node) {
  return node?.automaticDiscount?.status ?? node?.codeDiscount?.status ?? node?.discount?.status ?? null;
}

/**
 * Looks up the live state of the given discount gids:
 *  - `missing`: deleted in Shopify admin.
 *  - `expired`: still there, but no longer running. Shopify has no "disabled"
 *    discount status — its Deactivate button sets the end date to now — so a
 *    discount a merchant deactivated reports EXPIRED.
 *
 * An id whose state can't be read appears in neither list: a transient API
 * error must never delete or disable a merchant's promotion.
 */
export async function fetchDiscountStates(admin, discountIds) {
  if (!discountIds.length) return { missing: [], expired: [] };
  try {
    const response = await admin.graphql(DISCOUNT_STATES_QUERY, { variables: { ids: discountIds } });
    const json = await response.json();
    if (json.errors?.length || !Array.isArray(json.data?.nodes)) {
      // Keep the delete detection working even if the status fields don't
      // resolve (API version change): fall back to the plain existence check.
      return { missing: await findMissingDiscountIds(admin, discountIds), expired: [] };
    }
    const missing = [];
    const expired = [];
    json.data.nodes.forEach((node, i) => {
      if (node === null) missing.push(discountIds[i]);
      else if (discountStatus(node) === "EXPIRED") expired.push(discountIds[i]);
    });
    return { missing, expired };
  } catch {
    return { missing: [], expired: [] };
  }
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
  return /does not exist|not found|invalid id/i.test(error?.message ?? "");
}

// Idempotent: the discount may already be gone (deleted in Shopify admin), or
// the stored id may be of the other kind if the rule's method was changed.
export async function removeShopifyDiscount(admin, rule) {
  if (!rule.shopifyDiscountId) return;
  // Trust the id's kind over the rule's current method: after a method switch
  // they disagree, and the wrong mutation fails and leaves the discount live.
  const kind = discountKind(rule.shopifyDiscountId) ?? rule.discountMethod;
  const [primary, fallback] =
    kind === "CODE" ? [CODE_DELETE, AUTOMATIC_DELETE] : [AUTOMATIC_DELETE, CODE_DELETE];
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
