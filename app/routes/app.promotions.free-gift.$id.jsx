import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getRule } from "../services/promotionRules.server";
import { saveRule } from "../services/promotions.server";
import { fetchShopTimezone } from "../services/shop.server";
import { ConditionPicker } from "../components/ConditionPicker";
import { GiftPicker } from "../components/GiftPicker";
import {
  ActiveDatesSection,
  EligibilitySection,
  MinimumRequirementSection,
  TagsSection,
  UsageLimitSection,
} from "../components/RuleConditionSections";
import { initialSharedFields, serializeRuleForm } from "../utils/ruleForm";

const BLANK_RULE = {
  name: "",
  status: "DRAFT",
  discountMethod: "AUTOMATIC",
  code: "",
  combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
  startsAt: null,
  endsAt: null,
  triggers: [],
  triggerMatch: "ANY",
  config: { gifts: [], giftQuantity: 1 },
};

export const loader = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const timeZone = await fetchShopTimezone(admin);
  if (params.id === "new") {
    return { rule: BLANK_RULE, isNew: true, timeZone };
  }
  const rule = await getRule(session.shop, params.id);
  return { rule, isNew: false, timeZone };
};

export const action = async ({ request, params }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const input = await request.json();
    input.type = "FREE_GIFT";
    const rule = await saveRule(admin, session.shop, params.id, input);
    return { ok: true, id: rule.id };
  } catch (error) {
    if (error instanceof Response) throw error; // let auth redirects/etc. propagate
    // eslint-disable-next-line no-console
    console.error("[promotions/free-gift] save failed:", error);
    return { ok: false, error: error.message ?? String(error) };
  }
};

export default function FreeGiftForm() {
  const { rule, isNew, timeZone } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [form, setForm] = useState(() => {
    // eslint-disable-next-line no-unused-vars
    const { startsAt, endsAt, ...rest } = { ...BLANK_RULE, ...rule };
    return {
      ...rest,
      ...initialSharedFields(rule, timeZone),
      config: { ...BLANK_RULE.config, ...rule.config },
    };
  });

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

  function save() {
    fetcher.submit(serializeRuleForm(form, timeZone), {
      method: "POST",
      encType: "application/json",
    });
  }

  const isSaving = fetcher.state !== "idle";

  return (
    <s-page heading={isNew ? "Create free gift" : `Edit: ${rule.name}`}>
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
          <s-text-field
            label="Cart label"
            details="Shown to customers on the gift line in the cart and checkout. Defaults to the name."
            placeholder={form.name || "Free gift"}
            value={form.cartLabel}
            onChange={(e) => set({ cartLabel: e.target.value })}
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
          The gift is offered when the cart matches these conditions.
        </s-paragraph>
        <ConditionPicker
          label="Offer the gift when the cart contains"
          conditions={form.triggers}
          onChange={(triggers) => set({ triggers })}
          showMinQuantity
          showMatch
          matchMode={form.triggerMatch}
          onMatchModeChange={(triggerMatch) => set({ triggerMatch })}
        />
      </s-section>

      <MinimumRequirementSection
        value={form.minRequirement}
        onChange={(minRequirement) => set({ minRequirement })}
      />

      <s-section heading="Gift products">
        <s-paragraph tone="subdued">
          If more than one gift is added, the customer chooses which one to receive.
        </s-paragraph>
        <GiftPicker gifts={form.config.gifts} onChange={(gifts) => setConfig({ gifts })} />
      </s-section>

      <EligibilitySection value={form.eligibility} onChange={(eligibility) => set({ eligibility })} />

      {form.discountMethod === "CODE" && (
        <UsageLimitSection
          usageLimit={form.usageLimit}
          oncePerCustomer={form.oncePerCustomer}
          onChange={set}
        />
      )}

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

      <ActiveDatesSection dates={form.dates} timeZone={timeZone} onChange={(dates) => set({ dates })} />

      <TagsSection tags={form.tags} onChange={(tags) => set({ tags })} />
    </s-page>
  );
}
