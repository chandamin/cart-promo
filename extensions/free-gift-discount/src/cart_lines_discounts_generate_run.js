import { DiscountClass, ProductDiscountSelectionStrategy } from "../generated/api";

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * Config JSON shape written by app/services/shopifyDiscounts.server.js onto
 * the discount's `$app:cartpromo` / `free-gift-config` metafield:
 * {
 *   triggerMatch: "ANY" | "ALL",
 *   triggers: [{ kind: "PRODUCT" | "COLLECTION", id: string, minQuantity: number }],
 *   giftVariantIds: string[],
 * }
 *
 * Collection membership can't be resolved per-condition inside a single static
 * input query (Product.inAnyCollection only returns one OR'd boolean across the
 * ids it's given), so all trigger collections share one pooled
 * `inTriggerCollection` boolean per line. ANY-matching pools correctly; for
 * ALL-matching, every collection condition is checked against that same pooled
 * quantity rather than its own collection specifically.
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
  if (!config || !config.giftVariantIds?.length || !config.triggers?.length) {
    return { operations: [] };
  }

  const giftLines = input.cart.lines.filter(
    (line) =>
      line.merchandise.__typename === "ProductVariant" &&
      config.giftVariantIds.includes(line.merchandise.id),
  );
  if (!giftLines.length) {
    return { operations: [] };
  }

  const giftLineIds = new Set(giftLines.map((line) => line.id));
  const otherLines = input.cart.lines.filter((line) => !giftLineIds.has(line.id));

  if (!isTriggerSatisfied(config, otherLines)) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message: "Free gift",
              targets: giftLines.map((line) => ({ cartLine: { id: line.id } })),
              value: { percentage: { value: 100 } },
            },
          ],
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
  if (line.merchandise.__typename !== "ProductVariant") return false;
  if (condition.kind === "PRODUCT") {
    return line.merchandise.product.id === condition.id;
  }
  return line.merchandise.product.inTriggerCollection;
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
