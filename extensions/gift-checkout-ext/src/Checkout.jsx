import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const PROXY_PATH = "/apps/cartpromo/gift-rules";
const ATTRIBUTE_KEY = "_cartpromo_rule";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const [pickerRule, setPickerRule] = useState(null);
  const [busy, setBusy] = useState(false);

  const lines = shopify.lines.value;
  const linesKey = lines.map((l) => `${l.merchandise?.id}:${l.quantity}`).join(",");
  const codesKey = shopify.discountCodes.value.map((d) => d.code).join(",");

  useEffect(() => {
    let cancelled = false;

    async function sync() {
      const currentLines = shopify.lines.value;
      const payload = currentLines
        .map((l) => ({
          productId: l.merchandise?.product?.id,
          variantId: l.merchandise?.id,
          quantity: l.quantity,
        }))
        .filter((l) => l.productId && l.variantId);

      const url = new URL(PROXY_PATH, `https://${shopify.shop.myshopifyDomain}`);
      url.searchParams.set("lines", JSON.stringify(payload));
      url.searchParams.set(
        "codes",
        JSON.stringify(shopify.discountCodes.value.map((d) => d.code)),
      );

      let result;
      try {
        const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
        result = response.ok ? await response.json() : { qualifying: [], giftVariantIds: [] };
      } catch {
        result = { qualifying: [], giftVariantIds: [] };
      }
      if (cancelled) return;

      const qualifyingRuleIds = result.qualifying.map((q) => q.ruleId);
      const giftLines = currentLines.filter((l) =>
        l.attributes?.some((a) => a.key === ATTRIBUTE_KEY),
      );

      const staleLines = giftLines.filter((line) => {
        const ruleId = line.attributes.find((a) => a.key === ATTRIBUTE_KEY)?.value;
        return !ruleId || !qualifyingRuleIds.includes(ruleId);
      });

      for (const line of staleLines) {
        await shopify.applyCartLinesChange({ type: "removeCartLine", id: line.id, quantity: line.quantity });
      }

      let nextPicker = null;
      for (const q of result.qualifying) {
        const alreadyHasOne = q.gifts.some((g) =>
          currentLines.some((l) => l.merchandise?.id === g.variantId),
        );
        if (alreadyHasOne) continue;
        if (q.gifts.length === 1) {
          await shopify.applyCartLinesChange({
            type: "addCartLine",
            merchandiseId: q.gifts[0].variantId,
            quantity: 1,
            attributes: [{ key: ATTRIBUTE_KEY, value: q.ruleId }],
          });
        } else if (!nextPicker) {
          nextPicker = q;
        }
      }
      if (!cancelled) setPickerRule(nextPicker);
    }

    sync();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, codesKey]);

  if (!pickerRule) return null;

  async function pick(variantId) {
    setBusy(true);
    await shopify.applyCartLinesChange({
      type: "addCartLine",
      merchandiseId: variantId,
      quantity: 1,
      attributes: [{ key: ATTRIBUTE_KEY, value: pickerRule.ruleId }],
    });
    setBusy(false);
    setPickerRule(null);
  }

  return (
    <s-banner heading="Choose your free gift" tone="info">
      <s-stack gap="base">
        {pickerRule.gifts.map((gift) => (
          <s-button key={gift.variantId} disabled={busy} onClick={() => pick(gift.variantId)}>
            {gift.title}
          </s-button>
        ))}
      </s-stack>
    </s-banner>
  );
}
