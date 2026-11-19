/**
 * The storefront popup shows a gift's `title` and `image`, which the admin form
 * fills from its product picker. A gift saved through the API only has to carry
 * `productId` and `variantId`, so the rest is looked up here.
 */

const needsDetails = (gift) => !gift.title || !gift.image;

/**
 * Returns `gifts` with any missing `title` / `image` filled in from Shopify.
 * What the caller already supplied is kept. If the lookup fails the gifts come
 * back unchanged: a gift without a picture still works, so a transient API
 * error must not block saving or offering it.
 */
export async function withGiftDetails(admin, gifts) {
  const missing = (gifts ?? []).filter((gift) => gift?.variantId && needsDetails(gift));
  if (!missing.length) return gifts;

  const details = await fetchVariantDetails(admin, [...new Set(missing.map((gift) => gift.variantId))]);
  return gifts.map((gift) => {
    const found = details.get(gift.variantId);
    if (!found || !needsDetails(gift)) return gift;
    return { ...gift, title: gift.title || found.title, image: gift.image || found.image };
  });
}

async function fetchVariantDetails(admin, variantIds) {
  const details = new Map();
  try {
    const response = await admin.graphql(
      `#graphql
        query cartPromoGiftDetails($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              title
              image { url }
              product {
                title
                variantsCount { count }
                featuredMedia { preview { image { url } } }
              }
            }
          }
        }
      `,
      { variables: { ids: variantIds } },
    );
    const json = await response.json();
    if (json.errors?.length || !Array.isArray(json.data?.nodes)) return details;

    for (const node of json.data.nodes) {
      if (!node?.id) continue;
      // Named like the admin picker does: "Product — Variant" only when there are several variants.
      const title =
        node.product.variantsCount?.count > 1 ? `${node.product.title} — ${node.title}` : node.product.title;
      const image = node.image?.url ?? node.product.featuredMedia?.preview?.image?.url ?? null;
      details.set(node.id, { title, image });
    }
  } catch {
    // Left empty: callers keep the gifts as they were.
  }
  return details;
}
