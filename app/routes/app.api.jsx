import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { generateApiKey, getApiKeyInfo, revokeApiKey } from "../services/apiKeys.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  // eslint-disable-next-line no-undef
  const appUrl = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  return { keyInfo: await getApiKeyInfo(session.shop), baseUrl: `${appUrl}/api/promotions` };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const intent = (await request.formData()).get("intent");
  if (intent === "revoke") {
    await revokeApiKey(session.shop);
    return { revoked: true };
  }
  return { key: await generateApiKey(session.shop) };
};

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "Never";
}

export default function ApiAccess() {
  const { keyInfo, baseUrl } = useLoaderData();
  const fetcher = useFetcher();
  const newKey = fetcher.data?.key;
  const busy = fetcher.state !== "idle";

  function submit(intent) {
    if (intent === "generate" && keyInfo && !confirm("Replace the current key? Apps using it will stop working.")) return;
    if (intent === "revoke" && !confirm("Revoke the API key? Apps using it will stop working.")) return;
    fetcher.submit({ intent }, { method: "POST" });
  }

  return (
    <s-page heading="API access">
      <s-section heading="API key">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Use this key to list, update and delete this store&apos;s promotions from your own systems.
            Send it in the <s-text type="strong">Authorization</s-text> header as{" "}
            <s-text type="strong">Bearer &lt;key&gt;</s-text>.
          </s-paragraph>

          {newKey && (
            <s-banner tone="warning" heading="Copy your API key now">
              <s-stack direction="block" gap="small-200">
                <s-paragraph>It won&apos;t be shown again. Store it somewhere safe.</s-paragraph>
                <s-text-field label="API key" value={newKey} readOnly />
              </s-stack>
            </s-banner>
          )}

          {keyInfo && !newKey && !fetcher.data?.revoked && (
            <s-paragraph>
              Active key <s-text type="strong">{keyInfo.keyPrefix}…</s-text> · created{" "}
              {formatDate(keyInfo.createdAt)} · last used {formatDate(keyInfo.lastUsedAt)}
            </s-paragraph>
          )}

          <s-stack direction="inline" gap="base">
            <s-button variant="primary" onClick={() => submit("generate")} {...(busy ? { loading: true } : {})}>
              {keyInfo ? "Regenerate key" : "Generate key"}
            </s-button>
            {keyInfo && !fetcher.data?.revoked && (
              <s-button tone="critical" onClick={() => submit("revoke")}>
                Revoke key
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Endpoints">
        <s-stack direction="block" gap="small-200">
          <s-text>Base URL: {baseUrl}</s-text>
          <s-text>GET {"/api/promotions"} — all promotions (filters: ?type=, ?status=)</s-text>
          <s-text>POST {"/api/promotions"} — create (JSON body; type, name and config required)</s-text>
          <s-text>GET {"/api/promotions/:id"} — one promotion</s-text>
          <s-text>PATCH {"/api/promotions/:id"} — update (JSON body with only the fields to change)</s-text>
          <s-text>DELETE {"/api/promotions/:id"} — delete the promotion and its Shopify discount</s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}
