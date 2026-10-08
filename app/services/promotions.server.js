/**
 * Orchestrates promotionRules.server.js (DB CRUD) and shopifyDiscounts.server.js
 * (live Shopify discount) together. Both the admin UI actions and a future
 * public API route should go through this module rather than calling either
 * service directly, so activation/deactivation behavior stays in one place.
 */
import {
  createRule,
  updateRule,
  deleteRule,
  deleteRuleByShopifyDiscountId,
  getRule,
  setStatus,
  setShopifyDiscountId,
} from "./promotionRules.server";
import { findMissingDiscountIds, syncShopifyDiscount, removeShopifyDiscount } from "./shopifyDiscounts.server";

export async function saveRule(admin, shop, id, input) {
  const rule = id === "new" ? await createRule(shop, input) : await updateRule(shop, id, input);
  return syncOrRevertToDraft(admin, shop, rule);
}

export async function changeRuleStatus(admin, shop, id, status) {
  const rule = await setStatus(shop, id, status);
  return syncOrRevertToDraft(admin, shop, rule);
}

// If a rule ends up ACTIVE in the DB but the live Shopify discount fails to
// create/update, the storefront would otherwise treat it as active (it only
// reads our DB) while no real discount exists. Revert to DRAFT so DB and
// Shopify state can never disagree, then let the error propagate.
async function syncOrRevertToDraft(admin, shop, rule) {
  try {
    const shopifyDiscountId = await syncShopifyDiscount(admin, rule);
    if (shopifyDiscountId !== rule.shopifyDiscountId) {
      await setShopifyDiscountId(shop, rule.id, shopifyDiscountId);
    }
    return rule;
  } catch (error) {
    if (rule.status === "ACTIVE") {
      await setStatus(shop, rule.id, "DRAFT");
    }
    throw error;
  }
}

/**
 * Removes ACTIVE rules whose Shopify discount no longer exists. The
 * discounts/delete webhook handles this live; this catches deletes it missed
 * (app offline, webhook not yet registered). Returns the rules still live.
 */
export async function pruneDeletedDiscounts(admin, shop, rules) {
  const linked = rules.filter((rule) => rule.status === "ACTIVE" && rule.shopifyDiscountId);
  const missing = await findMissingDiscountIds(
    admin,
    linked.map((rule) => rule.shopifyDiscountId),
  );
  for (const discountId of missing) {
    await deleteRuleByShopifyDiscountId(shop, discountId);
  }
  return rules.filter((rule) => !(rule.status === "ACTIVE" && missing.includes(rule.shopifyDiscountId)));
}

export async function removeRule(admin, shop, id) {
  const rule = await getRule(shop, id);
  await removeShopifyDiscount(admin, rule);
  await deleteRule(shop, id);
}
