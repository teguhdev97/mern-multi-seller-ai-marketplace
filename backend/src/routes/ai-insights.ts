import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../middlewares/require-auth.js";
import { requireSeller } from "../middlewares/require-seller.js";
import { inngest, inngestEnabled } from "../inngest/client.js";
import { sql, one, rows, write, insertRow } from "../db/pool.js";
import type { Seller, AiInsight, AiInsightStream } from "../db/models.js";

const router = Router();

router.post(
  "/recommendations",
  requireAuth,
  requireSeller,
  async (req: Request, res: Response) => {
    const session = (req as any).session;
    const seller = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );

    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }

    if (!inngestEnabled || !process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: "AI insights are unavailable" });
    }

    const stream = await insertRow<AiInsightStream>(
      (id) => sql`
      INSERT INTO
        aiInsightStream (id, sellerId, type, status, chunks)
      VALUES
        (${id}, ${seller.id}, ${"recommendations"}, ${"processing"}, ${"[]"})
    `,
      (id) => sql`SELECT ais.* FROM aiInsightStream ais WHERE ais.id = ${id}`,
    );

    try {
      await inngest.send({
        name: "ai/product-recommendations",
        data: { sellerId: seller.id, streamId: stream.id },
      });
    } catch (error) {
      console.error("Could not queue AI insight", error);
      await write(
        sql`UPDATE aiInsightStream SET status = 'error' WHERE id = ${stream.id}`,
      );
      return res.status(503).json({ error: "AI insights are unavailable" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    res.write("data: " + JSON.stringify({ type: "started" }) + "\n\n");

    let lastChunkIndex = 0;
    let isDone = false;

    const pollInterval = setInterval(async () => {
      try {
        const current = await one<AiInsightStream>(
          sql`SELECT ais.* FROM aiInsightStream ais WHERE ais.id = ${stream.id} LIMIT 1`,
        );

        if (!current) return;

        const chunks = current.chunks;

        if (chunks.length > lastChunkIndex) {
          const newChunks = chunks.slice(lastChunkIndex);
          for (const chunk of newChunks) {
            if (chunk) {
              res.write(
                "data: " +
                  JSON.stringify({ type: "chunk", content: chunk }) +
                  "\n\n",
              );
            }
          }
          lastChunkIndex = chunks.length;
        }

        if (current.status === "complete" && !isDone) {
          isDone = true;
          clearInterval(pollInterval);
          res.write("data: " + JSON.stringify({ type: "done" }) + "\n\n");
          res.end();
        } else if (current.status === "error" && !isDone) {
          isDone = true;
          clearInterval(pollInterval);
          res.write(
            "data: " +
              JSON.stringify({
                type: "error",
                message: current.error || "Unknown error",
              }) +
              "\n\n",
          );
          res.end();
        }
      } catch {
        // DB read error, will retry on next poll
      }
    }, 200);

    const deadline = setTimeout(() => {
      clearInterval(pollInterval);
      res.end(
        "data: " +
          JSON.stringify({ type: "error", message: "AI insight timed out" }) +
          "\n\n",
      );
    }, 120_000);
    res.on("close", () => {
      clearInterval(pollInterval);
      clearTimeout(deadline);
    });
  },
);

router.post(
  "/feedback-summary",
  requireAuth,
  requireSeller,
  async (req: Request, res: Response) => {
    const session = (req as any).session;
    const seller = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );

    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }

    if (!inngestEnabled || !process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: "AI insights are unavailable" });
    }

    const stream = await insertRow<AiInsightStream>(
      (id) => sql`
      INSERT INTO
        aiInsightStream (id, sellerId, type, status, chunks)
      VALUES
        (${id}, ${seller.id}, ${"feedback"}, ${"processing"}, ${"[]"})
    `,
      (id) => sql`SELECT ais.* FROM aiInsightStream ais WHERE ais.id = ${id}`,
    );

    try {
      await inngest.send({
        name: "ai/feedback-summary",
        data: { sellerId: seller.id, streamId: stream.id },
      });
    } catch (error) {
      console.error("Could not queue AI insight", error);
      await write(
        sql`UPDATE aiInsightStream SET status = 'error' WHERE id = ${stream.id}`,
      );
      return res.status(503).json({ error: "AI insights are unavailable" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    res.write("data: " + JSON.stringify({ type: "started" }) + "\n\n");

    let lastChunkIndex = 0;
    let isDone = false;

    const pollInterval = setInterval(async () => {
      try {
        const current = await one<AiInsightStream>(
          sql`SELECT ais.* FROM aiInsightStream ais WHERE ais.id = ${stream.id} LIMIT 1`,
        );

        if (!current) return;

        const chunks = current.chunks;

        if (chunks.length > lastChunkIndex) {
          const newChunks = chunks.slice(lastChunkIndex);
          for (const chunk of newChunks) {
            if (chunk) {
              res.write(
                "data: " +
                  JSON.stringify({ type: "chunk", content: chunk }) +
                  "\n\n",
              );
            }
          }
          lastChunkIndex = chunks.length;
        }

        if (current.status === "complete" && !isDone) {
          isDone = true;
          clearInterval(pollInterval);
          res.write("data: " + JSON.stringify({ type: "done" }) + "\n\n");
          res.end();
        } else if (current.status === "error" && !isDone) {
          isDone = true;
          clearInterval(pollInterval);
          res.write(
            "data: " +
              JSON.stringify({
                type: "error",
                message: current.error || "Unknown error",
              }) +
              "\n\n",
          );
          res.end();
        }
      } catch {
        // DB read error, will retry on next poll
      }
    }, 200);

    const deadline = setTimeout(() => {
      clearInterval(pollInterval);
      res.end(
        "data: " +
          JSON.stringify({ type: "error", message: "AI insight timed out" }) +
          "\n\n",
      );
    }, 120_000);
    res.on("close", () => {
      clearInterval(pollInterval);
      clearTimeout(deadline);
    });
  },
);

router.get(
  "/history",
  requireAuth,
  requireSeller,
  async (req: Request, res: Response) => {
    const session = (req as any).session;
    const seller = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );

    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }

    const type =
      typeof req.query.type === "string" ? req.query.type : undefined;

    const insights = await rows<AiInsight>(sql`
      SELECT
        ai.*
      FROM
        aiInsight ai
      WHERE
        ai.sellerId = ${seller.id}
        AND (
          ${type ?? null} IS NULL
          OR ai.type = ${type ?? null}
        )
      ORDER BY
        ai.createdAt DESC
      LIMIT
        ${20}
    `);

    res.json({ insights });
  },
);

export default router;
