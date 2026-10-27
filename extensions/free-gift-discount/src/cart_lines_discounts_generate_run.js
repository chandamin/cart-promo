import { DiscountClass, ProductDiscountSelectionStrategy } from "../generated/api";

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

const PLACEHOLDER_PERCENTAGE = 0.01;

/**
 * Config JSON shape written by app/services/shopifyDiscounts.server.js onto
 * the discount's `$app:cartpromo` / `free-gift-config` metafield:
 * {
 *   ruleId: string, // the CartPromo rule id; gift lines carry it in `_cartpromo_rule`
 *   triggerMatch: "ANY" | "ALL",
 *   triggers: [{ kind: "PRODUCT" | "COLLECTION", id: string, minQuantity: number }],
 *   giftVariantIds: string[],
 *   minRequirement: { type: "AMOUNT" | "QUANTITY", value: number } | null,
 *   label: string, // shown on the cart/checkout line
 * }
 * `triggers` may be empty when `minRequirement` alone decides eligibility.
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
  if (!config || !config.giftVariantIds?.length || (!config.triggers?.length && !config.minRequirement)) {
    return { operations: [] };
  }

  // A gift line is a line of one of this rule's gift variants that carries THIS
  // rule's id in the `_cartpromo_rule` line property. The same variant bought
  // normally (no property), or tagged for another rule, is a paid product.
  const giftLines = input.cart.lines.filter(
    (line) =>
      line.merchandise.__typename === "ProductVariant" &&
      config.giftVariantIds.includes(line.merchandise.id) &&
      isTaggedForRule(line, config.ruleId),
  );

  // Gift lines (this rule's, or any other CartPromo gift) never count toward
  // the conditions: a free product must not unlock its own reward.
  const giftLineIds = new Set(giftLines.map((line) => line.id));
  const otherLines = input.cart.lines.filter((line) => !giftLineIds.has(line.id) && !line.giftRule);

  if (!isTriggerSatisfied(config, otherLines) || !meetsMinRequirement(config.minRequirement, otherLines)) {
    return { operations: [] };
  }

  // The cart qualifies but the gift isn't in it yet: nothing to discount.
  // Do NOT return `enteredDiscountCodesAccept` here. For a code discount the
  // triggering code is already implicitly accepted, and returning the accept
  // operation makes Shopify reject the output (InvalidOutputError).
  // A code that discounts nothing is rejected by checkout, so the gift could
  // never be added by the code that unlocks it. While a code is entered, give a
  // token discount (PLACEHOLDER_PERCENTAGE) on a qualifying line so the code is
  // accepted; the checkout extension then adds the gift, which turns 100% free.
  if (!giftLines.length) {
    const [target] = otherLines;
    if (!input.enteredDiscountCodes?.length || !target) return { operations: [] };
    return {
      operations: [
        {
          productDiscountsAdd: {
            candidates: [
              {
                message: config.label || "Free gift",
                targets: [{ cartLine: { id: target.id } }],
                value: { percentage: { value: PLACEHOLDER_PERCENTAGE } },
              },
            ],
            selectionStrategy: ProductDiscountSelectionStrategy.First,
          },
        },
      ],
    };
  }

  // One unit of one gift per rule, however many gift lines or units the cart
  // holds: the first tagged line (cart order) gets exactly one unit free.
  const [giftLine] = giftLines;
  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message: config.label || "Free gift",
              targets: [{ cartLine: { id: giftLine.id, quantity: 1 } }],
              value: { percentage: { value: 100 } },
            },
          ],
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}

// Discounts configs saved before `ruleId` existed have none to compare with:
// for those, any tagged line counts until the rule is saved again.
function isTaggedForRule(line, ruleId) {
  const tag = line.giftRule?.value;
  if (!tag) return false;
  return ruleId ? tag === ruleId : true;
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

// Minimum purchase requirement over the (non-gift) cart: subtotal before
// discounts, or total item quantity.
function meetsMinRequirement(minRequirement, lines) {
  if (!minRequirement) return true;
  if (minRequirement.type === "AMOUNT") {
    const subtotal = lines.reduce((sum, line) => sum + Number(line.cost.subtotalAmount.amount), 0);
    return subtotal >= minRequirement.value;
  }
  if (minRequirement.type === "QUANTITY") {
    return lines.reduce((sum, line) => sum + line.quantity, 0) >= minRequirement.value;
  }
  return true;
}

function isTriggerSatisfied(config, lines) {
  const { triggers, triggerMatch } = config;
  // No cart conditions: the minimum purchase requirement alone decides.
  if (!triggers?.length) return true;
  const conditionQuantity = (condition) =>
    lines
      .filter((line) => lineMatchesCondition(line, condition))
      .reduce((sum, line) => sum + line.quantity, 0);

  if (triggerMatch === "ALL") {
    return triggers.every((condition) => conditionQuantity(condition) >= (condition.minQuantity ?? 1));
  }
  return triggers.some((condition) => conditionQuantity(condition) >= (condition.minQuantity ?? 1));
}