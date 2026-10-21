import { unauthenticated } from "../shopify.server";
import { preflightResponse, withApiHeaders } from "../utils/apiCors.server";
import { findShopByApiKey } from "./apiKeys.server";
import {
  DISCOUNT_METHODS,
  RULE_STATUSES,
  RULE_TYPES,
  TRIGGER_MATCHES,
} from "./promotionRules.server";

/**
 * Shared plumbing for the external promotions API (/api/promotions...).
 * Requests authenticate with the shop's API key (Authorization: Bearer cp_...)
 * and act through the shop's offline Admin API session, going through the same
 * services as the admin UI so Shopify discounts stay in sync.
 */

export function jsonError(status, message) {
  return Response.json({ error: message }, { status });
}

/**
 * Runs an API route handler: answers CORS preflights, turns anything thrown
 * (including the Responses thrown below) into a JSON error, and tags every
 * response with the headers a browser client needs to read it — and that keep
 * it out of any shared cache.
 */
export async function handleApiRequest(request, handler) {
  if (request.method === "OPTIONS") {
    return preflightResponse(request);
  }
  let response;
  try {
    response = await handler();
  } catch (error) {
    response = errorResponse(error);
  }
  return withApiHeaders(request, response);
}

/** Returns { shop, admin }, or throws a 401/403 JSON Response. */
export async function authenticateApiRequest(request) {
  const header = request.headers.get("Authorization") || "";
  const key = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  const shop = await findShopByApiKey(key);
  if (!shop) {
    throw jsonError(401, "Missing or invalid API key. Send it as: Authorization: Bearer <key>");
  }
  try {
    const { admin } = await unauthenticated.admin(shop);
    return { shop, admin };
  } catch {
    // No usable offline session: the app was uninstalled, or its access token
    // expired and could not be refreshed. Either way the merchant has to open
    // the app again before this key works.
    throw jsonError(403, "Could not access this shop. Open the app in Shopify admin and try again.");
  }
}

/** Public representation of a rule. */
export function serializeRule(rule) {
  return {
    id: rule.id,
    type: rule.type,
    name: rule.name,
    status: rule.status,
    discountMethod: rule.discountMethod,
    code: rule.code,
    cartLabel: rule.cartLabel,
    combinesWith: rule.combinesWith,
    startsAt: rule.startsAt,
    endsAt: rule.endsAt,
    triggers: rule.triggers,
    triggerMatch: rule.triggerMatch,
    minRequirement: rule.minRequirement,
    eligibility: rule.eligibility,
    usageLimit: rule.usageLimit,
    oncePerCustomer: rule.oncePerCustomer,
    tags: rule.tags ?? [],
    config: rule.config,
    shopifyDiscountId: rule.shopifyDiscountId,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

// Fields a client may change. `type` is fixed once a rule exists.
const UPDATABLE_FIELDS = [
  "name",
  "status",
  "discountMethod",
  "code",
  "cartLabel",
  "combinesWith",
  "startsAt",
  "endsAt",
  "triggers",
  "triggerMatch",
  "minRequirement",
  "eligibility",
  "usageLimit",
  "oncePerCustomer",
  "tags",
  "config",
];

// The admin forms can only submit valid values for these fields, so the shared
// validator doesn't check them all; an API client can send anything, and e.g. an
// unrecognised status would be stored as-is and never match on the storefront.
const ENUM_FIELDS = {
  type: RULE_TYPES,
  status: RULE_STATUSES,
  discountMethod: DISCOUNT_METHODS,
  triggerMatch: TRIGGER_MATCHES,
};

function validateEnumFields(input) {
  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    const value = input[field];
    if (value != null && !allowed.includes(value)) {
      throw jsonError(400, `Invalid ${field}: ${JSON.stringify(value)}. Allowed values: ${allowed.join(", ")}.`);
    }
  }
}

// Tier numbers may arrive as strings ("10"); store them as numbers, as the admin form does.
function normalizeConfig(config) {
  if (!config || !Array.isArray(config.tiers)) return config;
  return {
    ...config,
    tiers: config.tiers.map((t) => ({ threshold: Number(t.threshold), rewardType: t.rewardType, value: Number(t.value) })),
  };
}

/** Parses the request body as a JSON object, or throws a 400 JSON Response. */
export async function readJsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw jsonError(400, "Request body must be JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw jsonError(400, "Request body must be a JSON object.");
  }
  return body;
}

/** Applies a partial update onto an existing rule, producing a full rule input. */
export function mergeRuleUpdate(existing, patch) {
  const input = Object.fromEntries(UPDATABLE_FIELDS.map((field) => [field, existing[field]]));
  input.type = existing.type;
  for (const field of UPDATABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) input[field] = patch[field];
  }
  input.config = normalizeConfig(input.config);
  validateEnumFields(input);
  return input;
}

/** Rule input for a new promotion, with the same defaults as the admin forms. */
export function buildCreateInput(body) {
  const input = Object.fromEntries(
    UPDATABLE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field)).map((field) => [
      field,
      body[field],
    ]),
  );
  const created = {
    status: "DRAFT",
    discountMethod: "AUTOMATIC",
    triggers: [],
    triggerMatch: "ANY",
    ...input,
    type: body.type,
    config: normalizeConfig(body.config ?? {}),
  };
  validateEnumFields(created);
  return created;
}

/** Maps a service error to an API response. */
export function errorResponse(error) {
  if (error instanceof Response) return error;
  const message = error?.message ?? String(error);
  if (/not found/i.test(message)) return jsonError(404, message);
  return jsonError(400, message);
}
