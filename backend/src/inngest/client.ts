import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "multi-seller-marketplace" });

export const inngestEnabled = Boolean(
  process.env.INNGEST_DEV === "1" ||
  (process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY),
);

export async function sendNotification(event: {
  name: string;
  data: Record<string, unknown>;
}) {
  if (!inngestEnabled || !process.env.RESEND_API_KEY) return;
  try {
    await inngest.send(event);
  } catch (error) {
    console.error("Could not queue marketplace notification", error);
  }
}
