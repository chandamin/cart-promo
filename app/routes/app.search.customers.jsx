import { authenticate } from "../shopify.server";

/**
 * Search endpoint for the Eligibility picker on the rule forms.
 * `?type=customers&q=...` or `?type=segments&q=...`. Requires read_customers.
 */
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const q = (url.searchParams.get("q") || "").trim();

  try {
    if (type === "segments") {
      // Shops have few segments; filter by name here rather than in the query syntax.
      const response = await admin.graphql(`#graphql
        query cartPromoSegments { segments(first: 100) { nodes { id name } } }
      `);
      const json = await response.json();
      const needle = q.toLowerCase();
      const results = (json.data?.segments?.nodes ?? [])
        .filter((s) => !needle || s.name.toLowerCase().includes(needle))
        .map((s) => ({ id: s.id, name: s.name }));
      return { results };
    }

    const response = await admin.graphql(
      `#graphql
        query cartPromoCustomers($query: String) {
          customers(first: 10, query: $query) { nodes { id displayName email } }
        }
      `,
      { variables: { query: q || null } },
    );
    const json = await response.json();
    const results = (json.data?.customers?.nodes ?? []).map((c) => ({
      id: c.id,
      name: c.displayName,
      email: c.email,
    }));
    return { results };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { results: [], error: "Search failed. The app may need the read_customers permission." };
  }
};
