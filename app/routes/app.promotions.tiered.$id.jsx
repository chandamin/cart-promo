import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getRule } from "../services/promotionRules.server";
import { saveRule } from "../services/promotions.server";
import { ConditionPicker } from "../components/ConditionPicker";

const BLANK_RULE = {
  name: "",
  status: "DRAFT",
  discountMethod: "AUTOMATIC",
  code: "",
  combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
  startsAt: "",
  endsAt: "",
  triggers: [],
  triggerMatch: "ANY",
  config: { basis: "QUANTITY", tiers: [], exclusions: [] },
};

function blankTier() {
  return { threshold: "", rewardType: "PERCENTAGE", value: "" };
}

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  if (params.id === "new") {
    return { rule: BLANK_RULE, isNew: true };
  }
  const rule = await getRule(session.shop, params.id);
  return { rule, isNew: false };
};

export const action = async ({ request, params }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const input = await request.json();
    input.type = "TIERED_DISCOUNT";
    input.config = {
      ...input.config,
      tiers: input.config.tiers.map((t) => ({
        threshold: Number(t.threshold),
        rewardType: t.rewardType,
        value: Number(t.value),
      })),
    };
    const rule = await saveRule(admin, session.shop, params.id, input);
    return { ok: true, id: rule.id };
  } catch (error) {
    if (error instanceof Response) throw error; // let auth redirects/etc. propagate
    // eslint-disable-next-line no-console
    console.error("[promotions/tiered] save failed:", error);
    return { ok: false, error: error.message ?? String(error) };
  }
};

