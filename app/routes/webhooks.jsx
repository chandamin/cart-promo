import { authenticate } from "../shopify.server";
import db from "../db.server"; // your Prisma client, if you have one

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // payload contains the customer + what data was requested
      // e.g. log it, or export/email the data you hold for this customer
      console.log("Data request for shop:", shop, payload);
      break;

    case "CUSTOMERS_REDACT":
      // Delete this customer's data from your DB
      // payload.customer.id gives you the customer to redact
      console.log("Customer redact for shop:", shop, payload);
      break;

    case "SHOP_REDACT":
      // Delete all data tied to this shop
      console.log("Shop redact for shop:", shop, payload);
      // e.g. await db.session.deleteMany({ where: { shop } });
      break;

    default:
      return new Response("Unhandled webhook topic", { status: 404 });
  }

  return new Response();
};