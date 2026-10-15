import { authenticate } from "../shopify.server";
import {
  disableRuleByShopifyDiscountId,
  enableRuleByShopifyDiscountId,
} from "../services/promotionRules.server";

/**
 * Keeps the app in step with what a merchant does on Shopify's own discount
 * page. Shopify has no "disabled" discount status — its Deactivate button sets
 * the discount's end date to now — so a deactivated discount arrives here as
 * EXPIRED. The rule behind it has to stop being offered: otherwise the
 * storefront goes on adding a "free" gift that Shopify no longer discounts.
 * Activating the discount again re-enables the rule.
 *
 * Only the app's own database is written here, never Shopify, so the discount
 * updates the app itself makes (which fire this webhook too) can't loop.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const discountId = payload?.admin_graphql_api_id;
  const status = String(payload?.status ?? "").toUpperCase();

  // SCHEDULED is left alone on purpose: the rule keeps the dates the app knows
  // about, and the storefront already honours them, so nothing here has to
  // guess at a schedule this payload doesn't carry.
  if (discountId && (status === "EXPIRED" || status === "ACTIVE")) {
    const expired = status === "EXPIRED";
    const { count } = expired
      ? await disableRuleByShopifyDiscountId(shop, discountId)
      : await enableRuleByShopifyDiscountId(shop, discountId);
    if (count) {
      console.log(
        `${expired ? "Disabled" : "Re-enabled"} ${count} rule(s) for discount ${discountId} (status ${status})`,
      );
    }
  }

  return new Response();
};
