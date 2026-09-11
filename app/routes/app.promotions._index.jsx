import { useEffect } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { listRules } from "../services/promotionRules.server";
import { changeRuleStatus, removeRule } from "../services/promotions.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const rules = await listRules(session.shop);
  return { rules };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const id = formData.get("id");

  try {
    if (intent === "delete") {
      await removeRule(admin, session.shop, id);
      return { ok: true };
    }
    if (intent === "toggle-status") {
      const nextStatus = formData.get("status");
      await changeRuleStatus(admin, session.shop, id, nextStatus);
      return { ok: true };
    }
    return { ok: false };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[promotions/index] action failed:", error);
    return { ok: false, error: error.message ?? String(error) };
  }
};

const TYPE_LABEL = {
  FREE_GIFT: "Free gift",
  TIERED_DISCOUNT: "Tiered discount",
};

const TYPE_PATH = {
  FREE_GIFT: "free-gift",
  TIERED_DISCOUNT: "tiered",
};

const STATUS_TONE = {
  ACTIVE: "success",
  DRAFT: "neutral",
  DISABLED: "warning",
};

export default function PromotionsIndex() {
  const { rules } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show("Updated");
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  function editHref(rule) {
    return `/app/promotions/${TYPE_PATH[rule.type]}/${rule.id}`;
  }

  function toggleStatus(rule) {
    const nextStatus = rule.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    fetcher.submit(
      { intent: "toggle-status", id: rule.id, status: nextStatus },
      { method: "POST" },
    );
  }

  function remove(rule) {
    if (!confirm(`Delete "${rule.name}"? This cannot be undone.`)) return;
    fetcher.submit({ intent: "delete", id: rule.id }, { method: "POST" });
  }

  return (
    <s-page heading="Promotions">
      <s-button slot="primary-action" onClick={() => navigate("/app/promotions/free-gift/new")}>
        Create free gift
      </s-button>
      <s-button slot="secondary-actions" onClick={() => navigate("/app/promotions/tiered/new")}>
        Create tiered discount
      </s-button>

      <s-section>
        {rules.length === 0 ? (
          <s-paragraph>
            No promotions yet. Create a free gift or tiered discount to get started.
          </s-paragraph>
        ) : (
          <s-table variant="list">
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Method</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rules.map((rule) => (
                <s-table-row key={rule.id}>
                  <s-table-cell>
                    <s-link href={editHref(rule)}>{rule.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>{TYPE_LABEL[rule.type]}</s-table-cell>
                  <s-table-cell>
                    {rule.discountMethod === "CODE" ? `Code: ${rule.code}` : "Automatic"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[rule.status]}>{rule.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="tight">
                      <s-button variant="tertiary" onClick={() => toggleStatus(rule)}>
                        {rule.status === "ACTIVE" ? "Disable" : "Enable"}
                      </s-button>
                      <s-button variant="tertiary" tone="critical" onClick={() => remove(rule)}>
                        Delete
                      </s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
