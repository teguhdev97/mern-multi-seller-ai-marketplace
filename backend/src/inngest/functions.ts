import { inngest } from "./client.js";
import {
  sendProductRejectedEmail,
  sendProductApprovedEmail,
  sendOrderStatusEmail,
  sendSellerApprovedEmail,
  sendSellerRejectedEmail,
  sendUserBannedEmail,
} from "../lib/emails.js";
import { sql, one, rows, inList, write, transaction } from "../db/pool.js";
import type {
  Product,
  OrderItem,
  Review,
  AiInsight,
  AiInsightStream,
} from "../db/models.js";
import {
  generateProductRecommendations,
  generateFeedbackSummary,
} from "../lib/gemini.js";

export const sendProductRejected = inngest.createFunction(
  {
    id: "send-product-rejected",
    retries: 3,
    triggers: [{ event: "app/product.rejected" }],
  },
  async ({ event, step }) => {
    await step.run("send-email", async () => {
      const data = event.data as {
        to: string;
        productName: string;
        reason: string;
      };
      await sendProductRejectedEmail(data);
    });
  },
);

export const sendProductApproved = inngest.createFunction(
  {
    id: "send-product-approved",
    retries: 3,
    triggers: [{ event: "app/product.approved" }],
  },
  async ({ event, step }) => {
    await step.run("send-email", async () => {
      const data = event.data as { to: string; productName: string };
      await sendProductApprovedEmail(data);
    });
  },
);

export const sendOrderStatus = inngest.createFunction(
  {
    id: "send-order-status",
    retries: 3,
    triggers: [{ event: "app/order.status.changed" }],
  },
  async ({ event, step }) => {
    await step.run("send-email", async () => {
      const data = event.data as {
        to: string;
        buyerName: string;
        orderId: string;
        status: string;
      };
      await sendOrderStatusEmail(data);
    });
  },
);

export const sendSellerApproved = inngest.createFunction(
  {
    id: "send-seller-approved",
    retries: 3,
    triggers: [{ event: "app/seller.approved" }],
  },
  async ({ event, step }) => {
    await step.run("send-email", async () => {
      const data = event.data as { to: string; sellerName: string };
      await sendSellerApprovedEmail(data);
    });
  },
);

export const sendSellerRejected = inngest.createFunction(
  {
    id: "send-seller-rejected",
    retries: 3,
    triggers: [{ event: "app/seller.rejected" }],
  },
  async ({ event, step }) => {
    await step.run("send-email", async () => {
      const data = event.data as {
        to: string;
        sellerName: string;
        reason?: string;
      };
      await sendSellerRejectedEmail(data);
    });
  },
);

export const sendUserBanned = inngest.createFunction(
  {
    id: "send-user-banned",
    retries: 3,
    triggers: [{ event: "app/user.banned" }],
  },
  async ({ event, step }) => {
    await step.run("send-email", async () => {
      const data = event.data as { to: string; userName: string };
      await sendUserBannedEmail(data);
    });
  },
);

async function appendChunk(streamId: string, chunk: string) {
  await write(sql`
    UPDATE aiInsightStream SET chunks = JSON_ARRAY_APPEND(chunks, '$', ${chunk})
    WHERE id = ${streamId} AND status = 'processing'
  `);
}

async function completeStream(streamId: string, fullText: string) {
  await transaction(async (connection) => {
    const stream = await one<AiInsightStream>(
      sql`
      SELECT * FROM aiInsightStream WHERE id = ${streamId} FOR UPDATE
    `,
      connection,
    );
    if (!stream || stream.status === "complete") return;

    await write(
      sql`
      INSERT INTO aiInsight (id, sellerId, type, content)
      VALUES (${streamId}, ${stream.sellerId}, ${stream.type}, ${fullText})
    `,
      connection,
    );
    await write(
      sql`
      UPDATE aiInsightStream SET status = 'complete' WHERE id = ${streamId}
    `,
      connection,
    );
  });
}

