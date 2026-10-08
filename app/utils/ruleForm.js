import { fromZonedParts, toZonedParts } from "./zonedTime";

/** Form state for the fields shared by every rule form (see RuleConditionSections). */
export function initialSharedFields(rule, timeZone) {
  const start = toZonedParts(rule.startsAt, timeZone);
  const end = toZonedParts(rule.endsAt, timeZone);
  const req = rule.minRequirement;
  return {
    minRequirement:
      req?.type && req.type !== "NONE"
        ? { type: req.type, value: req.value == null ? "" : String(req.value) }
        : { type: "NONE", value: "" },
    eligibility: rule.eligibility?.type
      ? { segments: [], customers: [], ...rule.eligibility }
      : { type: "ALL", segments: [], customers: [] },
    usageLimit: rule.usageLimit == null ? null : String(rule.usageLimit),
    oncePerCustomer: Boolean(rule.oncePerCustomer),
    tags: Array.isArray(rule.tags) ? rule.tags : [],
    cartLabel: rule.cartLabel ?? "",
    dates: {
      startDate: start.date,
      startTime: start.time || "00:00",
      endDate: end.date,
      endTime: end.time || "23:59",
    },
  };
}

/** Form state -> action payload: wall-clock dates become UTC instants. */
export function serializeRuleForm(form, timeZone) {
  const { dates, ...rest } = form;
  return {
    ...rest,
    startsAt: fromZonedParts(dates.startDate, dates.startTime, timeZone),
    endsAt: fromZonedParts(dates.endDate, dates.endTime, timeZone),
  };
}
