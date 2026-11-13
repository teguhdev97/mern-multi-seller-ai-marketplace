import { Router } from "express";
import { UTApi } from "uploadthing/server";
import { one, sql, write } from "../db/pool.js";
import { requireAuth } from "../middlewares/require-auth.js";

const router = Router();
const utapi = process.env.UPLOADTHING_TOKEN ? new UTApi() : null;

router.delete("/", requireAuth, async (req, res) => {
  try {
    const { fileKey } = req.body;
    if (typeof fileKey !== "string" || !fileKey || fileKey.length > 255) {
      return res.status(400).json({ error: "Invalid file key" });
    }

    const userId = req.session!.user.id;
    const file = await one(sql`
      SELECT fileKey FROM uploadedFile WHERE fileKey = ${fileKey} AND userId = ${userId}
    `);
    if (!file) return res.status(404).json({ error: "File not found" });
    if (!utapi)
      return res.status(503).json({ error: "Uploads are unavailable" });

    const result = await utapi.deleteFiles(fileKey);
    if (!result.success)
      return res.status(502).json({ error: "Failed to delete file" });

    await write(
      sql`DELETE FROM uploadedFile WHERE fileKey = ${fileKey} AND userId = ${userId}`,
    );
    return res.json({ success: true });
  } catch (error) {
    console.error("Error deleting file:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
