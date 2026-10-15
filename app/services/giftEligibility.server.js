import { listActiveRules } from "./promotionRules.server";
import { reconcileWithShopify } from "./promotions.server";

/**
 * Server-side mirror of extensions/free-gift-discount's trigger-matching
 * logic, used by the storefront (app proxy) and checkout extension to decide
 * which gift(s) to physically add to the cart. Deliberately mirrors the
 * Function's pooled-collection semantics (see that function's comments) so
 * a gift the storefront adds is the same gift the Function will make free.
 *
 * @param {import("../shopify.server").AdminApiContext} admin
 * @param {string} shop
 * @param {{ productId: string, variantId: string, quantity: number, amount?: number, isGift?: boolean }[]} cartLines
 *   `amount` is the line subtotal before discounts; `isGift` marks CartPromo gift lines.
 * @param {string[]} appliedCodes Discount codes currently applied to the cart/checkout.
 *   A CODE-method rule only qualifies when its code is in this list — its cart
 *   triggers are irrelevant until the code has actually been entered.
 * @param {string | null} customerId Customer gid, or null for guests. Used for
 *   customer/segment eligibility, which Shopify enforces on the discount itself.
 */
export async function evaluateGiftRules(admin, shop, cartLines, appliedCodes = [], customerId = null) {
  // Never offer a gift whose discount was deleted or deactivated in Shopify:
  // it would be added to the cart at full price.
  const liveRules = (await reconcileWithShopify(admin, shop, await listActiveRules(shop, "FREE_GIFT"))).filter(
    (rule) => rule.status === "ACTIVE",
  );
  const activeRules = liveRules.filter(
    (rule) =>
      rule.discountMethod === "AUTOMATIC" ||
      appliedCodes.some((code) => code.toUpperCase() === rule.code?.toUpperCase()),
  );
  const rules = await filterEligibleRules(admin, activeRules, customerId);
  if (!rules.length) {
    return { qualifying: [], giftVariantIds: [] };
  }

  const giftVariantIds = new Set();
  for (const rule of rules) {
    for (const gift of rule.config.gifts) giftVariantIds.add(gift.variantId);
  }

  const nonGiftLines = cartLines.filter((line) => !line.isGift && !giftVariantIds.has(line.variantId));
  const productIds = [...new Set(nonGiftLines.map((line) => line.productId))];
  const collectionsByProduct = await fetchProductCollectionIds(admin, productIds);

  const qualifying = [];
  for (const rule of rules) {
    if (
      isTriggerSatisfied(rule, nonGiftLines, collectionsByProduct) &&
      meetsMinRequirement(rule.minRequirement, nonGiftLines)
    ) {
      qualifying.push({ ruleId: rule.id, gifts: rule.config.gifts });
    }
  }

  return { qualifying: await withSellableGiftsOnly(admin, qualifying), giftVariantIds: [...giftVariantIds] };
}

/**
 * Drops gifts the storefront could not actually add — a sold-out giveaway
 * variant makes /cart/add.js fail, so offering it just gives the customer a
 * button that does nothing. A rule left with no giftable variant stops
 * qualifying altogether.
 *
 * If the lookup fails, every gift is offered as before: a transient API error
 * must not silently withhold a merchant's gift.
 */
async function withSellableGiftsOnly(admin, qualifying) {
  const variantIds = [...new Set(qualifying.flatMap((q) => q.gifts.map((gift) => gift.variantId)))];
  if (!variantIds.length) return qualifying;

  const unsellable = await fetchUnsellableVariantIds(admin, variantIds);
  if (!unsellable.size) return qualifying;

  return qualifying
    .map((q) => ({ ...q, gifts: q.gifts.filter((gift) => !unsellable.has(gift.variantId)) }))
    .filter((q) => q.gifts.length);
}

