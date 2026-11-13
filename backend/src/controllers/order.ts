import type { Request, Response } from "express";
import {
  sql,
  one,
  rows,
  scalar,
  updateRow,
  write,
  inList,
  transaction,
  joinSql,
} from "../db/pool.js";
import type {
  User,
  Seller,
  Product,
  Promo,
  Order,
  OrderItem,
} from "../db/models.js";
import { stripeEnabled } from "../lib/auth.js";
import { stripe } from "../lib/stripe.js";
import { sendNotification } from "../inngest/client.js";

const VALID_DELIVERY = ["pickup", "delivery"] as const;
const VALID_PAYMENT = ["cod", "stripe"] as const;

function discountedPrice(price: number, discount: number) {
  return Math.round(price * (1 - discount / 100) * 100) / 100;
}

async function resolvePromo(code?: string, sellerIds: string[] = []) {
  if (!code)
    return {
      percent: 0,
      code: null as string | null,
      sellerId: null as string | null,
    };
  const upper = code.trim().toUpperCase();

  const promos = await rows<Promo>(
    sql`SELECT pr.* FROM promo pr WHERE pr.code = ${upper} AND pr.active = ${true}`,
  );
  const now = new Date();
  const valid = promos.filter(
    (p) => !p.expiresAt || new Date(p.expiresAt) > now,
  );

  if (valid.length > 0) {
    const set = new Set(sellerIds);
    const sellerMatch = valid.find((p) => p.sellerId && set.has(p.sellerId));
    if (sellerMatch)
      return {
        percent: sellerMatch.discountPercent,
        code: upper,
        sellerId: sellerMatch.sellerId as string,
      };
    const globalMatch = valid.find((p) => !p.sellerId);
    if (globalMatch)
      return {
        percent: globalMatch.discountPercent,
        code: upper,
        sellerId: null as string | null,
      };
    return {
      percent: 0,
      code: null as string | null,
      sellerId: null as string | null,
      invalid: true as const,
    };
  }

  return {
    percent: 0,
    code: null as string | null,
    sellerId: null as string | null,
    invalid: true as const,
  };
}

