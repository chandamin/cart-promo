export const TYPE_PATH = {
  FREE_GIFT: "free-gift",
  TIERED_DISCOUNT: "tiered",
};

export function editPath(rule) {
  return `/app/promotions/${TYPE_PATH[rule.type]}/${rule.id}`;
}
