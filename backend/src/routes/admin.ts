import { Router } from "express";
import {
  sql,
  one,
  rows,
  scalar,
  write,
  updateRow,
  inList,
  assignments,
  transaction,
  joinSql,
} from "../db/pool.js";
import type { User, Seller, Product, Order, Review } from "../db/models.js";
import { requireAuth } from "../middlewares/require-auth.js";
import { requireAdmin } from "../middlewares/require-admin.js";
import { sendNotification } from "../inngest/client.js";

const router = Router();

router.get("/sellers", requireAuth, requireAdmin, async (req, res) => {
  try {
    const raw = req.query as Record<string, string | string[] | undefined>;
    const pageRaw = raw.page;
    const limitRaw = raw.limit;
    const searchRaw = raw.search;
    const approvedRaw = raw.approved;

    const pageStr: string = Array.isArray(pageRaw)
      ? String(pageRaw[0] ?? "1")
      : String(pageRaw ?? "1");
    const limitStr: string = Array.isArray(limitRaw)
      ? String(limitRaw[0] ?? "10")
      : String(limitRaw ?? "10");
    const searchStr: string = Array.isArray(searchRaw)
      ? String(searchRaw[0] ?? "")
      : String(searchRaw ?? "");
    const approvedStr: string | undefined = Array.isArray(approvedRaw)
      ? approvedRaw[0]
      : approvedRaw;

    const pageNum = Math.max(1, parseInt(pageStr, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limitStr, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const filters = [sql`TRUE`];
    if (searchStr) {
      filters.push(sql`(LOCATE(LOWER(${searchStr}), LOWER(s.name)) > 0
          OR LOCATE(LOWER(${searchStr}), LOWER(s.username)) > 0
          OR EXISTS (SELECT 1 FROM \`user\` u WHERE u.id = s.userId
            AND LOCATE(LOWER(${searchStr}), LOWER(u.email)) > 0))`);
    }
    if (approvedStr !== undefined && approvedStr !== "")
      filters.push(sql`s.approved = ${approvedStr === "true"}`);
    const where = joinSql(filters, " AND ");

    const [sellers, total] = await Promise.all([
      rows<
        Seller & {
          user: Pick<User, "id" | "name" | "email" | "image" | "createdAt">;
          _count: { products: number };
        }
      >(sql`
      SELECT
        s.*,
        (
          SELECT
            JSON_OBJECT(
              'id',
              u1.id,
              'name',
              u1.name,
              'email',
              u1.email,
              'image',
              u1.image,
              'createdAt',
              u1.createdAt
            )
          FROM
            \`user\` u1
          WHERE
            u1.id = s.userId
        ) AS \`user\`,
        JSON_OBJECT(
          'products',
          (
            SELECT
              COUNT(*)
            FROM
              product p2
            WHERE
              p2.sellerId = s.id
          )
        ) AS \`_count\`
      FROM
        seller s
      WHERE
        ${where}
      ORDER BY
        s.createdAt DESC
      LIMIT
        ${limitNum}
      OFFSET
        ${skip}
    `),
      scalar(sql`SELECT COUNT(*) AS value FROM seller s WHERE ${where}`),
    ]);

    return res.json({
      sellers,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    console.error("List sellers error:", error);
    return res.status(500).json({ error: "Failed to list sellers" });
  }
});

router.patch(
  "/sellers/:id/approve",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.id);

      const seller = await one<
        Seller & { user: Pick<User, "name" | "email"> }
      >(sql`
      SELECT
        s.*,
        (
          SELECT
            JSON_OBJECT('name', u1.name, 'email', u1.email)
          FROM
            \`user\` u1
          WHERE
            u1.id = s.userId
        ) AS \`user\`
      FROM
        seller s
      WHERE
        s.id = ${id}
      LIMIT
        1
    `);
      if (!seller) return res.status(404).json({ error: "Seller not found" });

      const updated = await updateRow<Seller>(
        sql`s.approved = ${true}, s.revokedAt = ${null}, s.revokedReason = ${null}`,
        (fields) => sql`UPDATE seller s SET ${fields} WHERE s.id = ${id}`,
        sql`SELECT s.* FROM seller s WHERE s.id = ${id}`,
      );

      if (seller.user.email) {
        await sendNotification({
          name: "app/seller.approved",
          data: {
            to: seller.user.email,
            sellerName: seller.user.name || seller.name,
          },
        });
      }

      return res.json({ seller: updated });
    } catch (error) {
      console.error("Approve seller error:", error);
      return res.status(500).json({ error: "Failed to approve seller" });
    }
  },
);

router.patch(
  "/sellers/:id/reject",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.id);
      const { reason } = req.body as { reason?: string };

      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        return res
          .status(400)
          .json({ error: "A reason is required to reject a seller" });
      }
      if (reason.trim().length > 500) {
        return res
          .status(400)
          .json({ error: "Reason must be under 500 characters" });
      }

      const seller = await one<
        Seller & { user: Pick<User, "name" | "email"> }
      >(sql`
      SELECT
        s.*,
        (
          SELECT
            JSON_OBJECT('name', u1.name, 'email', u1.email)
          FROM
            \`user\` u1
          WHERE
            u1.id = s.userId
        ) AS \`user\`
      FROM
        seller s
      WHERE
        s.id = ${id}
      LIMIT
        1
    `);
      if (!seller) return res.status(404).json({ error: "Seller not found" });

      const updated = await transaction(async (connection) => {
        await write(
          sql`UPDATE seller SET approved = FALSE, revokedAt = ${new Date()},
          revokedReason = ${reason.trim()} WHERE id = ${id}`,
          connection,
        );
        await write(
          sql`UPDATE product SET status = 'archived' WHERE sellerId = ${id} AND status <> 'archived'`,
          connection,
        );
        return one<Seller>(
          sql`SELECT * FROM seller WHERE id = ${id}`,
          connection,
        );
      });

      if (seller.user.email) {
        await sendNotification({
          name: "app/seller.rejected",
          data: {
            to: seller.user.email,
            sellerName: seller.user.name || seller.name,
            reason: reason.trim(),
          },
        });
      }

      return res.json({ seller: updated });
    } catch (error) {
      console.error("Reject seller error:", error);
      return res.status(500).json({ error: "Failed to reject seller" });
    }
  },
);

