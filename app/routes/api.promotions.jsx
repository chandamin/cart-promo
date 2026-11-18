import { adminForShop, authenticateApi, resolveShops, runAcrossShops } from "../services/masterApi.server";
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
 *   POST | PATCH | PUT /api/promotions with an `id` (in the body, or ?id=) edits that
 *     promotion instead: the same fields as create, send only the ones to change.
 *     The master key must also name the one store it belongs to (?shop= or `shop`).
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

/** Edits the one promotion `id` names, with the same fields create takes. */
async function editOne(auth, url, body, id) {
  if (!auth.master) return Response.json(await updatePromotion(auth.admin, auth.shop, id, body));

  const selector = url.searchParams.get("shop") ?? body.shop ?? "";
  if (typeof selector !== "string" || !selector || /^\s*(all|\*)\s*$/i.test(selector) || selector.includes(",")) {
    throw jsonError(400, "A single promotion belongs to one store: use shop=<store>.myshopify.com.");
  }
  const [shop] = await resolveShops(selector);
  return Response.json(await updatePromotion(await adminForShop(shop), shop, id, body));
}

export const action = ({ request }) =>
  handleApiRequest(request, async () => {
    const auth = await authenticateApi(request);
    const url = new URL(request.url);

    // The body is read once: an `id` in it (or ?id=) turns a write into an edit of that promotion.
    let body = null;
    if (["POST", "PATCH", "PUT"].includes(request.method)) {
      body = await readJsonObject(request);
      const id = url.searchParams.get("id") ?? body.id;
      if (id) return editOne(auth, url, body, String(id));
    }

    if (request.method === "POST") {
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
      const patch = request.method === "DELETE" ? null : body;

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
        : "Method not allowed. Use GET or POST here (POST/PATCH with an `id` edits), or PATCH/DELETE on /api/promotions/:id.",
    );
  });
