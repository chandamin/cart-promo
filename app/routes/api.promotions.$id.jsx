import { adminForShop, authenticateApi, resolveShops } from "../services/masterApi.server";
import { getRule } from "../services/promotionRules.server";
import { handleApiRequest, jsonError, readJsonObject, serializeRule } from "../services/promotionsApi.server";
import { deletePromotion, updatePromotion } from "../services/promotionsOps.server";

/**
 * One promotion. A per-shop key reaches its own shop's promotions; the master
 * key must also say which single shop the id belongs to: ?shop=<store>.myshopify.com
 * (to change many shops at once use the PATCH/DELETE on /api/promotions instead).
 *
 *   GET    /api/promotions/:id   read
 *   PATCH  /api/promotions/:id   update (PUT works too); send only the fields to change
 *   DELETE /api/promotions/:id   delete the promotion and its Shopify discount
 *
 * OPTIONS is answered as a CORS preflight by handleApiRequest.
 */

/** { shop, admin } for the request: the key's own shop, or the one a master call names. */
async function targetShop(request) {
  const auth = await authenticateApi(request);
  if (!auth.master) return auth;

  // Judged on what was asked for, not on how many shops it resolved to: "all"
  // happens to be one shop on a single-store install, and must not behave
  // differently there than on any other.
  const selector = new URL(request.url).searchParams.get("shop") ?? "";
  if (/^\s*(all|\*)\s*$/i.test(selector) || selector.includes(",")) {
    throw jsonError(400, "A single promotion belongs to one store: use shop=<store>.myshopify.com.");
  }
  const [shop] = await resolveShops(selector);
  return { shop, admin: await adminForShop(shop) };
}

export const loader = ({ request, params }) =>
  handleApiRequest(request, async () => {
    const { shop } = await targetShop(request);
    return Response.json({ promotion: serializeRule(await getRule(shop, params.id)) });
  });

export const action = ({ request, params }) =>
  handleApiRequest(request, async () => {
    if (!["DELETE", "PATCH", "PUT"].includes(request.method)) {
      return jsonError(405, "Method not allowed. Use GET, PATCH, PUT or DELETE.");
    }
    const { shop, admin } = await targetShop(request);

    if (request.method === "DELETE") {
      return Response.json(await deletePromotion(admin, shop, params.id));
    }
    return Response.json(await updatePromotion(admin, shop, params.id, await readJsonObject(request)));
  });