async function streamInsight(streamId: string, fullText: string) {
  await write(sql`UPDATE aiInsightStream SET chunks = JSON_ARRAY()
    WHERE id = ${streamId} AND status = 'processing'`);
  const words = fullText.split(" ");
  for (let i = 0; i < words.length; i += 5) {
    await appendChunk(streamId, words.slice(i, i + 5).join(" ") + " ");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await completeStream(streamId, fullText);
}

export const generateProductRecommendationsFn = inngest.createFunction(
  {
    id: "generate-product-recommendations",
    retries: 2,
    triggers: [{ event: "ai/product-recommendations" }],
  },
  async ({ event, step }) => {
    const { sellerId, streamId } = event.data as {
      sellerId: string;
      streamId: string;
    };

    const sellerProducts = await step.run("fetch-seller-products", async () => {
      return rows<Pick<Product, "name" | "category" | "price">>(
        sql`SELECT p.name, p.category, p.price FROM product p WHERE p.sellerId = ${sellerId}`,
      );
    });

    const allCategories = await step.run("fetch-categories", async () => {
      return [
        "fashion",
        "electronics",
        "beauty",
        "fitness",
        "home-decor",
        "accessories",
      ];
    });

    const recentSales = await step.run("fetch-recent-sales", async () => {
      const items = await rows<
        OrderItem & { product: Pick<Product, "name"> }
      >(sql`
      SELECT
        oi.*,
        (
          SELECT
            JSON_OBJECT('name', p1.name)
          FROM
            product p1
          WHERE
            p1.id = oi.productId
        ) AS \`product\`
      FROM
        orderItem oi
      WHERE
        oi.sellerId = ${sellerId}
      LIMIT
        ${50}
    `);

      const salesMap = new Map<string, number>();
      for (const item of items) {
        const name = item.product.name;
        salesMap.set(name, (salesMap.get(name) || 0) + item.quantity);
      }

      return Array.from(salesMap.entries()).map(([productName, quantity]) => ({
        productName,
        quantity,
      }));
    });

    const fullText = await step.run("generate-recommendations", async () => {
      return generateProductRecommendations({
        sellerProducts,
        allCategories,
        recentSales,
      });
    });

    await step.run("stream-result", () => streamInsight(streamId, fullText));

    return { sellerId, streamId };
  },
);

export const generateFeedbackSummaryFn = inngest.createFunction(
  {
    id: "generate-feedback-summary",
    retries: 2,
    triggers: [{ event: "ai/feedback-summary" }],
  },
  async ({ event, step }) => {
    const { sellerId, streamId } = event.data as {
      sellerId: string;
      streamId: string;
    };

    const reviews = await step.run("fetch-seller-reviews", async () => {
      const sellerProducts = await rows<Pick<Product, "id" | "name">>(
        sql`SELECT p.id, p.name FROM product p WHERE p.sellerId = ${sellerId}`,
      );

      const productIds = sellerProducts.map((p) => p.id);
      const productMap = new Map(sellerProducts.map((p) => [p.id, p.name]));

      const allReviews = await rows<
        Pick<Review, "rating" | "comment" | "productId">
      >(
        sql`SELECT r.rating, r.comment, r.productId FROM review r WHERE r.productId IN (${inList(productIds)})`,
      );

      return allReviews.map((r) => ({
        rating: r.rating,
        comment: r.comment,
        productName: productMap.get(r.productId) || "Unknown",
      }));
    });

    if (reviews.length === 0) {
      await step.run("no-reviews", async () => {
        await streamInsight(
          streamId,
          "No reviews found for your products yet.",
        );
      });
      return { sellerId, streamId };
    }

    const fullText = await step.run("generate-summary", async () => {
      return generateFeedbackSummary(reviews);
    });

    await step.run("stream-result", () => streamInsight(streamId, fullText));

    return { sellerId, streamId };
  },
);
