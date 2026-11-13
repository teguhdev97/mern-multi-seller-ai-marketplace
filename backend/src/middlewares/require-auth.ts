import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import type { Request, Response, NextFunction } from "express";

declare global {
  namespace Express {
    interface Request {
      session?: typeof auth.$Infer.Session;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (session.user.banned) {
      return res.status(403).json({ error: "Account suspended" });
    }

    req.session = session;
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}
