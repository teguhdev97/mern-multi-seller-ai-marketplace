import { MysqlDialect } from "kysely";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { stripe as stripePlugin } from "@better-auth/stripe";
import { authPool, sql, write } from "../db/pool.js";
import { stripe } from "./stripe.js";
import { ac, buyer, seller, admin as adminRole } from "./permissions.js";

const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
export const stripeEnabled = Boolean(stripe && stripeWebhookSecret);

export const auth = betterAuth({
  database: {
    dialect: new MysqlDialect({ pool: authPool }),
    type: "mysql",
    transaction: true,
  },
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:5173",
  trustedOrigins: [process.env.FRONTEND_URL || "http://localhost:5173"],
  emailAndPassword: { enabled: true },
  socialProviders:
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {},
  plugins: [
    admin({
      ac,
      roles: { buyer, seller, admin: adminRole },
      defaultRole: "buyer",
    }),
    ...(stripe && stripeWebhookSecret
      ? [
          stripePlugin({
            stripeClient: stripe,
            stripeWebhookSecret,
            onEvent: async (event) => {
              if (
                event.type === "checkout.session.completed" ||
                event.type === "checkout.session.async_payment_succeeded"
              ) {
                const session = event.data.object;
                if (
                  session.payment_status === "paid" ||
                  session.payment_status === "no_payment_required"
                ) {
                  await write(sql`UPDATE \`order\` SET paymentStatus = 'paid',
              status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END
              WHERE stripeSessionId = ${session.id} AND paymentMethod = 'stripe'`);
                }
              }
              if (
                event.type === "checkout.session.expired" ||
                event.type === "checkout.session.async_payment_failed"
              ) {
                await write(sql`UPDATE \`order\` SET paymentStatus = 'failed'
            WHERE stripeSessionId = ${event.data.object.id} AND paymentStatus = 'pending'`);
              }
            },
          }),
        ]
      : []),
  ],
});
