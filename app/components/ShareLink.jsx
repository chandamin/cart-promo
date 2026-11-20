import { useState } from "react";

/**
 * Shows a read-only "Share link" field for a code-based, active discount.
 * The link is Shopify's native /discount/<CODE> URL that auto-applies the
 * code when a customer visits it.
 *
 * Props:
 *   shopDomain  – string | null  e.g. "tresure-rare.com"
 *   code        – string         the discount code
 *   status      – string         rule status ("ACTIVE" | "DRAFT" | "DISABLED")
 *   isNew       – boolean        hide the link on unsaved rules
 */
export function ShareLink({ shopDomain, code, status, isNew }) {
  const [copied, setCopied] = useState(false);

  if (isNew || !code || !shopDomain || status !== "ACTIVE") return null;

  const url = `https://${shopDomain}/discount/${encodeURIComponent(code)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text in the input
      const input = document.getElementById("cartpromo-share-link-input");
      input?.select();
    }
  }

  return (
    <s-section heading="Share link">
      <s-stack direction="block" gap="tight">
        <s-paragraph tone="subdued">
          Send this link to customers — it opens your store and automatically applies the code{" "}
          <strong>{code}</strong> at checkout.
        </s-paragraph>
        <s-stack direction="inline" gap="tight" align="end">
          <s-text-field
            id="cartpromo-share-link-input"
            label="Auto-apply URL"
            value={url}
            readOnly
            style={{ flex: 1 }}
          />
          <s-button onClick={copy}>{copied ? "Copied!" : "Copy"}</s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