export async function createOrder(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const { deliveryStatus, address, phone, promoCode, paymentMethod, items } =
      req.body as {
        deliveryStatus: string;
        address?: {
          street: string;
          city: string;
          zip: string;
          country?: string;
          label?: string;
        } | null;
        phone?: string;
        promoCode?: string;
        paymentMethod: string;
        items: { productId: string; quantity: number }[];
      };

    if (!deliveryStatus || !VALID_DELIVERY.includes(deliveryStatus as never)) {
      return res.status(400).json({ error: "Invalid deliveryStatus" });
    }
    if (!paymentMethod || !VALID_PAYMENT.includes(paymentMethod as never)) {
      return res.status(400).json({ error: "Invalid paymentMethod" });
    }
    const payment = paymentMethod === "stripe" && stripeEnabled ? stripe : null;
    if (paymentMethod === "stripe" && !payment) {
      return res.status(503).json({ error: "Card payments are unavailable" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }
    if (deliveryStatus === "delivery") {
      if (
        !address ||
        !address.street?.trim() ||
        !address.city?.trim() ||
        !address.zip?.trim()
      ) {
        return res.status(400).json({ error: "Delivery address required" });
      }
      if (!phone || phone.trim().length < 7) {
        return res
          .status(400)
          .json({ error: "Phone number required for delivery" });
      }
    }
    if (!phone || phone.trim().length < 7) {
      return res.status(400).json({ error: "Phone number required" });
    }

    const quantities = new Map<string, number>();
    for (const item of items) {
      if (
        typeof item?.productId !== "string" ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1
      ) {
        return res.status(400).json({ error: "Invalid cart item" });
      }
      quantities.set(
        item.productId,
        (quantities.get(item.productId) || 0) + item.quantity,
      );
    }

    const products = await rows<Product>(sql`
      SELECT p.* FROM product p JOIN seller s ON s.id = p.sellerId
      JOIN \`user\` u ON u.id = s.userId
      WHERE p.id IN (${inList([...quantities.keys()])})
        AND p.status = 'active' AND s.approved = TRUE AND COALESCE(u.banned, FALSE) = FALSE
    `);
    const productMap = new Map(
      products.map((product) => [product.id, product]),
    );
    const lines: { product: Product; quantity: number; price: number }[] = [];
    for (const [productId, quantity] of quantities) {
      const product = productMap.get(productId);
      if (!product)
        return res
          .status(400)
          .json({ error: `Product ${productId} not available` });
      if (product.stock < quantity)
        return res
          .status(400)
          .json({ error: `Insufficient stock for ${product.name}` });
      lines.push({
        product,
        quantity,
        price: discountedPrice(product.price, product.discount),
      });
    }

    const promo = await resolvePromo(promoCode, [
      ...new Set(products.map((product) => product.sellerId)),
    ]);
    if (promo.invalid)
      return res.status(400).json({ error: "Invalid promo code" });

    const subtotalCents = lines.reduce(
      (sum, line) => sum + Math.round(line.price * 100) * line.quantity,
      0,
    );
    const eligibleCents = lines.reduce(
      (sum, { product, price, quantity }) =>
        !promo.sellerId || promo.sellerId === product.sellerId
          ? sum + Math.round(price * 100) * quantity
          : sum,
      0,
    );
    const discountCents = Math.round((eligibleCents * promo.percent) / 100);
    const deliveryFee = deliveryStatus === "delivery" ? 5 : 0;
    const totalCents = subtotalCents + deliveryFee * 100 - discountCents;
    const addressSnapshot =
      deliveryStatus === "delivery" ? JSON.stringify(address) : null;
    const orderId = crypto.randomUUID();

    const order = await transaction(async (connection) => {
      await write(
        sql`
        INSERT INTO \`order\` (id, userId, deliveryStatus, paymentMethod, addressSnapshot, phoneNumber,
          promoCode, discount, subtotal, deliveryFee, total)
        VALUES (${orderId}, ${userId}, ${deliveryStatus}, ${paymentMethod}, ${addressSnapshot}, ${phone.trim()},
          ${promo.code}, ${discountCents / 100}, ${subtotalCents / 100}, ${deliveryFee}, ${totalCents / 100})
      `,
        connection,
      );
      for (const { product, quantity, price } of lines) {
        await write(
          sql`
          INSERT INTO orderItem (id, orderId, productId, quantity, price, sellerId)
          VALUES (${crypto.randomUUID()}, ${orderId}, ${product.id}, ${quantity}, ${price}, ${product.sellerId})
        `,
          connection,
        );
      }
      return one<Order>(
        sql`SELECT * FROM \`order\` WHERE id = ${orderId}`,
        connection,
      );
    });

    if (payment) {
      const frontend = process.env.FRONTEND_URL || "http://localhost:5173";
      let stripeSession;
      try {
        stripeSession = await payment.checkout.sessions.create(
          {
            mode: "payment",
            customer_email: session.user.email,
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  product_data: { name: `Marketplace order ${orderId}` },
                  unit_amount: totalCents,
                },
                quantity: 1,
              },
            ],
            success_url: `${frontend}/order-confirmation/${orderId}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${frontend}/checkout?canceled=1`,
            metadata: { orderId, userId },
            client_reference_id: orderId,
          },
          { idempotencyKey: orderId },
        );
        await write(
          sql`UPDATE \`order\` SET stripeSessionId = ${stripeSession.id} WHERE id = ${orderId}`,
        );
      } catch (error) {
        if (stripeSession)
          await payment.checkout.sessions
            .expire(stripeSession.id)
            .catch(console.error);
        await write(
          sql`UPDATE \`order\` SET paymentStatus = 'failed', status = 'cancelled' WHERE id = ${orderId}`,
        );
        throw error;
      }
      return res.json({
        order,
        url: stripeSession.url,
        sessionId: stripeSession.id,
      });
    }

    return res.status(201).json({ order });
  } catch (e) {
    console.error("createOrder error", e);
    return res.status(500).json({ error: "Failed to create order" });
  }
}