router.patch(
  "/sellers/:id/ban",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.id);
      const { banned } = req.body as { banned: boolean };

      const seller = await one<Seller>(
        sql`SELECT s.* FROM seller s WHERE s.id = ${id} LIMIT 1`,
      );
      if (!seller) return res.status(404).json({ error: "Seller not found" });

      await updateRow<User>(
        sql`u.banned = ${banned}`,
        (fields) =>
          sql`UPDATE \`user\` u SET ${fields} WHERE u.id = ${seller.userId}`,
        sql`SELECT u.* FROM \`user\` u WHERE u.id = ${seller.userId}`,
      );

      return res.json({ success: true });
    } catch (error) {
      console.error("Ban seller error:", error);
      return res.status(500).json({ error: "Failed to update seller" });
    }
  },
);

// ─── Users ──────────────────────────────────────────────────────────────────

router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const raw = req.query as Record<string, string | string[] | undefined>;
    const pageRaw = raw.page;
    const limitRaw = raw.limit;
    const searchRaw = raw.search;
    const roleRaw = raw.role;

    const pageStr: string = Array.isArray(pageRaw)
      ? String(pageRaw[0] ?? "1")
      : String(pageRaw ?? "1");
    const limitStr: string = Array.isArray(limitRaw)
      ? String(limitRaw[0] ?? "10")
      : String(limitRaw ?? "10");
    const searchStr: string = Array.isArray(searchRaw)
      ? String(searchRaw[0] ?? "")
      : String(searchRaw ?? "");
    const roleStr: string = Array.isArray(roleRaw)
      ? String(roleRaw[0] ?? "")
      : String(roleRaw ?? "");

    const pageNum = Math.max(1, parseInt(pageStr, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limitStr, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const filters = [sql`TRUE`];
    if (searchStr) {
      filters.push(sql`(LOCATE(LOWER(${searchStr}), LOWER(u.name)) > 0
          OR LOCATE(LOWER(${searchStr}), LOWER(u.email)) > 0)`);
    }
    if (["buyer", "seller", "admin"].includes(roleStr))
      filters.push(sql`u.role = ${roleStr}`);
    const where = joinSql(filters, " AND ");

    const [users, total] = await Promise.all([
      rows<
        Pick<
          User,
          "id" | "name" | "email" | "image" | "role" | "banned" | "createdAt"
        > & {
          seller: Pick<Seller, "id" | "name" | "username" | "approved"> | null;
        }
      >(sql`
      SELECT
        u.id,
        u.name,
        u.email,
        u.image,
        u.role,
        u.banned,
        u.createdAt,
        (
          SELECT
            JSON_OBJECT(
              'id',
              s1.id,
              'name',
              s1.name,
              'username',
              s1.username,
              'approved',
              s1.approved
            )
          FROM
            seller s1
          WHERE
            s1.userId = u.id
        ) AS \`seller\`
      FROM
        \`user\` u
      WHERE
        ${where}
      ORDER BY
        u.createdAt DESC
      LIMIT
        ${limitNum}
      OFFSET
        ${skip}
    `),
      scalar(sql`SELECT COUNT(*) AS value FROM \`user\` u WHERE ${where}`),
    ]);

    return res.json({
      users,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    console.error("List users error:", error);
    return res.status(500).json({ error: "Failed to list users" });
  }
});

router.patch("/users/:id/ban", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const { banned } = req.body as { banned: boolean };
    const session = req.session as { user: { id: string } };

    if (id === session.user.id) {
      return res.status(400).json({ error: "You cannot ban your own account" });
    }

    const user = await one<User & { seller: Pick<Seller, "id"> | null }>(sql`
      SELECT
        u.*,
        (
          SELECT
            JSON_OBJECT('id', s1.id)
          FROM
            seller s1
          WHERE
            s1.userId = u.id
        ) AS \`seller\`
      FROM
        \`user\` u
      WHERE
        u.id = ${id}
      LIMIT
        1
    `);
    if (!user) return res.status(404).json({ error: "User not found" });

    await updateRow<User>(
      sql`u.banned = ${banned}`,
      (fields) => sql`UPDATE \`user\` u SET ${fields} WHERE u.id = ${id}`,
      sql`SELECT u.* FROM \`user\` u WHERE u.id = ${id}`,
    );

    if (banned && user.email) {
      await sendNotification({
        name: "app/user.banned",
        data: {
          to: user.email,
          userName: user.name || "User",
        },
      });
    }

    if (user.seller) {
      if (banned) {
        await write(
          sql`UPDATE product p SET p.status = ${"archived"} WHERE p.sellerId = ${user.seller.id} AND p.status <> ${"archived"}`,
        );
      } else {
        await write(
          sql`UPDATE product p SET p.status = ${"active"} WHERE p.sellerId = ${user.seller.id} AND p.status = ${"archived"}`,
        );
      }
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Ban user error:", error);
    return res.status(500).json({ error: "Failed to update user" });
  }
});

