import { authenticate } from "../shopify.server";
import { evaluateGiftRules } from "../services/giftEligibility.server";

/**
 * Storefront-facing endpoint (via Shopify app proxy, /apps/cartpromo/gift-rules)
 * used by the theme app embed and checkout extension to decide which gift(s)
 * currently qualify for the cart, so they can add/remove the gift line(s).
 *
 * Expects `?lines=<json>` where json is [{ productId, variantId, quantity }],
 * and optionally `?codes=<json>` where json is a string[] of discount codes
 * currently applied to the cart/checkout.
 */
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) {
    return Response.json({ qualifying: [], giftVariantIds: [] });
  }

  const url = new URL(request.url);
  const cartLines = safeParse(url.searchParams.get("lines"), []);
  const appliedCodes = safeParse(url.searchParams.get("codes"), []);
  // Storefront: Shopify adds the signed `logged_in_customer_id` to proxy
  // requests. Checkout can't send cookies, so the extension passes the id.
  const customerId = toCustomerGid(
    url.searchParams.get("logged_in_customer_id") || url.searchParams.get("customer_id"),
  );

  const result = await evaluateGiftRules(admin, session.shop, cartLines, appliedCodes, customerId);
  return Response.json(result);
};

function toCustomerGid(raw) {
  if (!raw) return null;
  return raw.startsWith("gid://") ? raw : `gid://shopify/Customer/${raw}`;
}

function safeParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