export async function getOrder(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const id = req.params.id as string;
    const order = await one<Order & { items: OrderItem[] }>(sql`
      SELECT
        o.*,
        COALESCE(
          (
            SELECT
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id',
                  oi1.id,
                  'orderId',
                  oi1.orderId,
                  'productId',
                  oi1.productId,
                  'quantity',
                  oi1.quantity,
                  'price',
                  oi1.price,
                  'sellerId',
                  oi1.sellerId
                )
              )
            FROM
              orderItem oi1
            WHERE
              oi1.orderId = o.id
          ),
          JSON_ARRAY()
        ) AS \`items\`
      FROM
        \`order\` o
      WHERE
        o.id = ${id}
      LIMIT
        1
    `);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.userId !== session.user.id && session.user.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.json({ order });
  } catch (e) {
    console.error("getOrder error", e);
    return res.status(500).json({ error: "Failed to fetch order" });
  }
}

export async function listMyOrders(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const orders = await rows<
      Order & {
        items: (OrderItem & {
          product: Pick<Product, "id" | "name" | "images" | "price">;
        })[];
      }
    >(sql`
      SELECT
        o.*,
        COALESCE(
          (
            SELECT
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id',
                  oi1.id,
                  'orderId',
                  oi1.orderId,
                  'productId',
                  oi1.productId,
                  'quantity',
                  oi1.quantity,
                  'price',
                  oi1.price,
                  'sellerId',
                  oi1.sellerId,
                  'product',
                  JSON_EXTRACT(
                    (
                      SELECT
                        JSON_OBJECT(
                          'id',
                          p2.id,
                          'name',
                          p2.name,
                          'images',
                          JSON_EXTRACT(p2.images, '$'),
                          'price',
                          p2.price
                        )
                      FROM
                        product p2
                      WHERE
                        p2.id = oi1.productId
                    ),
                    '$'
                  )
                )
              )
            FROM
              orderItem oi1
            WHERE
              oi1.orderId = o.id
          ),
          JSON_ARRAY()
        ) AS \`items\`
      FROM
        \`order\` o
      WHERE
        o.userId = ${session.user.id}
      ORDER BY
        o.createdAt DESC
    `);
    return res.json({ orders });
  } catch (e) {
    console.error("listMyOrders error", e);
    return res.status(500).json({ error: "Failed to fetch orders" });
  }
}

const VALID_ORDER_STATUS = [
  "pending",
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
] as const;

export async function listSellerOrders(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const seller = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );
    if (!seller)
      return res.status(404).json({ error: "Seller profile not found" });

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.query.limit as string) || 10),
    );
    const search = (req.query.search as string)?.trim() || "";
    const status = (req.query.status as string)?.trim() || "";
    const paymentStatus = (req.query.paymentStatus as string)?.trim() || "";
    const deliveryStatus = (req.query.deliveryStatus as string)?.trim() || "";

    const filters = [
      sql`EXISTS (
      SELECT 1 FROM orderItem oi WHERE oi.orderId = o.id AND oi.sellerId = ${seller.id}
    )`,
    ];
    if (status && VALID_ORDER_STATUS.includes(status as never))
      filters.push(sql`o.status = ${status}`);
    if (["pending", "paid", "failed"].includes(paymentStatus))
      filters.push(sql`o.paymentStatus = ${paymentStatus}`);
    if (["pickup", "delivery"].includes(deliveryStatus))
      filters.push(sql`o.deliveryStatus = ${deliveryStatus}`);
    if (search) {
      filters.push(sql`(LOCATE(LOWER(${search}), LOWER(o.id)) > 0
        OR LOCATE(LOWER(${search}), LOWER(o.phoneNumber)) > 0
        OR LOCATE(LOWER(${search}), LOWER(o.promoCode)) > 0)`);
    }
    const where = joinSql(filters, " AND ");

    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      rows<
        Order & {
          items: (OrderItem & {
            product: Pick<
              Product,
              "id" | "name" | "images" | "price" | "discount"
            >;
          })[];
          user: Pick<User, "id" | "name" | "email" | "image">;
        }
      >(sql`
      SELECT
        o.*,
        COALESCE(
          (
            SELECT
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id',
                  oi1.id,
                  'orderId',
                  oi1.orderId,
                  'productId',
                  oi1.productId,
                  'quantity',
                  oi1.quantity,
                  'price',
                  oi1.price,
                  'sellerId',
                  oi1.sellerId,
                  'product',
                  JSON_EXTRACT(
                    (
                      SELECT
                        JSON_OBJECT(
                          'id',
                          p2.id,
                          'name',
                          p2.name,
                          'images',
                          JSON_EXTRACT(p2.images, '$'),
                          'price',
                          p2.price,
                          'discount',
                          p2.discount
                        )
                      FROM
                        product p2
                      WHERE
                        p2.id = oi1.productId
                    ),
                    '$'
                  )
                )
              )
            FROM
              orderItem oi1
            WHERE
              oi1.orderId = o.id
          ),
          JSON_ARRAY()
        ) AS \`items\`,
        (
          SELECT
            JSON_OBJECT('id', u3.id, 'name', u3.name, 'email', u3.email, 'image', u3.image)
          FROM
            \`user\` u3
          WHERE
            u3.id = o.userId
        ) AS \`user\`
      FROM
        \`order\` o
      WHERE
        ${where}
      ORDER BY
        o.createdAt DESC
      LIMIT
        ${limit}
      OFFSET
        ${skip}
    `),
      scalar(sql`SELECT COUNT(*) AS value FROM \`order\` o WHERE ${where}`),
    ]);

    // Filter items to only seller's items for seller view, but keep order total context
    const mapped = orders.map((order) => ({
      ...order,
      items: (
        order as unknown as { items: { sellerId: string }[] }
      ).items.filter((it) => it.sellerId === seller.id),
      _allItemsCount: (order as unknown as { items: unknown[] }).items.length,
    }));

    const totalPages = Math.ceil(total / limit) || 1;
    return res.json({ orders: mapped, total, page, limit, totalPages });
  } catch (e) {
    console.error("listSellerOrders error", e);
    return res.status(500).json({ error: "Failed to fetch seller orders" });
  }
}

