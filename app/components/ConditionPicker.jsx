import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * Shared UI for picking a flat list of products/collections, used for both
 * cart triggers (with a minimum quantity + ANY/ALL match mode) and tiered
 * discount exclusions (no quantity, no match mode).
 */
export function ConditionPicker({
  label,
  conditions,
  onChange,
  showMinQuantity = true,
  showMatch = false,
  matchMode = "ANY",
  onMatchModeChange,
}) {
  const shopify = useAppBridge();

  async function addProducts() {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
    });
    if (!selected?.length) return;
    const additions = selected.map((product) => ({
      kind: "PRODUCT",
      id: product.id,
      title: product.title,
      image: product.images?.[0]?.originalSrc ?? null,
      minQuantity: 1,
    }));
    onChange([...conditions, ...dedupe(additions, conditions)]);
  }

  async function addCollections() {
    const selected = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      action: "select",
    });
    if (!selected?.length) return;
    const additions = selected.map((collection) => ({
      kind: "COLLECTION",
      id: collection.id,
      title: collection.title,
      image: collection.image?.originalSrc ?? null,
      minQuantity: 1,
    }));
    onChange([...conditions, ...dedupe(additions, conditions)]);
  }

  function removeAt(index) {
    onChange(conditions.filter((_, i) => i !== index));
  }

  function updateMinQuantity(index, value) {
    const next = [...conditions];
    next[index] = { ...next[index], minQuantity: Math.max(1, Number(value) || 1) };
    onChange(next);
  }

  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="tight" alignItems="center">
        <s-text tone="subdued">{label}</s-text>
      </s-stack>

      {conditions.length > 0 && (
        <s-table variant="list">
          <s-table-header-row>
            <s-table-header>Type</s-table-header>
            <s-table-header>Item</s-table-header>
            {showMinQuantity && <s-table-header>Min. quantity</s-table-header>}
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {conditions.map((condition, index) => (
              <s-table-row key={condition.id}>
                <s-table-cell>
                  <s-badge>{condition.kind === "PRODUCT" ? "Product" : "Collection"}</s-badge>
                </s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="tight" alignItems="center">
                    {condition.image && (
                      <s-thumbnail src={condition.image} alt={condition.title} size="small" />
                    )}
                    <s-text>{condition.title}</s-text>
                  </s-stack>
                </s-table-cell>
                {showMinQuantity && (
                  <s-table-cell>
                    <s-number-field
                      label="Min. quantity"
                      labelAccessibilityVisibility="exclusive"
                      value={String(condition.minQuantity ?? 1)}
                      min={1}
                      onChange={(e) => updateMinQuantity(index, e.target.value)}
                    />
                  </s-table-cell>
                )}
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

      {showMatch && conditions.length > 1 && (
        <s-select
          label="Match"
          details="ANY: cart needs at least one of the items below. ALL: cart needs every item below."
          value={matchMode}
          onChange={(e) => onMatchModeChange(e.target.value)}
        >
          <s-option value="ANY">Cart contains ANY of these</s-option>
          <s-option value="ALL">Cart contains ALL of these</s-option>
        </s-select>
      )}

      <s-stack direction="inline" gap="tight">
        <s-button onClick={addProducts}>Add products</s-button>
        <s-button onClick={addCollections}>Add collections</s-button>
      </s-stack>
    </s-stack>
  );
}

function dedupe(additions, existing) {
  const existingIds = new Set(existing.map((c) => c.id));
  return additions.filter((a) => !existingIds.has(a.id));
}
