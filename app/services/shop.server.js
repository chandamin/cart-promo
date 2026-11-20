/** The shop's IANA time zone (e.g. "America/New_York"), falling back to UTC. */
export async function fetchShopTimezone(admin) {
  try {
    const response = await admin.graphql(`#graphql
      query cartPromoShopTimezone { shop { ianaTimezone } }
    `);
    const json = await response.json();
    return json.data?.shop?.ianaTimezone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The shop's primary domain (e.g. "tresure-rare.com"), falling back to null. */
export async function fetchShopDomain(admin) {
  try {
    const response = await admin.graphql(`#graphql
      query cartPromoShopDomain { shop { primaryDomain { host } } }
    `);
    const json = await response.json();
    return json.data?.shop?.primaryDomain?.host ?? null;
  } catch {
    return null;
  }
}
