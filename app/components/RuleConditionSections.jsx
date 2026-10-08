import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { TIME_OPTIONS, formatTime } from "../utils/zonedTime";

/**
 * Sections shared by the free gift and tiered discount forms, mirroring
 * Shopify's own discount form: minimum purchase requirements, customer
 * eligibility, maximum uses (code discounts only), tags and active dates.
 */

export function MinimumRequirementSection({ value, onChange }) {
  const type = value?.type ?? "NONE";
  return (
    <s-section heading="Minimum purchase requirements">
      <s-stack direction="block" gap="base">
        <s-choice-list
          label="Minimum purchase requirements"
          labelAccessibilityVisibility="exclusive"
          onChange={(e) => onChange({ type: e.currentTarget.values[0], value: "" })}
        >
          <s-choice value="NONE" selected={type === "NONE"}>No minimum requirements</s-choice>
          <s-choice value="AMOUNT" selected={type === "AMOUNT"}>Minimum purchase amount</s-choice>
          <s-choice value="QUANTITY" selected={type === "QUANTITY"}>Minimum quantity of items</s-choice>
        </s-choice-list>
        {type === "AMOUNT" && (
          <s-money-field
            label="Minimum purchase amount"
            details="Cart subtotal before discounts, excluding free gifts."
            value={value.value ?? ""}
            min={0}
            onChange={(e) => onChange({ type, value: e.target.value })}
          />
        )}
        {type === "QUANTITY" && (
          <s-number-field
            label="Minimum quantity of items"
            details="Total items in the cart, excluding free gifts."
            value={value.value ?? ""}
            min={1}
            step={1}
            onChange={(e) => onChange({ type, value: e.target.value })}
          />
        )}
        {type !== "NONE" && (
          <s-paragraph tone="subdued">
            With a minimum requirement, cart conditions are optional — leave them empty to apply
            to any cart that meets the minimum.
          </s-paragraph>
        )}
      </s-stack>
    </s-section>
  );
}

const ELIGIBILITY_COPY = {
  SEGMENTS: { search: "Search customer segments", empty: "No segments selected." },
  CUSTOMERS: { search: "Search customers", empty: "No customers selected." },
};

export function EligibilitySection({ value, onChange }) {
  const eligibility = value ?? { type: "ALL", segments: [], customers: [] };
  const type = eligibility.type;
  const listKey = type === "SEGMENTS" ? "segments" : "customers";
  const selected = eligibility[listKey] ?? [];

  const search = useFetcher();
  const [query, setQuery] = useState("");
  const timer = useRef(null);

  useEffect(() => {
    if (type === "ALL") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      search.load(`/app/search/customers?type=${listKey}&q=${encodeURIComponent(query)}`);
    }, 250);
    return () => clearTimeout(timer.current);
  }, [type, query]); // eslint-disable-line react-hooks/exhaustive-deps

  function setType(nextType) {
    setQuery("");
    onChange({ ...eligibility, type: nextType });
  }

  function add(item) {
    if (selected.some((s) => s.id === item.id)) return;
    onChange({ ...eligibility, [listKey]: [...selected, item] });
  }

  function remove(id) {
    onChange({ ...eligibility, [listKey]: selected.filter((s) => s.id !== id) });
  }

  const results = (search.data?.results ?? []).filter((r) => !selected.some((s) => s.id === r.id));

  return (
    <s-section heading="Eligibility">
      <s-stack direction="block" gap="base">
        <s-select label="Eligible customers" value={type} onChange={(e) => setType(e.target.value)}>
          <s-option value="ALL">All customers</s-option>
          <s-option value="SEGMENTS">Specific customer segments</s-option>
          <s-option value="CUSTOMERS">Specific customers</s-option>
        </s-select>

        {type !== "ALL" && (
          <>
            <s-search-field
              label={ELIGIBILITY_COPY[type].search}
              labelAccessibilityVisibility="exclusive"
              placeholder={ELIGIBILITY_COPY[type].search}
              value={query}
              onInput={(e) => setQuery(e.target.value)}
            />
            {search.data?.error && <s-banner tone="critical">{search.data.error}</s-banner>}
            {results.length > 0 && (
              <s-stack direction="block" gap="small-200">
                {results.map((item) => (
                  <s-stack key={item.id} direction="inline" gap="base" alignItems="center">
                    <s-button variant="tertiary" onClick={() => add(item)}>
                      Add
                    </s-button>
                    <s-text>{item.name}</s-text>
                    {item.email && <s-text tone="subdued">{item.email}</s-text>}
                  </s-stack>
                ))}
              </s-stack>
            )}

            <s-text type="strong">Selected</s-text>
            {selected.length === 0 ? (
              <s-text tone="subdued">{ELIGIBILITY_COPY[type].empty}</s-text>
            ) : (
              <s-stack direction="block" gap="small-200">
                {selected.map((item) => (
                  <s-stack key={item.id} direction="inline" gap="base" alignItems="center">
                    <s-text>{item.name}</s-text>
                    {item.email && <s-text tone="subdued">{item.email}</s-text>}
                    <s-button variant="tertiary" tone="critical" onClick={() => remove(item.id)}>
                      Remove
                    </s-button>
                  </s-stack>
                ))}
              </s-stack>
            )}
          </>
        )}
      </s-stack>
    </s-section>
  );
}

