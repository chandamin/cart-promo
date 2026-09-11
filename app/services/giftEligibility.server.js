import { listActiveRules } from "./promotionRules.server";

/**
 * Server-side mirror of extensions/free-gift-discount's trigger-matching
 * logic, used by the storefront (app proxy) and checkout extension to decide
 * which gift(s) to physically add to the cart. Deliberately mirrors the
 * Function's pooled-collection semantics (see that function's comments) so
 * a gift the storefront adds is the same gift the Function will make free.
 *
 * @param {import("../shopify.server").AdminApiContext} admin
 * @param {string} shop
 * @param {{ productId: string, variantId: string, quantity: number }[]} cartLines
 * @param {string[]} appliedCodes Discount codes currently applied to the cart/checkout.
 *   A CODE-method rule only qualifies when its code is in this list — its cart
 *   triggers are irrelevant until the code has actually been entered.
 */
export async function evaluateGiftRules(admin, shop, cartLines, appliedCodes = []) {
  const rules = (await listActiveRules(shop, "FREE_GIFT")).filter(
    (rule) =>
      rule.discountMethod === "AUTOMATIC" ||
      appliedCodes.some((code) => code.toUpperCase() === rule.code?.toUpperCase()),
  );
  if (!rules.length) {
    return { qualifying: [], giftVariantIds: [] };
  }

  const giftVariantIds = new Set();
  for (const rule of rules) {
    for (const gift of rule.config.gifts) giftVariantIds.add(gift.variantId);
  }

  const nonGiftLines = cartLines.filter((line) => !giftVariantIds.has(line.variantId));
  const productIds = [...new Set(nonGiftLines.map((line) => line.productId))];
  const collectionsByProduct = await fetchProductCollectionIds(admin, productIds);

  const qualifying = [];
  for (const rule of rules) {
    if (isTriggerSatisfied(rule, nonGiftLines, collectionsByProduct)) {
      qualifying.push({ ruleId: rule.id, gifts: rule.config.gifts });
    }
  }

  return { qualifying, giftVariantIds: [...giftVariantIds] };
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

function isTriggerSatisfied(rule, lines, collectionsByProduct) {
  const { triggers, triggerMatch } = rule;
  const conditionQuantity = (condition) =>
    lines
      .filter((line) => lineMatchesCondition(line, condition, collectionsByProduct))
      .reduce((sum, line) => sum + line.quantity, 0);

  if (triggerMatch === "ALL") {
    return triggers.every((condition) => conditionQuantity(condition) >= (condition.minQuantity ?? 1));
  }
  return triggers.some((condition) => conditionQuantity(condition) >= (condition.minQuantity ?? 1));
}
