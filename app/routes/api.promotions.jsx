import { getRule, listRules } from "../services/promotionRules.server";
import { reconcileWithShopify, saveRule } from "../services/promotions.server";
import {
  authenticateApiRequest,
  buildCreateInput,
  errorResponse,
  jsonError,
  readJsonObject,
  serializeRule,
} from "../services/promotionsApi.server";

/**
 * GET /api/promotions — all promotions of the shop owning the API key.
 * Optional filters: ?type=FREE_GIFT|TIERED_DISCOUNT&status=ACTIVE|DRAFT|DISABLED
 */
export const loader = async ({ request }) => {
  try {
    const { shop, admin } = await authenticateApiRequest(request);
    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    const status = url.searchParams.get("status");

    const rules = (await reconcileWithShopify(admin, shop, await listRules(shop))).filter(
      (rule) => (!type || rule.type === type) && (!status || rule.status === status),
    );
    return Response.json({ promotions: rules.map(serializeRule) });
  } catch (error) {
    return errorResponse(error);
  }
};

/**
 * POST /api/promotions — create a promotion (and its Shopify discount when
 * status is ACTIVE). Body: same fields as GET returns; `type`, `name` and
 * `config` are required.
 */
export const action = async ({ request }) => {
  if (request.method !== "POST") return jsonError(405, "Method not allowed. Use GET or POST.");
  try {
    const { shop, admin } = await authenticateApiRequest(request);
    const body = await readJsonObject(request);
    const created = await saveRule(admin, shop, "new", buildCreateInput(body));
    // Re-read: saving sets the Shopify discount id (or reverts to DRAFT on failure).
    return Response.json({ promotion: serializeRule(await getRule(shop, created.id)) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
};