// ─── Products ───────────────────────────────────────────────────────────────

const VALID_CATEGORIES = [
  "fashion",
  "electronics",
  "beauty",
  "fitness",
  "home-decor",
  "accessories",
];
const VALID_STATUSES = ["draft", "active", "archived", "rejected"];
const REJECTABLE_STATUSES = ["active", "draft"];

router.get("/products", requireAuth, requireAdmin, async (req, res) => {
  try {
    const raw = req.query as Record<string, string | string[] | undefined>;
    const pageRaw = raw.page;
    const limitRaw = raw.limit;
    const searchRaw = raw.search;
    const categoryRaw = raw.category;
    const statusRaw = raw.status;

    const pageStr: string = Array.isArray(pageRaw)
      ? String(pageRaw[0] ?? "1")
      : String(pageRaw ?? "1");
    const limitStr: string = Array.isArray(limitRaw)
      ? String(limitRaw[0] ?? "10")
      : String(limitRaw ?? "10");
    const searchStr: string = Array.isArray(searchRaw)
      ? String(searchRaw[0] ?? "")
      : String(searchRaw ?? "");
    const categoryStr: string = Array.isArray(categoryRaw)
      ? String(categoryRaw[0] ?? "")
      : String(categoryRaw ?? "");
    const statusStr: string = Array.isArray(statusRaw)
      ? String(statusRaw[0] ?? "")
      : String(statusRaw ?? "");

    const pageNum = Math.max(1, parseInt(pageStr, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limitStr, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const filters = [sql`TRUE`];
    if (searchStr) {
      filters.push(sql`(LOCATE(LOWER(${searchStr}), LOWER(p.name)) > 0
          OR LOCATE(LOWER(${searchStr}), LOWER(p.description)) > 0)`);
    }
    if (VALID_CATEGORIES.includes(categoryStr))
      filters.push(sql`p.category = ${categoryStr}`);
    if (VALID_STATUSES.includes(statusStr))
      filters.push(sql`p.status = ${statusStr}`);
    const where = joinSql(filters, " AND ");

    const [products, total] = await Promise.all([
      rows<
        Product & {
          seller: Pick<Seller, "id" | "name" | "username" | "approved">;
          _count: { reviews: number };
        }
      >(sql`
      SELECT
        p.*,
        (
          SELECT
            JSON_OBJECT(
              'id',
              s1.id,
              'name',
              s1.name,
              'username',
              s1.username,
              'approved',
              s1.approved
            )
          FROM
            seller s1
          WHERE
            s1.id = p.sellerId
        ) AS \`seller\`,
        JSON_OBJECT(
          'reviews',
          (
            SELECT
              COUNT(*)
            FROM
              review r2
            WHERE
              r2.productId = p.id
          )
        ) AS \`_count\`
      FROM
        product p
      WHERE
        ${where}
      ORDER BY
        p.createdAt DESC
      LIMIT
        ${limitNum}
      OFFSET
        ${skip}
    `),
      scalar(sql`SELECT COUNT(*) AS value FROM product p WHERE ${where}`),
    ]);

    const productIds = products.map((p) => p.id);
    let ratingMap = new Map<string, { avg: number; total: number }>();
    if (productIds.length) {
      const reviews = await rows<Pick<Review, "productId" | "rating">>(
        sql`SELECT r.productId, r.rating FROM review r WHERE r.productId IN (${inList(productIds)})`,
      );
      const rMap = new Map<string, number[]>();
      for (const r of reviews) {
        const arr = rMap.get(r.productId) ?? [];
        arr.push(r.rating);
        rMap.set(r.productId, arr);
      }
      for (const [pid, ratings] of rMap) {
        const totalR = ratings.length;
        const avg = totalR ? ratings.reduce((s, v) => s + v, 0) / totalR : 0;
        ratingMap.set(pid, { avg: Number(avg.toFixed(1)), total: totalR });
      }
    }

    const enriched = products.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      discount: p.discount,
      category: p.category,
      images: p.images,
      stock: p.stock,
      sizes: p.sizes,
      colors: p.colors,
      gender: p.gender,
      status: p.status,
      rejectionReason: p.rejectionReason,
      sellerId: p.sellerId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      seller: p.seller,
      avgRating: ratingMap.get(p.id)?.avg ?? 0,
      totalReviews: ratingMap.get(p.id)?.total ?? 0,
    }));

    return res.json({
      products: enriched,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    console.error("List admin products error:", error);
    return res.status(500).json({ error: "Failed to list products" });
  }
});

router.patch(
  "/products/:id/status",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.id);
      const { status, reason } = req.body as {
        status?: string;
        reason?: string;
      };

      if (!status || !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }

      if (status === "rejected") {
        if (
          !reason ||
          typeof reason !== "string" ||
          reason.trim().length === 0
        ) {
          return res
            .status(400)
            .json({ error: "A reason is required to reject a product" });
        }
        if (reason.trim().length > 500) {
          return res
            .status(400)
            .json({ error: "Reason must be under 500 characters" });
        }
      }

      const product = await one<Product>(
        sql`SELECT p.* FROM product p WHERE p.id = ${id} LIMIT 1`,
      );
      if (!product) return res.status(404).json({ error: "Product not found" });

      const updateData: Partial<Pick<Product, "status" | "rejectionReason">> = {
        status,
      };
      if (status === "rejected") {
        updateData.rejectionReason = reason!.trim();
      } else {
        updateData.rejectionReason = null;
      }

      const updated = await updateRow<
        Product & {
          seller: Pick<Seller, "id" | "name" | "username" | "approved">;
        }
      >(
        assignments([
          [sql`p.status`, updateData.status],
          [sql`p.rejectionReason`, updateData.rejectionReason],
        ]),
        (fields) => sql`UPDATE product p SET ${fields} WHERE p.id = ${id}`,
        sql`
      SELECT
        p.*,
        (
          SELECT
            JSON_OBJECT(
              'id',
              s1.id,
              'name',
              s1.name,
              'username',
              s1.username,
              'approved',
              s1.approved
            )
          FROM
            seller s1
          WHERE
            s1.id = p.sellerId
        ) AS \`seller\`
      FROM
        product p
      WHERE
        p.id = ${id}
    `,
      );

      if (status === "rejected" && updated.seller) {
        const sellerUser = await one<Pick<User, "email">>(
          sql`SELECT u.email FROM \`user\` u WHERE u.id = (SELECT userId FROM seller WHERE id = ${updated.sellerId}) LIMIT 1`,
        );
        if (sellerUser?.email) {
          await sendNotification({
            name: "app/product.rejected",
            data: {
              to: sellerUser.email,
              productName: product.name,
              reason: reason!.trim(),
            },
          });
        }
      }

      if (
        status === "active" &&
        product.status === "rejected" &&
        updated.seller
      ) {
        const sellerUser = await one<Pick<User, "email">>(
          sql`SELECT u.email FROM \`user\` u WHERE u.id = (SELECT userId FROM seller WHERE id = ${updated.sellerId}) LIMIT 1`,
        );
        if (sellerUser?.email) {
          await sendNotification({
            name: "app/product.approved",
            data: {
              to: sellerUser.email,
              productName: product.name,
            },
          });
        }
      }

      return res.json({ product: updated });
    } catch (error) {
      console.error("Update product status error:", error);
      return res.status(500).json({ error: "Failed to update product status" });
    }
  },
);

