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
