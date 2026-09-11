import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * Picks gift products for a Free Gift rule. Each selected product contributes
 * its first variant as the giftable item — most gift-with-purchase products
 * are single-variant giveaways; multi-variant products fall back to the
 * first variant, called out in the row.
 */
export function GiftPicker({ gifts, onChange }) {
  const shopify = useAppBridge();

  async function addGifts() {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
      filter: { variants: true },
    });
    if (!selected?.length) return;
    const existingIds = new Set(gifts.map((g) => g.variantId));
    const additions = selected
      .map((product) => {
        const variant = product.variants?.[0];
        if (!variant) return null;
        return {
          productId: product.id,
          variantId: variant.id,
          title:
            product.variants.length > 1
              ? `${product.title} — ${variant.title}`
              : product.title,
          image: product.images?.[0]?.originalSrc ?? null,
        };
      })
      .filter((g) => g && !existingIds.has(g.variantId));
    onChange([...gifts, ...additions]);
  }

  function removeAt(index) {
    onChange(gifts.filter((_, i) => i !== index));
  }

  return (
    <s-stack direction="block" gap="base">
      {gifts.length > 0 && (
        <s-table variant="list">
          <s-table-header-row>
            <s-table-header>Gift</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {gifts.map((gift, index) => (
              <s-table-row key={gift.variantId}>
                <s-table-cell>
                  <s-stack direction="inline" gap="tight" alignItems="center">
                    {gift.image && (
                      <s-thumbnail src={gift.image} alt={gift.title} size="small" />
                    )}
                    <s-text>{gift.title}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-button variant="tertiary" tone="critical" onClick={() => removeAt(index)}>
                    Remove
                  </s-button>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}
      {gifts.length > 1 && (
        <s-banner tone="info">
          More than one gift is configured — the customer will be asked to choose which gift to
          add to their cart.
        </s-banner>
      )}
      <s-button onClick={addGifts}>Add gift products</s-button>
    </s-stack>
  );
}