export function UsageLimitSection({ usageLimit, oncePerCustomer, onChange }) {
  const [limitTotal, setLimitTotal] = useState(usageLimit != null && usageLimit !== "");
  return (
    <s-section heading="Maximum discount uses">
      <s-stack direction="block" gap="base">
        <s-checkbox
          label="Limit number of times this discount can be used in total"
          checked={limitTotal}
          onChange={(e) => {
            setLimitTotal(e.target.checked);
            if (!e.target.checked) onChange({ usageLimit: null });
          }}
        />
        {limitTotal && (
          <s-number-field
            label="Total uses"
            value={usageLimit ?? ""}
            min={1}
            step={1}
            onChange={(e) => onChange({ usageLimit: e.target.value })}
          />
        )}
        <s-checkbox
          label="Limit to one use per customer"
          checked={Boolean(oncePerCustomer)}
          onChange={(e) => onChange({ oncePerCustomer: e.target.checked })}
        />
      </s-stack>
    </s-section>
  );
}

export function TagsSection({ tags, onChange }) {
  const [draft, setDraft] = useState("");
  const list = tags ?? [];

  function addDraft() {
    const additions = draft
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t && !list.some((existing) => existing.toLowerCase() === t.toLowerCase()));
    if (additions.length) onChange([...list, ...additions]);
    setDraft("");
  }

  return (
    <s-section heading="Tags">
      <s-stack direction="block" gap="base">
        <s-paragraph tone="subdued">
          Searchable keywords, saved on the Shopify discount like Shopify&apos;s own discount tags.
        </s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-text-field
            label="Add tags"
            placeholder="e.g. summer, vip"
            value={draft}
            onInput={(e) => setDraft(e.target.value)}
          />
          <s-button onClick={addDraft}>Add</s-button>
        </s-stack>
        {list.length > 0 && (
          <s-stack direction="inline" gap="small-200">
            {list.map((tag) => (
              <s-stack key={tag} direction="inline" gap="small-400" alignItems="center">
                <s-badge>{tag}</s-badge>
                <s-button
                  variant="tertiary"
                  accessibilityLabel={`Remove tag ${tag}`}
                  onClick={() => onChange(list.filter((t) => t !== tag))}
                >
                  ×
                </s-button>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

function TimeSelect({ label, value, onChange }) {
  // Keep a saved time that isn't on the half-hour grid selectable.
  const options = TIME_OPTIONS.some((o) => o.value === value)
    ? TIME_OPTIONS
    : [{ value, label: formatTime(value) }, ...TIME_OPTIONS];
  return (
    <s-select label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((option) => (
        <s-option key={option.value} value={option.value}>
          {option.label}
        </s-option>
      ))}
    </s-select>
  );
}

/** `dates` = { startDate, startTime, endDate, endTime } in the shop's time zone. */
export function ActiveDatesSection({ dates, timeZone, onChange }) {
  const set = (patch) => onChange({ ...dates, ...patch });
  return (
    <s-section heading="Active dates">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base">
          <s-date-field label="Start date" value={dates.startDate} onChange={(e) => set({ startDate: e.target.value })} />
          <TimeSelect label={`Start time (${timeZone})`} value={dates.startTime} onChange={(startTime) => set({ startTime })} />
        </s-stack>
        <s-stack direction="inline" gap="base">
          <s-date-field
            label="End date (optional)"
            value={dates.endDate}
            onChange={(e) => set({ endDate: e.target.value })}
          />
          {dates.endDate && (
            <TimeSelect label={`End time (${timeZone})`} value={dates.endTime} onChange={(endTime) => set({ endTime })} />
          )}
        </s-stack>
      </s-stack>
    </s-section>
  );
}
