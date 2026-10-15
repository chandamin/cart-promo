/**
 * Orchestrates promotionRules.server.js (DB CRUD) and shopifyDiscounts.server.js
 * (live Shopify discount) together. Both the admin UI actions and the public
 * API routes (api.promotions.*) go through this module rather than calling either
 * service directly, so activation/deactivation behavior stays in one place.
 */
import {
  createRule,
  updateRule,
  deleteRule,
  deleteRuleByShopifyDiscountId,
  disableRuleByShopifyDiscountId,
  findRule,
  setStatus,
  setShopifyDiscountId,
} from "./promotionRules.server";
import { fetchDiscountStates, syncShopifyDiscount, removeShopifyDiscount } from "./shopifyDiscounts.server";

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