async function fetchUnsellableVariantIds(admin, variantIds) {
  try {
    const response = await admin.graphql(
      `#graphql
        query cartPromoGiftAvailability($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              availableForSale
            }
          }
        }
      `,
      { variables: { ids: variantIds } },
    );
    const json = await response.json();
    if (json.errors?.length || !Array.isArray(json.data?.nodes)) return new Set();
    const unsellable = new Set();
    json.data.nodes.forEach((node, i) => {
      // A deleted variant comes back as null, and can't be added either.
      if (node === null || node.availableForSale === false) unsellable.add(variantIds[i]);
    });
    return unsellable;
  } catch {
    return new Set();
  }
}

async function filterEligibleRules(admin, rules, customerId) {
  const segmentIds = [
    ...new Set(
      rules
        .filter((rule) => rule.eligibility?.type === "SEGMENTS")
        .flatMap((rule) => rule.eligibility.segments.map((s) => s.id)),
    ),
  ];
  const memberOf = customerId && segmentIds.length ? await fetchSegmentMemberships(admin, customerId, segmentIds) : new Set();

  return rules.filter((rule) => {
    const eligibility = rule.eligibility;
    if (!eligibility || eligibility.type === "ALL") return true;
    if (!customerId) return false;
    if (eligibility.type === "CUSTOMERS") {
      return eligibility.customers.some((c) => c.id === customerId);
    }
    return eligibility.segments.some((s) => memberOf.has(s.id));
  });
}

async function fetchSegmentMemberships(admin, customerId, segmentIds) {
  try {
    const response = await admin.graphql(
      `#graphql
        query cartPromoSegmentMembership($customerId: ID!, $segmentIds: [ID!]!) {
          customerSegmentMembership(customerId: $customerId, segmentIds: $segmentIds) {
            memberships { segmentId isMember }
          }
        }
      `,
      { variables: { customerId, segmentIds } },
    );
    const json = await response.json();
    const memberships = json.data?.customerSegmentMembership?.memberships ?? [];
    return new Set(memberships.filter((m) => m.isMember).map((m) => m.segmentId));
  } catch {
    return new Set();
  }
}

async function fetchProductCollectionIds(admin, productIds) {
  const map = new Map();
  if (!productIds.length) return map;

  const response = await admin.graphql(
    `#graphql
      query cartPromoProductCollections($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            collections(first: 100) {
              nodes { id }
            }
          }
        }
      }
    `,
    { variables: { ids: productIds } },
  );
  const json = await response.json();
  for (const node of json.data?.nodes ?? []) {
    if (!node?.id) continue;
    map.set(node.id, new Set(node.collections.nodes.map((c) => c.id)));
  }
  return map;
}

function lineMatchesCondition(line, condition, collectionsByProduct) {
  if (condition.kind === "PRODUCT") {
    return line.productId === condition.id;
  }
  return collectionsByProduct.get(line.productId)?.has(condition.id) ?? false;
}

function meetsMinRequirement(minRequirement, lines) {
  if (!minRequirement || !minRequirement.type || minRequirement.type === "NONE") return true;
  if (minRequirement.type === "AMOUNT") {
    const subtotal = lines.reduce((sum, line) => sum + Number(line.amount ?? 0), 0);
    return subtotal >= Number(minRequirement.value);
  }
  return lines.reduce((sum, line) => sum + line.quantity, 0) >= Number(minRequirement.value);
}

function isTriggerSatisfied(rule, lines, collectionsByProduct) {
  const { triggers, triggerMatch } = rule;
  // No cart conditions: the minimum purchase requirement alone decides.
  if (!triggers?.length) return true;
  const conditionQuantity = (condition) =>
    lines
      .filter((line) => lineMatchesCondition(line, condition, collectionsByProduct))
      .reduce((sum, line) => sum + line.quantity, 0);

  if (triggerMatch === "ALL") {
    return triggers.every((condition) => conditionQuantity(condition) >= (condition.minQuantity ?? 1));
  }
  return triggers.some((condition) => conditionQuantity(condition) >= (condition.minQuantity ?? 1));
}
