import { describe, expect, it } from "vitest";
import { cartLinesDiscountsGenerateRun } from "./cart_lines_discounts_generate_run";

const SNOWBOARD = "gid://shopify/Product/1";
const GIFT_VARIANT = "gid://shopify/ProductVariant/900";

function line(id, { productId, variantId, quantity = 1, amount = 100, giftRule = null }) {
  return {
    id,
    quantity,
    giftRule: giftRule ? { value: giftRule } : null,
    cost: { subtotalAmount: { amount: String(amount) } },
    merchandise: {
      __typename: "ProductVariant",
      id: variantId,
      product: { id: productId, inTriggerCollection: false },
    },
  };
}

const snowboard = line("l1", { productId: SNOWBOARD, variantId: "gid://shopify/ProductVariant/10", amount: 600 });
const giftInCart = line("l2", { productId: "gid://shopify/Product/9", variantId: GIFT_VARIANT, giftRule: "rule1" });

function run({ lines, entered = [], config = {} }) {
  return cartLinesDiscountsGenerateRun({
    cart: { lines },
    enteredDiscountCodes: entered.map((code) => ({ code, rejectable: true })),
    discount: {
      discountClasses: ["PRODUCT"],
      metafield: {
        value: JSON.stringify({
          triggerMatch: "ANY",
          triggers: [{ kind: "PRODUCT", id: SNOWBOARD, minQuantity: 1 }],
          giftVariantIds: [GIFT_VARIANT],
          minRequirement: null,
          label: "My gift",
          code: "TEST",
          ...config,
        }),
      },
    },
  });
}

describe("free gift discount", () => {
  it("makes the gift free once it is in the cart", () => {
    const { operations } = run({ lines: [snowboard, giftInCart], entered: ["TEST"] });
    expect(operations).toHaveLength(1);
    const candidate = operations[0].productDiscountsAdd.candidates[0];
    expect(candidate.value).toEqual({ percentage: { value: 100 } });
    expect(candidate.targets).toEqual([{ cartLine: { id: "l2", quantity: 1 } }]);
  });

  describe("code entered before the gift is in the cart", () => {
    it("gives a token discount so checkout accepts the code (never enteredDiscountCodesAccept, which is invalid output)", () => {
      const { operations } = run({ lines: [snowboard], entered: ["TEST"] });
      expect(operations).toHaveLength(1);
      const candidate = operations[0].productDiscountsAdd.candidates[0];
      expect(candidate.value).toEqual({ percentage: { value: 0.01 } });
      expect(candidate.targets).toEqual([{ cartLine: { id: "l1" } }]);
    });

    it("does nothing when no code was entered", () => {
      expect(run({ lines: [snowboard], entered: [] }).operations).toEqual([]);
    });

    it("does not count the gift itself towards the conditions", () => {
      const trigger = { kind: "PRODUCT", id: "gid://shopify/Product/9", minQuantity: 1 };
      const noOtherQualifier = run({ lines: [giftInCart], entered: ["TEST"], config: { triggers: [trigger] } });
      expect(noOtherQualifier.operations).toEqual([]);
    });
  });

  it("honours a minimum purchase requirement", () => {
    const config = { triggers: [], minRequirement: { type: "AMOUNT", value: 1000 } };
    expect(run({ lines: [snowboard, giftInCart], entered: ["TEST"], config }).operations).toEqual([]);
    expect(
      run({ lines: [snowboard, giftInCart], entered: ["TEST"], config: { ...config, minRequirement: { type: "AMOUNT", value: 500 } } })
        .operations,
    ).toHaveLength(1);
  });

  it("does nothing for an empty cart", () => {
    expect(run({ lines: [], entered: ["TEST"] }).operations).toEqual([]);
  });
});