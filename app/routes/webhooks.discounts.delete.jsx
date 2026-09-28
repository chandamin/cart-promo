import { authenticate } from "../shopify.server";
import { deleteRuleByShopifyDiscountId } from "../services/promotionRules.server";

// A discount deleted in Shopify admin also removes its rule from the app.
// Deletes made by the app itself arrive here too; by then the rule is already
// gone (or no longer ACTIVE), so this is a no-op for them.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const discountId = payload?.admin_graphql_api_id;
  if (discountId) {
    const { count } = await deleteRuleByShopifyDiscountId(shop, discountId);
    if (count) console.log(`Removed ${count} rule(s) for deleted discount ${discountId}`);
  }

  return new Response();
};
