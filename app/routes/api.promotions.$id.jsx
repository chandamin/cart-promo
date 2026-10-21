import { getRule } from "../services/promotionRules.server";
import { removeRule, saveRule } from "../services/promotions.server";
import {
  authenticateApiRequest,
  handleApiRequest,
  jsonError,
  mergeRuleUpdate,
  readJsonObject,
  serializeRule,
} from "../services/promotionsApi.server";

/**
 * GET /api/promotions/:id — one promotion. OPTIONS is answered here as a CORS
 * preflight (see handleApiRequest).
 */
export const loader = ({ request, params }) =>
  handleApiRequest(request, async () => {
    const { shop } = await authenticateApiRequest(request);
    return Response.json({ promotion: serializeRule(await getRule(shop, params.id)) });
  });

/**
 * PATCH (or PUT) /api/promotions/:id — update; send only the fields to change.
 * DELETE /api/promotions/:id — delete the promotion and its Shopify discount.
 */
export const action = ({ request, params }) =>
  handleApiRequest(request, async () => {
    const { shop, admin } = await authenticateApiRequest(request);

    if (request.method === "DELETE") {
      await removeRule(admin, shop, params.id);
      return Response.json({ deleted: true, id: params.id });
    }

    if (request.method === "PATCH" || request.method === "PUT") {
      const patch = await readJsonObject(request);
      const existing = await getRule(shop, params.id);
      await saveRule(admin, shop, params.id, mergeRuleUpdate(existing, patch));
      // Re-read: saving may revert to DRAFT or change the Shopify discount id.
      return Response.json({ promotion: serializeRule(await getRule(shop, params.id)) });
    }

    return jsonError(405, "Method not allowed. Use GET, PATCH, PUT or DELETE.");
  });
