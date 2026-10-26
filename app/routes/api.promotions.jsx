import { authenticateApi, resolveShops, runAcrossShops } from "../services/masterApi.server";
import { handleApiRequest, jsonError, readJsonObject, serializeRule } from "../services/promotionsApi.server";
import {
  applyToMatching,
  createPromotion,
  deletePromotion,
  findRules,
  updatePromotion,
} from "../services/promotionsOps.server";

/**
 * Per-shop key (Authorization: Bearer cp_…) — acts on that key's own shop:
 *   GET  /api/promotions   list, optional ?type=&status=
 *   POST /api/promotions   create (`type`, `name` and `config` are required)
 *
 * Master key (Authorization: Bearer <API_MASTER_KEY>) — acts on many shops in
 * one call. Say which with ?shop=all or ?shop=a.myshopify.com,b.myshopify.com
 * (for POST it may also be a `shop` field in the body); there is no default.
 *   GET    list across the shops        (?name= ?code= ?type= ?status= narrow it)
 *   POST   create in every shop
 *   PATCH  update every promotion matching ?name= or ?code=; body = fields to change
 *   DELETE delete every promotion matching ?name= or ?code=
 * PATCH and DELETE take ?dryRun=true to list what they would touch without
 * changing anything. The answer has one entry per shop, so a failure in one
 * shop is visible and does not stop the others.
 *
 * OPTIONS is answered as a CORS preflight by handleApiRequest.
 */

function filtersFrom(url) {
  const param = (name) => url.searchParams.get(name) || undefined;
  return { type: param("type"), status: param("status"), name: param("name"), code: param("code") };
}

export const loader = ({ request }) =>
  handleApiRequest(request, async () => {
    const auth = await authenticateApi(request);
    const url = new URL(request.url);
    const filters = filtersFrom(url);

    if (auth.master) {
      const shops = await resolveShops(url.searchParams.get("shop"));
      return Response.json(
        await runAcrossShops(shops, async ({ shop, admin }) => ({
          promotions: (await findRules(admin, shop, filters)).map(serializeRule),
        })),
      );
    }

    const rules = await findRules(auth.admin, auth.shop, filters);
    return Response.json({ promotions: rules.map(serializeRule) });
  });

export const action = ({ request }) =>
  handleApiRequest(request, async () => {
    const auth = await authenticateApi(request);
    const url = new URL(request.url);

    if (request.method === "POST") {
      const body = await readJsonObject(request);
      if (auth.master) {
        const shops = await resolveShops(url.searchParams.get("shop") ?? body.shop ?? body.shops);
        const result = await runAcrossShops(shops, ({ shop, admin }) => createPromotion(admin, shop, body));
        return Response.json(result, { status: result.succeeded ? 201 : 400 });
      }
      return Response.json(await createPromotion(auth.admin, auth.shop, body), { status: 201 });
    }

    const bulk = request.method === "PATCH" || request.method === "PUT" || request.method === "DELETE";
    if (bulk && auth.master) {
      const filters = filtersFrom(url);
      // Matching by name or code is what keeps a bulk change deliberate: without
      // one of them "update/delete the promotions" would mean all of them.
      if (!filters.name && !filters.code) {
        return jsonError(400, "Say which promotions to change: ?name=<exact name> or ?code=<discount code>.");
      }
      const dryRun = url.searchParams.get("dryRun") === "true";
      const shops = await resolveShops(url.searchParams.get("shop"));
      const patch = request.method === "DELETE" ? null : await readJsonObject(request);

      return Response.json(
        await runAcrossShops(shops, ({ shop, admin }) =>
          applyToMatching(admin, shop, filters, {
            dryRun,
            apply: (rule) =>
              patch ? updatePromotion(admin, shop, rule.id, patch) : deletePromotion(admin, shop, rule.id),
          }),
        ),
      );
    }

    return jsonError(
      405,
      auth.master
        ? "Method not allowed. Use GET, POST, PATCH, PUT or DELETE."
        : "Method not allowed. Use GET or POST here, or PATCH/DELETE on /api/promotions/:id.",
    );
  });