export async function updateOrderStatus(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const seller = await one<Seller>(
      sql`SELECT s.* FROM seller s WHERE s.userId = ${session.user.id} LIMIT 1`,
    );
    if (!seller)
      return res.status(404).json({ error: "Seller profile not found" });

    const id = req.params.id as string;
    const { status } = req.body as { status: string };
    if (!status || !VALID_ORDER_STATUS.includes(status as never)) {
      return res
        .status(400)
        .json({
          error: `Invalid status. Valid: ${VALID_ORDER_STATUS.join(", ")}`,
        });
    }

    const order = await one<Order & { items: OrderItem[] }>(sql`
      SELECT
        o.*,
        COALESCE(
          (
            SELECT
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id',
                  oi1.id,
                  'orderId',
                  oi1.orderId,
                  'productId',
                  oi1.productId,
                  'quantity',
                  oi1.quantity,
                  'price',
                  oi1.price,
                  'sellerId',
                  oi1.sellerId
                )
              )
            FROM
              orderItem oi1
            WHERE
              oi1.orderId = o.id
          ),
          JSON_ARRAY()
        ) AS \`items\`
      FROM
        \`order\` o
      WHERE
        o.id = ${id}
      LIMIT
        1
    `);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const owns = order.items.some((it) => it.sellerId === seller.id);
    if (!owns)
      return res.status(403).json({ error: "Not authorized for this order" });

    const updated = await updateRow<
      Order & { user: Pick<User, "name" | "email"> }
    >(
      sql`o.status = ${status}`,
      (fields) => sql`UPDATE \`order\` o SET ${fields} WHERE o.id = ${id}`,
      sql`
      SELECT
        o.*,
        (
          SELECT
            JSON_OBJECT('name', u1.name, 'email', u1.email)
          FROM
            \`user\` u1
          WHERE
            u1.id = o.userId
        ) AS \`user\`
      FROM
        \`order\` o
      WHERE
        o.id = ${id}
    `,
    );

    if (updated.user?.email) {
      await sendNotification({
        name: "app/order.status.changed",
        data: {
          to: updated.user.email,
          buyerName: updated.user.name || "Customer",
          orderId: order.id,
          status,
        },
      });
    }

    return res.json({ order: updated });
  } catch (e) {
    console.error("updateOrderStatus error", e);
    return res.status(500).json({ error: "Failed to update order" });
  }
}
