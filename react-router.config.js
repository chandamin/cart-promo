// Shopify embedded apps run inside an iframe served through the CLI's tunnel
// (and, in dev, its local proxy), which can make the `Origin` header on
// action requests look cross-origin relative to what the server sees as
// `request.url`. Without this, React Router's single-fetch CSRF check
// rejects every action POST with a generic "Bad Request" before our route
// code ever runs. Mirrors the same SHOPIFY_APP_URL host vite.config.js uses
// for `server.allowedHosts`.
function allowedActionOrigins() {
  try {
    return [new URL(process.env.SHOPIFY_APP_URL).hostname];
  } catch {
    return [];
  }
}

export default {
  allowedActionOrigins: allowedActionOrigins(),
};
