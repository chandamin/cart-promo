import { createHash, timingSafeEqual } from "node:crypto";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  authenticateApiRequest,
  bearerKey,
  describeError,
  jsonError,
} from "./promotionsApi.server";

/**
 * The master key: one credential (API_MASTER_KEY in the server environment)
 * that acts on every store the app is installed on, so a single call can
 * create, update or delete promotions across all of them. A per-shop key keeps
 * working exactly as before and can only ever touch its own shop.
 *
 * The master key is never stored in the database or shown in the app: it exists
 * only as an environment variable, so rotating it is a redeploy. It must be at
 * least 32 characters; a shorter value is ignored, which turns the master key off.
 */

const MIN_MASTER_KEY_LENGTH = 32;
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
// Shops handled at once. Each shop costs several Shopify API calls, and
// running them all together would hit Shopify's rate limits on a big install base.
const CONCURRENCY = 4;

function digest(value) {
  return createHash("sha256").update(value).digest();
}

export function isMasterKey(key) {
  const master = process.env.API_MASTER_KEY ?? "";
  if (!key || master.length < MIN_MASTER_KEY_LENGTH) return false;
  // Compared as fixed-length hashes, in constant time, so the check leaks
  // neither the key nor its length through timing.
  return timingSafeEqual(digest(key), digest(master));
}

/** { master: true }, or { master: false, shop, admin } for a per-shop key. Throws a 401/403 Response. */
export async function authenticateApi(request) {
  if (isMasterKey(bearerKey(request))) return { master: true };
  return { master: false, ...(await authenticateApiRequest(request)) };
}

/** Every shop the app is installed on (those with an offline session). */
async function installedShops() {
  const sessions = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  return sessions.map((session) => session.shop.toLowerCase());
}

/**
 * Which shops a master call acts on: "all", or one or more
 * <store>.myshopify.com domains (comma-separated or as a list). It has to be
 * said every time — there is deliberately no default, so a forgotten parameter
 * can never turn a delete into "delete everywhere".
 */
export async function resolveShops(selector) {
  const wanted = (Array.isArray(selector) ? selector : String(selector ?? "").split(","))
    .map((shop) => String(shop).trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) {
    throw jsonError(
      400,
      "Say which stores to act on: shop=all, or shop=<store>.myshopify.com (several separated by commas).",
    );
  }

  const installed = await installedShops();
  if (wanted.includes("all") || wanted.includes("*")) {
    if (!installed.length) throw jsonError(404, "The app is not installed on any store.");
    return installed;
  }

  const invalid = wanted.filter((shop) => !SHOP_DOMAIN.test(shop));
  if (invalid.length) throw jsonError(400, `Not a <store>.myshopify.com domain: ${invalid.join(", ")}`);
  const unknown = wanted.filter((shop) => !installed.includes(shop));
  if (unknown.length) throw jsonError(404, `The app is not installed on: ${unknown.join(", ")}`);
  return [...new Set(wanted)];
}

/** The Admin API client of one shop, or a 403 Response if its session can't be used. */
export async function adminForShop(shop) {
  try {
    return (await unauthenticated.admin(shop)).admin;
  } catch {
    throw jsonError(403, "Could not access this shop. Open the app in Shopify admin and try again.");
  }
}

/**
 * Runs `task({ shop, admin })` for each shop and reports every shop's outcome:
 * one shop failing (not installed any more, expired token, a validation error)
 * never stops the others.
 */
export async function runAcrossShops(shops, task) {
  const results = new Array(shops.length);

  async function runOne(index) {
    const shop = shops[index];
    try {
      const admin = await adminForShop(shop);
      results[index] = { shop, ok: true, ...(await task({ shop, admin })) };
    } catch (error) {
      results[index] = { shop, ok: false, ...(await describeError(error)) };
    }
  }

  for (let start = 0; start < shops.length; start += CONCURRENCY) {
    const batch = shops.slice(start, start + CONCURRENCY).map((_, offset) => runOne(start + offset));
    await Promise.all(batch);
  }

  const succeeded = results.filter((result) => result.ok).length;
  return { stores: shops.length, succeeded, failed: shops.length - succeeded, results };
}
