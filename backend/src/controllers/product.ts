import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import {
  sql,
  one,
  rows,
  scalar,
  write,
  insertRow,
  updateRow,
  inList,
  assignments,
  joinSql,
} from "../db/pool.js";
import type { Seller, Product, OrderItem, Review } from "../db/models.js";
import type { Request, Response } from "express";

const VALID_CATEGORIES = [
  "fashion",
  "electronics",
  "beauty",
  "fitness",
  "home-decor",
  "accessories",
];

const VALID_STATUSES = ["draft", "active", "archived"];
const VALID_GENDERS = ["men", "women", "unisex"];
const VALID_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];

export async function createProduct(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const {
      name,
      description,
      price,
      discount,
      category,
      images,
      stock,
      sizes,
      colors,
      gender,
      status,
    } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "Product name is required" });
    }

    if (price === undefined || typeof price !== "number" || price <= 0) {
      return res.status(400).json({ error: "A valid price is required" });
    }

    if (
      discount !== undefined &&
      (typeof discount !== "number" || discount < 0 || discount > 100)
    ) {
      return res
        .status(400)
        .json({ error: "Discount must be between 0 and 100" });
    }

    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "A valid category is required" });
    }

    if (stock !== undefined && (typeof stock !== "number" || stock < 0)) {
      return res
        .status(400)
        .json({ error: "Stock must be a non-negative number" });
    }

    if (sizes !== undefined && !Array.isArray(sizes)) {
      return res.status(400).json({ error: "Sizes must be an array" });
    }

    if (colors !== undefined && !Array.isArray(colors)) {
      return res.status(400).json({ error: "Colors must be an array" });
    }

    if (
      gender !== undefined &&
      gender !== null &&
      !VALID_GENDERS.includes(gender)
    ) {
      return res.status(400).json({ error: "Invalid gender value" });
    }

    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    const seller = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );

    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }

    if (!seller.approved) {
      if (seller.revokedAt) {
        return res
          .status(403)
          .json({ error: "Your seller account has been revoked." });
      }
      return res
        .status(403)
        .json({ error: "Your seller account is pending approval." });
    }

    const product = await insertRow<Product>(
      (id) => sql`
      INSERT INTO
        product (
          id,
          name,
          description,
          price,
          discount,
          category,
          images,
          stock,
          sizes,
          colors,
          gender,
          status,
          sellerId
        )
      VALUES
        (
          ${id},
          ${name.trim()},
          ${description?.trim() || null},
          ${price},
          ${discount ?? 0},
          ${category},
          ${JSON.stringify(Array.isArray(images) ? images : [])},
          ${stock ?? 0},
          ${JSON.stringify(Array.isArray(sizes) ? sizes : [])},
          ${JSON.stringify(Array.isArray(colors) ? colors : [])},
          ${gender || null},
          ${status || "draft"},
          ${seller.id}
        )
    `,
      (id) => sql`SELECT p.* FROM product p WHERE p.id = ${id}`,
    );

    return res.status(201).json({ product });
  } catch (error) {
    console.error("Error creating product:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function listProducts(req: Request, res: Response) {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit as string) || 10),
    );
    const search = (req.query.search as string)?.trim() || "";
    const category = (req.query.category as string)?.trim() || "";
    const status = (req.query.status as string)?.trim() || "";
    const mine = req.query.mine === "true";
    const sellerIdParam = (req.query.sellerId as string)?.trim() || "";
    const minPrice = req.query.minPrice
      ? parseFloat(req.query.minPrice as string)
      : undefined;
    const maxPrice = req.query.maxPrice
      ? parseFloat(req.query.maxPrice as string)
      : undefined;
    const ratingParam = req.query.rating
      ? parseFloat(req.query.rating as string)
      : undefined;
    const sort = (req.query.sort as string)?.trim() || "";

    const filters = [];
    if (search) {
      filters.push(sql`(LOCATE(LOWER(${search}), LOWER(p.name)) > 0
        OR LOCATE(LOWER(${search}), LOWER(p.description)) > 0
        OR LOCATE(LOWER(${search}), LOWER(p.category)) > 0)`);
    }
    if (category && VALID_CATEGORIES.includes(category)) {
      filters.push(sql`p.category = ${category}`);
    }
    if (!mine) {
      filters.push(sql`p.status = 'active'`);
      filters.push(sql`EXISTS (
        SELECT 1 FROM seller s JOIN \`user\` u ON u.id = s.userId
        WHERE s.id = p.sellerId AND s.approved = TRUE AND COALESCE(u.banned, FALSE) = FALSE
      )`);
      if (sellerIdParam) filters.push(sql`p.sellerId = ${sellerIdParam}`);
    } else if (status && VALID_STATUSES.includes(status)) {
      filters.push(sql`p.status = ${status}`);
    }

    if (mine) {
      let session = (req as any).session;
      if (!session) {
        try {
          session = await auth.api.getSession({
            headers: fromNodeHeaders(req.headers as never),
          });
        } catch {
          session = null;
        }
      }
      if (!session) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const seller = await one<Pick<Seller, "id">>(
        sql`SELECT s.id FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
      );
      if (!seller) {
        return res.status(404).json({ error: "Seller profile not found" });
      }
      filters.push(sql`p.sellerId = ${seller.id}`);
    }

    const where = joinSql(filters, " AND ");

    const needsMemoryProcessing = Boolean(
      (minPrice !== undefined && !isNaN(minPrice)) ||
      (maxPrice !== undefined && !isNaN(maxPrice)) ||
      (ratingParam !== undefined && !isNaN(ratingParam)) ||
      sort,
    );

    if (!needsMemoryProcessing) {
      const skip = (page - 1) * limit;
      const [products, total] = await Promise.all([
        rows<
          Product & {
            seller: Pick<Seller, "id" | "name" | "image" | "username">;
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
        ${where}
      ORDER BY
        p.createdAt DESC
      LIMIT
        ${limit}
      OFFSET
        ${skip}
    `),
        scalar(sql`SELECT COUNT(*) AS value FROM product p WHERE ${where}`),
      ]);

      const productIds = products.map((p) => p.id);
      let ratingMap = new Map<string, { avg: number; total: number }>();
      let salesMap = new Map<string, number>();
      if (productIds.length) {
        const [reviews, orderItems] = await Promise.all([
          rows<Pick<Review, "productId" | "rating">>(
            sql`SELECT r.productId, r.rating FROM review r WHERE r.productId IN (${inList(productIds)})`,
          ),
          rows<Pick<OrderItem, "productId" | "orderId">>(sql`
      SELECT
        oi.productId,
        oi.orderId
      FROM
        orderItem oi
      WHERE
        oi.productId IN (${inList(productIds)})
        AND EXISTS (
          SELECT
            1
          FROM
            \`order\` o1
          WHERE
            o1.id = oi.orderId
            AND o1.status <> ${"cancelled"}
        )
    `),
        ]);
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
        const sMap = new Map<string, Set<string>>();
        for (const it of orderItems) {
          const set = sMap.get(it.productId) ?? new Set<string>();
          set.add(it.orderId);
          sMap.set(it.productId, set);
        }
        salesMap = new Map(
          Array.from(sMap.entries()).map(([k, v]) => [k, v.size]),
        );
      }

      const enriched = products.map((p) => ({
        ...p,
        avgRating: ratingMap.get(p.id)?.avg ?? 0,
        totalReviews: ratingMap.get(p.id)?.total ?? 0,
        unitsSold: salesMap.get(p.id) ?? 0,
      }));

      const totalPages = Math.ceil(total / limit) || 1;
      return res.json({ products: enriched, total, page, limit, totalPages });
    }

    const allProducts = await rows<
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
        ${where}
    `);

    const productIds = allProducts.map((p) => p.id);
    let ratingMap = new Map<string, { avg: number; total: number }>();
    let salesMap = new Map<string, number>();
    if (productIds.length) {
      const [reviews, orderItems] = await Promise.all([
        rows<Pick<Review, "productId" | "rating">>(
          sql`SELECT r.productId, r.rating FROM review r WHERE r.productId IN (${inList(productIds)})`,
        ),
        rows<Pick<OrderItem, "productId" | "orderId">>(sql`
      SELECT
        oi.productId,
        oi.orderId
      FROM
        orderItem oi
      WHERE
        oi.productId IN (${inList(productIds)})
        AND EXISTS (
          SELECT
            1
          FROM
            \`order\` o1
          WHERE
            o1.id = oi.orderId
            AND o1.status <> ${"cancelled"}
        )
    `),
      ]);
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
      const sMap = new Map<string, Set<string>>();
      for (const it of orderItems) {
        const set = sMap.get(it.productId) ?? new Set<string>();
        set.add(it.orderId);
        sMap.set(it.productId, set);
      }
      salesMap = new Map(
        Array.from(sMap.entries()).map(([k, v]) => [k, v.size]),
      );
    }

    let enriched = allProducts.map((p) => {
      const discounted =
        p.discount > 0 ? p.price * (1 - p.discount / 100) : p.price;
      return {
        ...p,
        discountedPrice: discounted,
        avgRating: ratingMap.get(p.id)?.avg ?? 0,
        totalReviews: ratingMap.get(p.id)?.total ?? 0,
        unitsSold: salesMap.get(p.id) ?? 0,
      } as typeof p & {
        discountedPrice: number;
        avgRating: number;
        totalReviews: number;
        unitsSold: number;
      };
    });

    if (minPrice !== undefined && !isNaN(minPrice))
      enriched = enriched.filter(
        (p) =>
          (p as never as { discountedPrice: number }).discountedPrice >=
          minPrice,
      );
    if (maxPrice !== undefined && !isNaN(maxPrice))
      enriched = enriched.filter(
        (p) =>
          (p as never as { discountedPrice: number }).discountedPrice <=
          maxPrice,
      );
    if (ratingParam !== undefined && !isNaN(ratingParam))
      enriched = enriched.filter((p) => p.avgRating >= ratingParam);

    if (sort === "price_asc")
      enriched.sort(
        (a, b) =>
          (a as never as { discountedPrice: number }).discountedPrice -
          (b as never as { discountedPrice: number }).discountedPrice,
      );
    else if (sort === "price_desc")
      enriched.sort(
        (a, b) =>
          (b as never as { discountedPrice: number }).discountedPrice -
          (a as never as { discountedPrice: number }).discountedPrice,
      );
    else if (sort === "rating_desc")
      enriched.sort(
        (a, b) => b.avgRating - a.avgRating || b.totalReviews - a.totalReviews,
      );
    else if (sort === "newest")
      enriched.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    else
      enriched.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

    const total = enriched.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const start = (page - 1) * limit;
    const paginated = enriched
      .slice(start, start + limit)
      .map(({ discountedPrice: _d, ...rest }) => rest);

    return res.json({ products: paginated, total, page, limit, totalPages });
  } catch (error) {
    console.error("Error listing products:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function getBestSellers(req: Request, res: Response) {
  try {
    const limit = Math.min(
      12,
      Math.max(1, parseInt(req.query.limit as string) || 6),
    );

    const approvedSellerIds = await rows<Pick<Seller, "id">>(
      sql`SELECT s.id FROM seller s WHERE s.approved = ${true}`,
    ).then((sellers) => sellers.map((s) => s.id));

    if (approvedSellerIds.length === 0) {
      return res.json({ bestSellers: [] });
    }

    const approvedProductIds = await rows<Pick<Product, "id">>(
      sql`SELECT p.id FROM product p WHERE p.status = ${"active"} AND p.sellerId IN (${inList(approvedSellerIds)})`,
    ).then((products) => products.map((p) => p.id));

    if (approvedProductIds.length === 0) {
      return res.json({ bestSellers: [] });
    }

    const orderItems = await rows<
      Pick<OrderItem, "productId" | "quantity" | "price" | "orderId"> & {
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
          | "sellerId"
          | "createdAt"
          | "updatedAt"
        > & { seller: Pick<Seller, "id" | "name" | "image" | "username"> };
      }
    >(sql`
      SELECT
        oi.productId,
        oi.quantity,
        oi.price,
        oi.orderId,
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
              'sellerId',
              p2.sellerId,
              'createdAt',
              p2.createdAt,
              'updatedAt',
              p2.updatedAt,
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
        EXISTS (
          SELECT
            1
          FROM
            \`order\` o1
          WHERE
            o1.id = oi.orderId
            AND o1.status <> ${"cancelled"}
        )
        AND oi.productId IN (${inList(approvedProductIds)})
    `);

    const map = new Map<
      string,
      {
        product: (typeof orderItems)[number]["product"];
        unitsSold: number;
        revenue: number;
        orders: Set<string>;
      }
    >();
    for (const it of orderItems) {
      if (!it.product) continue;
      const ex = map.get(it.productId);
      if (!ex)
        map.set(it.productId, {
          product: it.product,
          unitsSold: it.quantity,
          revenue: it.price * it.quantity,
          orders: new Set([it.orderId]),
        });
      else {
        ex.unitsSold += it.quantity;
        ex.revenue += it.price * it.quantity;
        ex.orders.add(it.orderId);
      }
    }

    let sorted = Array.from(map.values())
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
      .slice(0, limit);

    if (sorted.length === 0) {
      return res.json({ bestSellers: [] });
    }

    const productIds = sorted.map((s) => s.product!.id);
    const reviews = await rows<Pick<Review, "productId" | "rating">>(
      sql`SELECT r.productId, r.rating FROM review r WHERE r.productId IN (${inList(productIds)})`,
    );
    const rMap = new Map<string, number[]>();
    for (const r of reviews) {
      const arr = rMap.get(r.productId) ?? [];
      arr.push(r.rating);
      rMap.set(r.productId, arr);
    }
    const ratingMap = new Map<string, { avg: number; total: number }>();
    for (const [pid, ratings] of rMap) {
      const total = ratings.length;
      const avg = total ? ratings.reduce((s, v) => s + v, 0) / total : 0;
      ratingMap.set(pid, { avg: Number(avg.toFixed(1)), total });
    }
    const enriched = sorted.map((s) => ({
      ...s,
      product: {
        ...s.product!,
        avgRating: ratingMap.get(s.product!.id)?.avg ?? 0,
        totalReviews: ratingMap.get(s.product!.id)?.total ?? 0,
      },
    }));

    return res.json({ bestSellers: enriched });
  } catch (e) {
    console.error("getBestSellers", e);
    return res.status(500).json({ error: "Failed to fetch best sellers" });
  }
}

export async function getProduct(req: Request, res: Response) {
  try {
    const id = req.params.id as string;

    const product = await one<
      Product & {
        seller: Pick<Seller, "id" | "name" | "image" | "username" | "approved">;
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
              'image',
              s1.image,
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
      LIMIT
        1
    `);

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    if (!product.seller?.approved || product.status !== "active") {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
      const seller =
        session &&
        (await one<Pick<Seller, "id">>(
          sql`SELECT id FROM seller WHERE userId = ${session.user.id}`,
        ));
      if (session?.user.role !== "admin" && seller?.id !== product.sellerId) {
        return res.status(404).json({ error: "Product not found" });
      }
    }

    const [reviews, orderItems] = await Promise.all([
      rows<Pick<Review, "rating">>(
        sql`SELECT r.rating FROM review r WHERE r.productId = ${id}`,
      ),
      rows<Pick<OrderItem, "orderId">>(sql`
      SELECT
        oi.orderId
      FROM
        orderItem oi
      WHERE
        oi.productId = ${id}
        AND EXISTS (
          SELECT
            1
          FROM
            \`order\` o1
          WHERE
            o1.id = oi.orderId
            AND o1.status <> ${"cancelled"}
        )
    `),
    ]);
    const totalReviews = reviews.length;
    const avgRating = totalReviews
      ? Number(
          (reviews.reduce((s, r) => s + r.rating, 0) / totalReviews).toFixed(1),
        )
      : 0;
    const unitsSold = new Set(orderItems.map((o) => o.orderId)).size;

    return res.json({
      product: { ...product, avgRating, totalReviews, unitsSold },
    });
  } catch (error) {
    console.error("Error fetching product:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function updateProduct(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const id = req.params.id as string;
    const {
      name,
      description,
      price,
      discount,
      category,
      images,
      stock,
      sizes,
      colors,
      gender,
      status,
    } = req.body;

    const seller = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );

    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }

    const existing = await one<Product>(
      sql`SELECT p.* FROM product p WHERE p.id = ${id} LIMIT 1`,
    );

    if (!existing) {
      return res.status(404).json({ error: "Product not found" });
    }

    if (existing.sellerId !== seller.id) {
      return res
        .status(403)
        .json({ error: "Not authorized to update this product" });
    }

    if (existing.status === "rejected") {
      return res.status(403).json({
        error:
          "This product has been rejected by an admin and cannot be edited. Please contact support for details.",
      });
    }

    if (
      name !== undefined &&
      (typeof name !== "string" || name.trim().length === 0)
    ) {
      return res.status(400).json({ error: "Product name cannot be empty" });
    }

    if (price !== undefined && (typeof price !== "number" || price <= 0)) {
      return res.status(400).json({ error: "A valid price is required" });
    }

    if (
      discount !== undefined &&
      (typeof discount !== "number" || discount < 0 || discount > 100)
    ) {
      return res
        .status(400)
        .json({ error: "Discount must be between 0 and 100" });
    }

    if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Invalid category" });
    }

    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    const product = await updateRow<Product>(
      assignments([
        [sql`p.name`, name !== undefined ? name.trim() : undefined],
        [
          sql`p.description`,
          description !== undefined ? description?.trim() || null : undefined,
        ],
        [sql`p.price`, price !== undefined ? price : undefined],
        [sql`p.discount`, discount !== undefined ? discount : undefined],
        [sql`p.category`, category !== undefined ? category : undefined],
        [
          sql`p.images`,
          (images !== undefined ? images : undefined) === undefined
            ? undefined
            : JSON.stringify(images !== undefined ? images : undefined),
        ],
        [sql`p.stock`, stock !== undefined ? stock : undefined],
        [
          sql`p.sizes`,
          (sizes !== undefined ? sizes : undefined) === undefined
            ? undefined
            : JSON.stringify(sizes !== undefined ? sizes : undefined),
        ],
        [
          sql`p.colors`,
          (colors !== undefined ? colors : undefined) === undefined
            ? undefined
            : JSON.stringify(colors !== undefined ? colors : undefined),
        ],
        [sql`p.gender`, gender !== undefined ? gender || null : undefined],
        [sql`p.status`, status !== undefined ? status : undefined],
      ]),
      (fields) => sql`UPDATE product p SET ${fields} WHERE p.id = ${id}`,
      sql`SELECT p.* FROM product p WHERE p.id = ${id}`,
    );

    return res.json({ product });
  } catch (error) {
    console.error("Error updating product:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function deleteProduct(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const id = req.params.id as string;

    const seller = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );

    if (!seller) {
      return res.status(404).json({ error: "Seller profile not found" });
    }

    const existing = await one<Product>(
      sql`SELECT p.* FROM product p WHERE p.id = ${id} LIMIT 1`,
    );

    if (!existing) {
      return res.status(404).json({ error: "Product not found" });
    }

    if (existing.sellerId !== seller.id) {
      return res
        .status(403)
        .json({ error: "Not authorized to delete this product" });
    }

    if (existing.status === "rejected") {
      return res.status(403).json({
        error:
          "This product has been rejected by an admin and cannot be deleted. Please contact support for details.",
      });
    }

    await write(sql`DELETE p FROM product p WHERE p.id = ${id}`);

    return res.json({ success: true });
  } catch (error) {
    console.error("Error deleting product:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
