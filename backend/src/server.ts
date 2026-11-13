import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { createRouteHandler } from "uploadthing/express";
import { serve } from "inngest/express";
import { pool } from "./db/pool.js";
import { inngestEnabled } from "./inngest/client.js";
import { auth } from "./lib/auth.js";
import { uploadRouter } from "./lib/uploadthing.js";
import { inngest, functions } from "./inngest/index.js";
import sellerRoutes from "./routes/seller.js";
import filesRoutes from "./routes/files.js";
import productRoutes from "./routes/product.js";
import orderRoutes from "./routes/order.js";
import promoRoutes from "./routes/promo.js";
import reviewRoutes from "./routes/review.js";
import userRoutes from "./routes/user.js";
import adminRoutes from "./routes/admin.js";
import aiInsightsRoutes from "./routes/ai-insights.js";

const app = express();
const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || "127.0.0.1";

if (process.env.DB_CONNECTION && process.env.DB_CONNECTION !== "mysql") {
  throw new Error("DB_CONNECTION must be mysql");
}
if (process.env.NODE_ENV === "production") {
  for (const name of [
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "FRONTEND_URL",
    "DB_DATABASE",
    "DB_USERNAME",
    "DB_PASSWORD",
  ]) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  app.set("trust proxy", "loopback");
}
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

app.use(helmet());

// Global CORS
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.use(morgan("dev"));

app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

if (inngestEnabled)
  app.use("/api/inngest", serve({ client: inngest, functions }));

if (process.env.UPLOADTHING_TOKEN) {
  app.use("/api/uploadthing", createRouteHandler({ router: uploadRouter }));
} else {
  app.use("/api/uploadthing", (_req, res) =>
    res.status(503).json({ error: "Uploads are unavailable" }),
  );
}

app.get("/", (_req, res) => {
  res.status(200).json({ message: "API is running", status: "ok" });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1 FROM product LIMIT 1");
    res.json({ status: "ok", database: "ready" });
  } catch (error) {
    console.error("Database health check failed", error);
    res.status(503).json({ status: "unavailable", database: "unavailable" });
  }
});

app.get("/api/me", async (req, res) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  return res.json(session);
});

app.use("/api/seller", sellerRoutes);
app.use("/api/files", filesRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/promos", promoRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/user", userRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/seller/ai-insights", aiInsightsRoutes);

app.listen(PORT, HOST, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
