import type { Request, Response, NextFunction } from "express";
import { sql, one } from "../db/pool.js";
import type { Seller } from "../db/models.js";

export async function requireSeller(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const session = (req as any).session;

    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (session.user.role !== "seller") {
      return res
        .status(403)
        .json({ error: "Forbidden: seller access required" });
    }

    const seller = await one<
      Pick<Seller, "approved" | "revokedAt" | "revokedReason">
    >(
      sql`SELECT s.approved, s.revokedAt, s.revokedReason FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );

    if (!seller || !seller.approved) {
      if (seller?.revokedAt) {
        return res.status(403).json({
          error: "Your seller account has been revoked.",
          revoked: true,
          revokedAt: seller.revokedAt,
          revokedReason: seller.revokedReason,
        });
      }
      return res.status(403).json({
        error: "Your seller account is pending approval.",
        revoked: false,
      });
    }

    next();
  } catch (error) {
    console.error("requireSeller error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