export default function TieredDiscountForm() {
  const { rule, isNew } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [form, setForm] = useState(() => ({
    ...BLANK_RULE,
    ...rule,
    startsAt: rule.startsAt ? String(rule.startsAt).slice(0, 10) : "",
    endsAt: rule.endsAt ? String(rule.endsAt).slice(0, 10) : "",
    config: {
      ...BLANK_RULE.config,
      ...rule.config,
      tiers: rule.config?.tiers?.length
        ? rule.config.tiers.map((t) => ({ ...t, threshold: String(t.threshold), value: String(t.value) }))
        : [blankTier()],
    },
  }));

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show(isNew ? "Promotion created" : "Promotion saved");
      navigate("/app/promotions");
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  function set(patch) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function setConfig(patch) {
    setForm((prev) => ({ ...prev, config: { ...prev.config, ...patch } }));
  }

  function setCombinesWith(key, value) {
    setForm((prev) => ({
      ...prev,
      combinesWith: { ...prev.combinesWith, [key]: value },
    }));
  }

  function updateTier(index, patch) {
    const tiers = [...form.config.tiers];
    tiers[index] = { ...tiers[index], ...patch };
    setConfig({ tiers });
  }

  function addTier() {
    setConfig({ tiers: [...form.config.tiers, blankTier()] });
  }

  function removeTier(index) {
    setConfig({ tiers: form.config.tiers.filter((_, i) => i !== index) });
  }

  function save() {
    fetcher.submit(form, {
      method: "POST",
      encType: "application/json",
    });
  }

  const isSaving = fetcher.state !== "idle";
  const basisLabel = form.config.basis === "QUANTITY" ? "units" : "spend";

  return (
    <s-page heading={isNew ? "Create tiered discount" : `Edit: ${rule.name}`}>
      <s-link slot="breadcrumb-actions" href="/app/promotions">
        Promotions
      </s-link>
      <s-button slot="primary-action" onClick={save} {...(isSaving ? { loading: true } : {})}>
        Save
      </s-button>

      <s-section heading="Details">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Name"
            value={form.name}
            required
            onChange={(e) => set({ name: e.target.value })}
          />
          <s-select label="Status" value={form.status} onChange={(e) => set({ status: e.target.value })}>
            <s-option value="DRAFT">Draft</s-option>
            <s-option value="ACTIVE">Active</s-option>
            <s-option value="DISABLED">Disabled</s-option>
          </s-select>
        </s-stack>
      </s-section>

      <s-section heading="Discount method">
        <s-stack direction="block" gap="base">
          <s-select
            label="Method"
            value={form.discountMethod}
            onChange={(e) => set({ discountMethod: e.target.value })}
          >
            <s-option value="AUTOMATIC">Automatic — applies when cart conditions are met</s-option>
            <s-option value="CODE">Code — customer enters a discount code</s-option>
          </s-select>
          {form.discountMethod === "CODE" && (
            <s-text-field
              label="Discount code"
              value={form.code}
              required
              onChange={(e) => set({ code: e.target.value.toUpperCase() })}
            />
          )}
        </s-stack>
      </s-section>

      <s-section heading="Cart conditions">
        <s-paragraph tone="subdued">
          The tiers apply to items matching these conditions.
        </s-paragraph>
        <ConditionPicker
          label="Apply tiers when the cart contains"
          conditions={form.triggers}
          onChange={(triggers) => set({ triggers })}
          showMinQuantity
          showMatch
          matchMode={form.triggerMatch}
          onMatchModeChange={(triggerMatch) => set({ triggerMatch })}
        />
      </s-section>

      <s-section heading="Tiers">
        <s-stack direction="block" gap="base">
          <s-select
            label="Tier basis"
            details="Whether tiers are unlocked by quantity of qualifying items, or by qualifying spend."
            value={form.config.basis}
            onChange={(e) => setConfig({ basis: e.target.value })}
          >
            <s-option value="QUANTITY">Quantity of qualifying items</s-option>
            <s-option value="AMOUNT">Qualifying spend amount</s-option>
          </s-select>

          <s-table variant="list">
            <s-table-header-row>
              <s-table-header>{`Min. ${basisLabel}`}</s-table-header>
              <s-table-header>Reward</s-table-header>
              <s-table-header>Value</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {form.config.tiers.map((tier, index) => (
                <s-table-row key={index}>
                  <s-table-cell>
                    <s-number-field
                      label={`Min. ${basisLabel}`}
                      labelAccessibilityVisibility="exclusive"
                      value={tier.threshold}
                      min={form.config.basis === "QUANTITY" ? 1 : 0}
                      onChange={(e) => updateTier(index, { threshold: e.target.value })}
                    />
                  </s-table-cell>
                  <s-table-cell>
                    <s-select
                      label="Reward"
                      labelAccessibilityVisibility="exclusive"
                      value={tier.rewardType}
                      onChange={(e) => updateTier(index, { rewardType: e.target.value })}
                    >
                      <s-option value="PERCENTAGE">% off</s-option>
                      <s-option value="FIXED_AMOUNT">Amount off</s-option>
                    </s-select>
                  </s-table-cell>
                  <s-table-cell>
                    <s-number-field
                      label="Value"
                      labelAccessibilityVisibility="exclusive"
                      value={tier.value}
                      min={0}
                      onChange={(e) => updateTier(index, { value: e.target.value })}
                    />
                  </s-table-cell>
                  <s-table-cell>
                    <s-button variant="tertiary" tone="critical" onClick={() => removeTier(index)}>
                      Remove
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <s-button onClick={addTier}>Add tier</s-button>
        </s-stack>
      </s-section>

      <s-section heading="Exclusions">
        <s-paragraph tone="subdued">
          Products or collections that never receive this discount.
        </s-paragraph>
        <ConditionPicker
          label="Exclude from discount"
          conditions={form.config.exclusions}
          onChange={(exclusions) => setConfig({ exclusions })}
          showMinQuantity={false}
          showMatch={false}
        />
      </s-section>

      <s-section heading="Combine with other discounts">
        <s-stack direction="block" gap="tight">
          <s-checkbox
            label="Product discounts"
            checked={form.combinesWith.productDiscounts}
            onChange={(e) => setCombinesWith("productDiscounts", e.target.checked)}
          />
          <s-checkbox
            label="Order discounts"
            checked={form.combinesWith.orderDiscounts}
            onChange={(e) => setCombinesWith("orderDiscounts", e.target.checked)}
          />
          <s-checkbox
            label="Shipping discounts"
            checked={form.combinesWith.shippingDiscounts}
            onChange={(e) => setCombinesWith("shippingDiscounts", e.target.checked)}
          />
        </s-stack>
      </s-section>

      <s-section heading="Active dates">
        <s-stack direction="inline" gap="base">
          <s-date-field label="Start date" value={form.startsAt} onChange={(e) => set({ startsAt: e.target.value })} />
          <s-date-field label="End date (optional)" value={form.endsAt} onChange={(e) => set({ endsAt: e.target.value })} />
        </s-stack>
      </s-section>
    </s-page>
  );
}