// ─── Stats ──────────────────────────────────────────────────────────────────

router.get("/stats", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [
      totalUsers,
      totalSellers,
      pendingSellers,
      totalProducts,
      totalOrders,
      revenueResult,
    ] = await Promise.all([
      scalar(sql`SELECT COUNT(*) AS value FROM \`user\` u`),
      scalar(sql`SELECT COUNT(*) AS value FROM seller s`),
      scalar(
        sql`SELECT COUNT(*) AS value FROM seller s WHERE s.approved = ${false} AND s.revokedAt IS NULL`,
      ),
      scalar(sql`SELECT COUNT(*) AS value FROM product p`),
      scalar(
        sql`SELECT COUNT(*) AS value FROM \`order\` o WHERE o.status <> ${"cancelled"}`,
      ),
      one<{ _sum_total: number | null }>(
        sql`SELECT SUM(o.total) AS _sum_total FROM \`order\` o WHERE o.status <> ${"cancelled"}`,
      ).then((row) => ({ _sum: { total: row?._sum_total ?? null } })),
    ]);

    const totalRevenue =
      Math.round((revenueResult._sum.total ?? 0) * 100) / 100;

    // Sales over time — last 30 days
    const todayUTC = new Date();
    todayUTC.setUTCHours(0, 0, 0, 0);
    const startUTC = new Date(todayUTC);
    startUTC.setUTCDate(todayUTC.getUTCDate() - 29);

    const orders = await rows<Pick<Order, "id" | "total" | "createdAt">>(sql`
      SELECT
        o.id,
        o.total,
        o.createdAt
      FROM
        \`order\` o
      WHERE
        o.status <> ${"cancelled"}
        AND o.createdAt >= ${startUTC}
    `);

    const dayMap = new Map<string, { revenue: number; orders: Set<string> }>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(startUTC);
      d.setUTCDate(startUTC.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      dayMap.set(key, { revenue: 0, orders: new Set() });
    }

    for (const o of orders) {
      const key = new Date(o.createdAt).toISOString().slice(0, 10);
      const entry = dayMap.get(key);
      if (!entry) continue;
      entry.revenue += o.total;
      entry.orders.add(o.id);
    }

    const salesOverTime = Array.from(dayMap.entries()).map(([date, v]) => ({
      date,
      revenue: Math.round(v.revenue * 100) / 100,
      orders: v.orders.size,
    }));

    // Recent pending sellers
    const recentPendingSellers = await rows<
      Pick<Seller, "id" | "name" | "username" | "createdAt"> & {
        user: Pick<User, "name" | "email">;
      }
    >(sql`
      SELECT
        s.id,
        s.name,
        s.username,
        s.createdAt,
        (
          SELECT
            JSON_OBJECT('name', u1.name, 'email', u1.email)
          FROM
            \`user\` u1
          WHERE
            u1.id = s.userId
        ) AS \`user\`
      FROM
        seller s
      WHERE
        s.approved = ${false}
        AND s.revokedAt IS NULL
      ORDER BY
        s.createdAt DESC
      LIMIT
        ${5}
    `);

    return res.json({
      totalUsers,
      totalSellers,
      pendingSellers,
      totalProducts,
      totalOrders,
      totalRevenue,
      salesOverTime,
      recentPendingSellers,
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    return res.status(500).json({ error: "Failed to fetch admin stats" });
  }
});

export default router;
