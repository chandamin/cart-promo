import { getRule, listRules } from "./promotionRules.server";
import { reconcileWithShopify, removeRule, saveRule } from "./promotions.server";
import {
  buildCreateInput,
  describeError,
  mergeRuleUpdate,
  serializeRule,
} from "./promotionsApi.server";

/**
 * What the promotions API does to one shop, shared by the per-shop key routes
 * and the master key (which runs the same operations across many shops), so
 * both go through the same validation and Shopify sync.
 */

const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** Rules of the shop matching the optional filters; name and code match exactly, ignoring case. */
export async function findRules(admin, shop, { type, status, name, code } = {}) {
  const rules = await reconcileWithShopify(admin, shop, await listRules(shop));
  return rules.filter(
    (rule) =>
      (!type || rule.type === type) &&
      (!status || rule.status === status) &&
      (!name || same(rule.name, name)) &&
      (!code || same(rule.code, code)),
  );
}

export async function createPromotion(admin, shop, body) {
  const created = await saveRule(admin, shop, "new", buildCreateInput(body));
  // Re-read: saving sets the Shopify discount id (or reverts to DRAFT on failure).
  return { promotion: serializeRule(await getRule(shop, created.id)) };
}

export async function updatePromotion(admin, shop, id, patch) {
  const existing = await getRule(shop, id);
  await saveRule(admin, shop, id, mergeRuleUpdate(existing, patch));
  // Re-read: saving may revert to DRAFT or change the Shopify discount id.
  return { promotion: serializeRule(await getRule(shop, id)) };
}

export async function deletePromotion(admin, shop, id) {
  await removeRule(admin, shop, id);
  return { deleted: true, id };
}

/**
 * Runs `apply(rule)` on every rule of the shop matching `filters`. One rule
 * failing is reported and does not stop the rest. With `dryRun` nothing is
 * changed: the rules that would be touched are only listed.
 */
export async function applyToMatching(admin, shop, filters, { dryRun = false, apply }) {
  const rules = await findRules(admin, shop, filters);
  const result = { matched: rules.length, promotions: [], errors: [] };
  for (const rule of rules) {
    if (dryRun) {
      result.promotions.push({ id: rule.id, name: rule.name, status: rule.status });
      continue;
    }
    try {
      const outcome = await apply(rule);
      // An update returns the promotion; a delete has nothing left to return.
      result.promotions.push(outcome.promotion ?? { id: rule.id, name: rule.name, deleted: true });
    } catch (error) {
      result.errors.push({ id: rule.id, name: rule.name, ...(await describeError(error)) });
    }
  }
  return { ok: result.errors.length === 0, ...result };
}
