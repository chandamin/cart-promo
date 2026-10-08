import { authenticate } from "../shopify.server";
import { listRules } from "../services/promotionRules.server";
import { editPath } from "../utils/promotionPaths";

/**
 * Target of the discount Functions' `ui.paths.details`: Shopify admin >
 * Discounts sends merchants here when they click one of our discounts.
 * `:id` is the discount's id (gid or numeric); redirect to its promotion.
 */
export const loader = async ({ request, params }) => {
  const { session, redirect } = await authenticate.admin(request);
  const raw = decodeURIComponent(params.id ?? "");
  const numericId = raw.split("/").pop();

  const rules = await listRules(session.shop);
  const rule = rules.find(
    (r) => r.shopifyDiscountId && (r.shopifyDiscountId === raw || r.shopifyDiscountId.split("/").pop() === numericId),
  );

  return redirect(rule ? editPath(rule) : "/app/promotions");
};
