import { Router } from "express";
import {
  sql,
  one,
  rows,
  scalar,
  insertRow,
  updateRow,
  inList,
  assignments,
} from "../db/pool.js";
import type {
  User,
  Seller,
  Product,
  Order,
  OrderItem,
  Review,
} from "../db/models.js";
import { requireAuth } from "../middlewares/require-auth.js";
import { requireSeller } from "../middlewares/require-seller.js";

const RESERVED_USERNAMES = new Set([
  "seller",
  "checkout",
  "product",
  "products",
  "login",
  "signup",
  "admin",
  "api",
  "s",
  "u",
  "cart",
  "wishlist",
  "shop",
  "order-confirmation",
  "orders",
  "settings",
  "promos",
]);

function slugifyUsername(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
}

function isValidUsername(username: string) {
  return /^[a-z0-9_-]{3,20}$/.test(username);
}

async function generateUniqueUsername(base: string) {
  let slug = slugifyUsername(base);
  if (!slug || slug.length < 3) slug = "seller";
  if (RESERVED_USERNAMES.has(slug)) slug = `${slug}-store`;
  let candidate = slug;
  let suffix = 1;
  while (
    await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.username = ${candidate} LIMIT 1`,
    )
  ) {
    const suffixStr = `-${suffix}`;
    candidate = `${slug.slice(0, 20 - suffixStr.length)}${suffixStr}`;
    suffix++;
    if (suffix > 100) break;
  }
  return candidate;
}

const router = Router();

router.get("/by-username/:username", async (req, res) => {
  try {
    const username = String(req.params.username).toLowerCase().trim();
    const seller = await one<
      Seller & { user: Pick<User, "id" | "name" | "image"> }
    >(sql`
      SELECT
        s.*,
        (
          SELECT
            JSON_OBJECT('id', u1.id, 'name', u1.name, 'image', u1.image)
          FROM
            \`user\` u1
          WHERE
            u1.id = s.userId
        ) AS \`user\`
      FROM
        seller s
      WHERE
        s.username = ${username}
      LIMIT
        1
    `);
    if (!seller) return res.status(404).json({ error: "Seller not found" });

    const products = await rows<
      Product & { seller: Pick<Seller, "id" | "name" | "image" | "username"> }
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
              'image',
              s1.image,
              'username',
              s1.username
            )
          FROM
            seller s1
          WHERE
            s1.id = p.sellerId
        ) AS \`seller\`
      FROM
        product p
      WHERE
        p.sellerId = ${seller.id}
        AND p.status = ${"active"}
      ORDER BY
        p.createdAt DESC
      LIMIT
        ${20}
    `);

    const reviews = await rows<
      Review & {
        user: Pick<User, "id" | "name" | "image">;
        product: Pick<Product, "id" | "name" | "images">;
      }
    >(sql`
      SELECT
        r.*,
        (
          SELECT
            JSON_OBJECT('id', u2.id, 'name', u2.name, 'image', u2.image)
          FROM
            \`user\` u2
          WHERE
            u2.id = r.userId
        ) AS \`user\`,
        (
          SELECT
            JSON_OBJECT('id', p3.id, 'name', p3.name, 'images', JSON_EXTRACT(p3.images, '$'))
          FROM
            product p3
          WHERE
            p3.id = r.productId
        ) AS \`product\`
      FROM
        review r
      WHERE
        EXISTS (
          SELECT
            1
          FROM
            product p1
          WHERE
            p1.id = r.productId
            AND p1.sellerId = ${seller.id}
            AND p1.status = ${"active"}
        )
      ORDER BY
        r.createdAt DESC
      LIMIT
        ${20}
    `);

    const agg = await one<{
      _avg_rating: number | null;
      _count_rating: number | null;
    }>(sql`
      SELECT
        AVG(r.rating) AS _avg_rating,
        COUNT(r.rating) AS _count_rating
      FROM
        review r
      WHERE
        EXISTS (
          SELECT
            1
          FROM
            product p1
          WHERE
            p1.id = r.productId
            AND p1.sellerId = ${seller.id}
            AND p1.status = ${"active"}
        )
    `).then((row) => ({
      _avg: { rating: row?._avg_rating ?? null },
      _count: { rating: row?._count_rating ?? 0 },
    }));

    const avgRating = agg._avg.rating ? Number(agg._avg.rating.toFixed(1)) : 0;
    const totalReviews = agg._count.rating ?? 0;
    const productCount = await scalar(
      sql`SELECT COUNT(*) AS value FROM product p WHERE p.sellerId = ${seller.id} AND p.status = ${"active"}`,
    );

    return res.json({
      seller,
      products,
      reviews,
      avgRating,
      totalReviews,
      productCount,
    });
  } catch (error) {
    console.error("Error fetching seller by username:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/check-username/:username", async (req, res) => {
  try {
    const username = String(req.params.username).toLowerCase().trim();
    if (!isValidUsername(username))
      return res.json({
        available: false,
        reason: "Invalid format (3-20 chars, a-z 0-9 _ -)",
      });
    if (RESERVED_USERNAMES.has(username))
      return res.json({ available: false, reason: "Reserved username" });
    const existing = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.username = ${username} LIMIT 1`,
    );
    return res.json({ available: !existing });
  } catch (error) {
    return res.status(500).json({ error: "Failed to check username" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const session = (req as any).session;

    if (session.user.role !== "buyer") {
      return res.status(403).json({ error: "Only buyers can become sellers" });
    }

    const existingSeller = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );

    if (existingSeller) {
      return res.status(409).json({ error: "Seller profile already exists" });
    }

    const { name, image, description, username } = req.body as {
      name: string;
      image?: string | null;
      description?: string | null;
      username?: string;
    };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "Store name is required" });
    }

    let finalUsername: string;
    if (username && typeof username === "string" && username.trim()) {
      const lower = username.toLowerCase().trim();
      if (!isValidUsername(lower))
        return res
          .status(400)
          .json({ error: "Username must be 3-20 chars, a-z 0-9 _ -" });
      if (RESERVED_USERNAMES.has(lower))
        return res.status(400).json({ error: "Username is reserved" });
      const taken = await one<Seller>(
        sql`SELECT s.* FROM seller s WHERE s.username = ${lower} LIMIT 1`,
      );
      if (taken)
        return res.status(409).json({ error: "Username already taken" });
      finalUsername = lower;
    } else {
      finalUsername = await generateUniqueUsername(name);
    }

    const seller = await insertRow<Seller>(
      (id) => sql`
      INSERT INTO
        seller (id, userId, username, name, image, description)
      VALUES
        (
          ${id},
          ${session.user.id},
          ${finalUsername},
          ${name.trim()},
          ${image || null},
          ${description?.trim() || null}
        )
    `,
      (id) => sql`SELECT s.* FROM seller s WHERE s.id = ${id}`,
    );

    await updateRow<User>(
      sql`u.role = ${"seller"}`,
      (fields) =>
        sql`UPDATE \`user\` u SET ${fields} WHERE u.id = ${session.user.id}`,
      sql`SELECT u.* FROM \`user\` u WHERE u.id = ${session.user.id}`,
    );

    return res.status(201).json({ seller });
  } catch (error) {
    console.error("Error creating seller:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/stats", requireAuth, requireSeller, async (req, res) => {
  try {
    const session = (req as any).session;
    const seller = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );
    if (!seller)
      return res.status(404).json({ error: "Seller profile not found" });

    const [productCount, reviewAgg, orderItems] = await Promise.all([
      scalar(
        sql`SELECT COUNT(*) AS value FROM product p WHERE p.sellerId = ${seller.id} AND p.status <> ${"archived"}`,
      ),
      one<{ _avg_rating: number | null; _count_rating: number | null }>(sql`
      SELECT
        AVG(r.rating) AS _avg_rating,
        COUNT(r.rating) AS _count_rating
      FROM
        review r
      WHERE
        EXISTS (
          SELECT
            1
          FROM
            product p1
          WHERE
            p1.id = r.productId
            AND p1.sellerId = ${seller.id}
            AND p1.status <> ${"archived"}
        )
    `).then((row) => ({
        _avg: { rating: row?._avg_rating ?? null },
        _count: { rating: row?._count_rating ?? 0 },
      })),
      rows<
        Pick<OrderItem, "price" | "quantity" | "orderId" | "productId"> & {
          order: Pick<Order, "createdAt" | "status">;
          product: Pick<
            Product,
            | "id"
            | "name"
            | "description"
            | "images"
            | "price"
            | "discount"
            | "category"
            | "stock"
            | "sizes"
            | "colors"
            | "gender"
            | "createdAt"
            | "updatedAt"
            | "sellerId"
            | "status"
          > & { seller: Pick<Seller, "id" | "name" | "image" | "username"> };
        }
      >(sql`
      SELECT
        oi.price,
        oi.quantity,
        oi.orderId,
        oi.productId,
        (
          SELECT
            JSON_OBJECT('createdAt', o1.createdAt, 'status', o1.status)
          FROM
            \`order\` o1
          WHERE
            o1.id = oi.orderId
        ) AS \`order\`,
        (
          SELECT
            JSON_OBJECT(
              'id',
              p2.id,
              'name',
              p2.name,
              'description',
              p2.description,
              'images',
              JSON_EXTRACT(p2.images, '$'),
              'price',
              p2.price,
              'discount',
              p2.discount,
              'category',
              p2.category,
              'stock',
              p2.stock,
              'sizes',
              JSON_EXTRACT(p2.sizes, '$'),
              'colors',
              JSON_EXTRACT(p2.colors, '$'),
              'gender',
              p2.gender,
              'createdAt',
              p2.createdAt,
              'updatedAt',
              p2.updatedAt,
              'sellerId',
              p2.sellerId,
              'status',
              p2.status,
              'seller',
              JSON_EXTRACT(
                (
                  SELECT
                    JSON_OBJECT(
                      'id',
                      s3.id,
                      'name',
                      s3.name,
                      'image',
                      s3.image,
                      'username',
                      s3.username
                    )
                  FROM
                    seller s3
                  WHERE
                    s3.id = p2.sellerId
                ),
                '$'
              )
            )
          FROM
            product p2
          WHERE
            p2.id = oi.productId
        ) AS \`product\`
      FROM
        orderItem oi
      WHERE
        oi.sellerId = ${seller.id}
    `),
    ]);

    const avgRating = reviewAgg._avg.rating
      ? Number(reviewAgg._avg.rating.toFixed(1))
      : 0;
    const totalReviews = reviewAgg._count.rating ?? 0;

    const validItems = orderItems.filter(
      (it) =>
        it.order.status !== "cancelled" && it.product.status !== "archived",
    );
    const orderIds = new Set(validItems.map((it) => it.orderId));
    const totalOrders = orderIds.size;
    const totalRevenue = validItems.reduce(
      (sum, it) => sum + it.price * it.quantity,
      0,
    );

    const todayUTC = new Date();
    todayUTC.setUTCHours(0, 0, 0, 0);
    const startUTC = new Date(todayUTC);
    startUTC.setUTCDate(todayUTC.getUTCDate() - 29);

    const dayMap = new Map<string, { revenue: number; orders: Set<string> }>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(startUTC);
      d.setUTCDate(startUTC.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      dayMap.set(key, { revenue: 0, orders: new Set() });
    }

    for (const it of validItems) {
      const key = new Date(it.order.createdAt).toISOString().slice(0, 10);
      const entry = dayMap.get(key);
      if (!entry) continue;
      entry.revenue += it.price * it.quantity;
      entry.orders.add(it.orderId);
    }

    const salesOverTime = Array.from(dayMap.entries()).map(([date, v]) => ({
      date,
      revenue: Math.round(v.revenue * 100) / 100,
      orders: v.orders.size,
    }));

    const productMap = new Map<
      string,
      {
        product: (typeof orderItems)[number]["product"];
        unitsSold: number;
        revenue: number;
        orders: Set<string>;
      }
    >();
    for (const it of validItems) {
      const existing = productMap.get(it.productId);
      if (!existing) {
        productMap.set(it.productId, {
          product: it.product,
          unitsSold: it.quantity,
          revenue: it.price * it.quantity,
          orders: new Set([it.orderId]),
        });
      } else {
        existing.unitsSold += it.quantity;
        existing.revenue += it.price * it.quantity;
        existing.orders.add(it.orderId);
      }
    }
    let bestSellers = Array.from(productMap.values())
      .map((v) => ({
        product: v.product,
        unitsSold: v.unitsSold,
        revenue: Math.round(v.revenue * 100) / 100,
        orders: v.orders.size,
      }))
      .sort(
        (a, b) =>
          b.orders - a.orders ||
          b.unitsSold - a.unitsSold ||
          b.revenue - a.revenue,
      )
      .slice(0, 5);

    if (bestSellers.length) {
      const ids = bestSellers.map((b) => b.product.id);
      const reviews = await rows<Pick<Review, "productId" | "rating">>(
        sql`SELECT r.productId, r.rating FROM review r WHERE r.productId IN (${inList(ids)})`,
      );
      const rMap = new Map<string, number[]>();
      for (const r of reviews) {
        const arr = rMap.get(r.productId) ?? [];
        arr.push(r.rating);
        rMap.set(r.productId, arr);
      }
      bestSellers = bestSellers.map((b) => {
        const ratings = rMap.get(b.product.id) ?? [];
        const total = ratings.length;
        const avg = total ? ratings.reduce((s, v) => s + v, 0) / total : 0;
        return {
          ...b,
          product: {
            ...b.product,
            avgRating: Number(avg.toFixed(1)),
            totalReviews: total,
          },
        };
      });
    }

    return res.json({
      totalProducts: productCount,
      totalOrders,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      avgRating,
      totalReviews,
      salesOverTime,
      bestSellers,
    });
  } catch (error) {
    console.error("Error fetching seller stats:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const session = (req as any).session;

    const seller = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );

    return res.json({ seller });
  } catch (error) {
    console.error("Error fetching seller:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/me", requireAuth, async (req, res) => {
  try {
    const session = (req as any).session;

    const existing = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );

    if (!existing) {
      return res.status(404).json({ error: "Seller profile not found" });
    }

    const { name, image, description, username } = req.body as {
      name?: string;
      image?: string | null;
      description?: string | null;
      username?: string;
    };

    if (
      name !== undefined &&
      (typeof name !== "string" || name.trim().length === 0)
    ) {
      return res.status(400).json({ error: "Store name is required" });
    }
    if (name !== undefined && name.trim().length > 80) {
      return res
        .status(400)
        .json({ error: "Store name must be under 80 characters" });
    }
    if (
      description !== undefined &&
      description !== null &&
      description.length > 500
    ) {
      return res
        .status(400)
        .json({ error: "Description must be under 500 characters" });
    }
    if (username !== undefined) {
      const lower = String(username).toLowerCase().trim();
      if (!isValidUsername(lower))
        return res
          .status(400)
          .json({ error: "Username must be 3-20 chars, a-z 0-9 _ -" });
      if (RESERVED_USERNAMES.has(lower))
        return res.status(400).json({ error: "Username is reserved" });
      const taken = await one<Seller>(
        sql`SELECT s.* FROM seller s WHERE s.username = ${lower} LIMIT 1`,
      );
      if (taken && taken.id !== existing.id)
        return res.status(409).json({ error: "Username already taken" });
    }

    const data: Partial<
      Pick<Seller, "name" | "image" | "description" | "username">
    > = {};
    if (name !== undefined) data.name = name.trim();
    if (image !== undefined) data.image = image ? String(image) : null;
    if (description !== undefined)
      data.description = description ? String(description).trim() : null;
    if (username !== undefined)
      data.username = String(username).toLowerCase().trim();

    const seller = await updateRow<Seller>(
      assignments([
        [sql`s.name`, data.name],
        [sql`s.image`, data.image],
        [sql`s.description`, data.description],
        [sql`s.username`, data.username],
      ]),
      (fields) =>
        sql`UPDATE seller s SET ${fields} WHERE s.userId = ${session.user.id}`,
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id}`,
    );

    return res.json({ seller });
  } catch (error) {
    console.error("Error updating seller:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
