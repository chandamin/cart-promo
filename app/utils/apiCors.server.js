/**
 * CORS for the public promotions API (/api/promotions...).
 *
 * The API is called from browsers as well as from servers: the Swagger docs app
 * runs on a different host, so the browser first sends a preflight OPTIONS
 * request for any call carrying an Authorization header. A preflight has no API
 * key to check, so answering it from the key check gives a 401 with no
 * Access-Control-* headers, and the browser blocks the real request — the
 * caller only ever sees "Failed to fetch", while the same call works in curl.
 *
 * Allowed origins come from API_CORS_ORIGINS (comma-separated), defaulting to
 * the docs app. "*" allows any origin, which is acceptable here only because
 * this API authenticates with a bearer key and never with cookies.
 */

const DEFAULT_ORIGINS = ["https://phpstack-1272348-6107766.cloudwaysapps.com"];

const ALLOW_HEADERS = "Authorization, Content-Type";
const ALLOW_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";

function normalize(origin) {
  return origin.trim().replace(/\/$/, "");
}

export function apiCorsOrigins() {
  const configured = (process.env.API_CORS_ORIGINS ?? "").split(",").map(normalize).filter(Boolean);
  return configured.length ? configured : DEFAULT_ORIGINS;
}

/** The CORS headers for this request, or {} for a caller we don't allow (or a non-browser one). */
export function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  // curl and server-to-server callers send no Origin and need no CORS headers.
  if (!origin) return {};

  const allowed = apiCorsOrigins();
  const wildcard = allowed.includes("*");
  if (!wildcard && !allowed.includes(normalize(origin))) return {};

  return {
    "Access-Control-Allow-Origin": wildcard ? "*" : origin,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * Headers every response on these routes carries.
 *
 * `no-store` matters in production: the host's cache (Varnish on Cloudways) was
 * caching a keyless GET and serving that copy — sent before these CORS headers
 * existed — to later callers. An API answering per API key must never be cached
 * by a shared proxy, or one shop could be handed another shop's response.
 */
export function apiHeaders(request) {
  return { "Cache-Control": "no-store", ...corsHeaders(request) };
}

/** The same response, carrying the API headers. */
export function withApiHeaders(request, response) {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(apiHeaders(request))) {
    merged.set(name, value);
  }
  // Always, and appended rather than set: what these routes answer depends on
  // the Origin, and the response may already vary on something else.
  merged.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

/** Preflight answer. Deliberately before any key check: a preflight carries no key. */
export function preflightResponse(request) {
  return new Response(null, { status: 204, headers: { ...apiHeaders(request), Vary: "Origin" } });
}
