import { DiscountClass, ProductDiscountSelectionStrategy } from "../generated/api";

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * Config JSON shape written by app/services/shopifyDiscounts.server.js onto
 * the discount's `$app:cartpromo` / `tiered-discount-config` metafield:
 * {
 *   triggerMatch: "ANY" | "ALL",
 *   triggers: [{ kind: "PRODUCT" | "COLLECTION", id: string, minQuantity: number }],
 *   basis: "QUANTITY" | "AMOUNT",
 *   tiers: [{ threshold: number, rewardType: "PERCENTAGE" | "FIXED_AMOUNT", value: number }],
 *   exclusions: [{ kind: "PRODUCT" | "COLLECTION", id: string }],
 * }
 *
 * See free-gift-discount's run function for why trigger/excluded collections
 * are pooled into single booleans rather than resolved per-condition.
 *
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) {
    return { operations: [] };
  }
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) {
    return { operations: [] };
  }

  const config = parseConfig(input.discount.metafield?.value);
  if (!config || !config.triggers?.length || !config.tiers?.length) {
    return { operations: [] };
  }

  const productVariantLines = input.cart.lines.filter(
    (line) => line.merchandise.__typename === "ProductVariant",
  );

  if (!isTriggerSatisfied(config, productVariantLines)) {
    return { operations: [] };
  }

  const qualifyingLines = productVariantLines.filter(
    (line) => matchesAnyCondition(line, config.triggers) && !isExcluded(line, config.exclusions),
  );
  if (!qualifyingLines.length) {
    return { operations: [] };
  }

  const basisValue =
    config.basis === "AMOUNT"
      ? qualifyingLines.reduce((sum, line) => sum + Number(line.cost.subtotalAmount.amount), 0)
      : qualifyingLines.reduce((sum, line) => sum + line.quantity, 0);

  const tier = [...config.tiers]
    .sort((a, b) => a.threshold - b.threshold)
    .filter((t) => basisValue >= t.threshold)
    .pop();
  if (!tier) {
    return { operations: [] };
  }

  const targets = qualifyingLines.map((line) => ({ cartLine: { id: line.id } }));
  const value =
    tier.rewardType === "FIXED_AMOUNT"
      ? { fixedAmount: { amount: tier.value, appliesToEachItem: false } }
      : { percentage: { value: tier.value } };

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [{ message: "Tiered discount", targets, value }],
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}

function parseConfig(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function lineMatchesCondition(line, condition) {
  if (condition.kind === "PRODUCT") {
    return line.merchandise.product.id === condition.id;
  }
  return line.merchandise.product.inTriggerCollection;
}

function matchesAnyCondition(line, conditions) {
  return conditions.some((condition) => lineMatchesCondition(line, condition));
}

function isExcluded(line, exclusions) {
  if (!exclusions?.length) return false;
  return exclusions.some((exclusion) =>
    exclusion.kind === "PRODUCT"
      ? line.merchandise.product.id === exclusion.id
      : line.merchandise.product.inExcludedCollection,
  );
}

function isTriggerSatisfied(config, lines) {
  const { triggers, triggerMatch } = config;
  const conditionQuantity = (condition) =>
    lines
      .filter((line) => lineMatchesCondition(line, condition))
      .reduce((sum, line) => sum + line.quantity, 0);

  if (triggerMatch === "ALL") {
    return triggers.every((condition) => conditionQuantity(condition) >= (condition.minQuantity ?? 1));
  }
  return triggers.some((condition) => conditionQuantity(condition) >= (condition.minQuantity ?? 1));
}
