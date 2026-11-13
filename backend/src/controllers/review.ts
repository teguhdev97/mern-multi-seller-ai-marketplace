import type { Request, Response } from "express";
import {
  sql,
  one,
  rows,
  write,
  insertRow,
  updateRow,
  assignments,
} from "../db/pool.js";
import type {
  User,
  Product,
  Order,
  Review,
  ReviewComment,
} from "../db/models.js";

async function hasPurchased(userId: string, productId: string) {
  const order = await one<Pick<Order, "id">>(sql`
      SELECT
        o.id
      FROM
        \`order\` o
      WHERE
        o.userId = ${userId}
        AND EXISTS (
          SELECT
            1
          FROM
            orderItem oi1
          WHERE
            oi1.orderId = o.id
            AND oi1.productId = ${productId}
        )
        AND (NOT (o.paymentStatus = ${"failed"}))
      LIMIT
        1
    `);
  return !!order;
}

export async function listReviews(req: Request, res: Response) {
  try {
    const productId = req.params.productId as string;
    const reviews = await rows<
      Review & {
        user: Pick<User, "id" | "name" | "image">;
        comments: (ReviewComment & {
          user: Pick<User, "id" | "name" | "image">;
        })[];
      }
    >(sql`
      SELECT
        r.*,
        (
          SELECT
            JSON_OBJECT('id', u1.id, 'name', u1.name, 'image', u1.image)
          FROM
            \`user\` u1
          WHERE
            u1.id = r.userId
        ) AS \`user\`,
        COALESCE(
          (
            SELECT
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id',
                  rc2.id,
                  'reviewId',
                  rc2.reviewId,
                  'userId',
                  rc2.userId,
                  'comment',
                  rc2.comment,
                  'createdAt',
                  rc2.createdAt,
                  'updatedAt',
                  rc2.updatedAt,
                  'user',
                  JSON_EXTRACT(
                    (
                      SELECT
                        JSON_OBJECT('id', u3.id, 'name', u3.name, 'image', u3.image)
                      FROM
                        \`user\` u3
                      WHERE
                        u3.id = rc2.userId
                    ),
                    '$'
                  )
                )
              )
            FROM
              reviewComment rc2
            WHERE
              rc2.reviewId = r.id
          ),
          JSON_ARRAY()
        ) AS \`comments\`
      FROM
        review r
      WHERE
        r.productId = ${productId}
      ORDER BY
        r.createdAt DESC
    `);
    const total = reviews.length;
    const avg = total ? reviews.reduce((s, r) => s + r.rating, 0) / total : 0;
    return res.json({ reviews, avg, total });
  } catch (e) {
    console.error("listReviews", e);
    return res.status(500).json({ error: "Failed to fetch reviews" });
  }
}

export async function canReview(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const productId = req.params.productId as string;
    const userId = session.user.id as string;

    const purchased = await hasPurchased(userId, productId);
    const existing = await one<Review>(
      sql`SELECT r.* FROM review r WHERE r.productId = ${productId} AND r.userId = ${userId} LIMIT 1`,
    );

    return res.json({
      canReview: purchased && !existing,
      hasPurchased: purchased,
      hasReviewed: !!existing,
      review: existing ?? null,
    });
  } catch (e) {
    console.error("canReview", e);
    return res.status(500).json({ error: "Failed to check" });
  }
}

export async function createReview(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const { productId, rating, comment } = req.body as {
      productId: string;
      rating: number;
      comment: string;
    };

    if (!productId || typeof productId !== "string")
      return res.status(400).json({ error: "productId required" });
    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5)
      return res.status(400).json({ error: "Rating must be 1-5" });
    if (!comment || typeof comment !== "string" || comment.trim().length < 10)
      return res
        .status(400)
        .json({ error: "Comment must be at least 10 characters" });

    const product = await one<Product>(
      sql`SELECT p.* FROM product p WHERE p.id = ${productId} LIMIT 1`,
    );
    if (!product) return res.status(404).json({ error: "Product not found" });

    const purchased = await hasPurchased(userId, productId);
    if (!purchased)
      return res.status(403).json({ error: "Only purchasers can review" });

    const existing = await one<Review>(
      sql`SELECT r.* FROM review r WHERE r.productId = ${productId} AND r.userId = ${userId} LIMIT 1`,
    );
    if (existing)
      return res
        .status(409)
        .json({ error: "You have already reviewed this product" });

    const review = await insertRow<
      Review & {
        user: Pick<User, "id" | "name" | "image">;
        comments: ReviewComment[];
      }
    >(
      (id) => sql`
      INSERT INTO
        review (id, productId, userId, rating, comment)
      VALUES
        (${id}, ${productId}, ${userId}, ${r}, ${comment.trim()})
    `,
      (id) => sql`
      SELECT
        r.*,
        (
          SELECT
            JSON_OBJECT('id', u1.id, 'name', u1.name, 'image', u1.image)
          FROM
            \`user\` u1
          WHERE
            u1.id = r.userId
        ) AS \`user\`,
        COALESCE(
          (
            SELECT
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id',
                  rc2.id,
                  'reviewId',
                  rc2.reviewId,
                  'userId',
                  rc2.userId,
                  'comment',
                  rc2.comment,
                  'createdAt',
                  rc2.createdAt,
                  'updatedAt',
                  rc2.updatedAt
                )
              )
            FROM
              reviewComment rc2
            WHERE
              rc2.reviewId = r.id
          ),
          JSON_ARRAY()
        ) AS \`comments\`
      FROM
        review r
      WHERE
        r.id = ${id}
    `,
    );
    return res.status(201).json({ review });
  } catch (e) {
    console.error("createReview", e);
    return res.status(500).json({ error: "Failed to create review" });
  }
}

export async function updateReview(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const id = req.params.id as string;
    const { rating, comment } = req.body as {
      rating?: number;
      comment?: string;
    };

    const existing = await one<Review>(
      sql`SELECT r.* FROM review r WHERE r.id = ${id} LIMIT 1`,
    );
    if (!existing) return res.status(404).json({ error: "Review not found" });
    if (existing.userId !== userId)
      return res.status(403).json({ error: "Not your review" });

    const data: Partial<Pick<Review, "rating" | "comment">> = {};
    if (rating !== undefined) {
      const r = Number(rating);
      if (!Number.isInteger(r) || r < 1 || r > 5)
        return res.status(400).json({ error: "Rating must be 1-5" });
      data.rating = r;
    }
    if (comment !== undefined) {
      if (typeof comment !== "string" || comment.trim().length < 10)
        return res
          .status(400)
          .json({ error: "Comment must be at least 10 characters" });
      data.comment = comment.trim();
    }

    const review = await updateRow<
      Review & {
        user: Pick<User, "id" | "name" | "image">;
        comments: (ReviewComment & {
          user: Pick<User, "id" | "name" | "image">;
        })[];
      }
    >(
      assignments([
        [sql`r.rating`, data.rating],
        [sql`r.comment`, data.comment],
      ]),
      (fields) => sql`UPDATE review r SET ${fields} WHERE r.id = ${id}`,
      sql`
      SELECT
        r.*,
        (
          SELECT
            JSON_OBJECT('id', u1.id, 'name', u1.name, 'image', u1.image)
          FROM
            \`user\` u1
          WHERE
            u1.id = r.userId
        ) AS \`user\`,
        COALESCE(
          (
            SELECT
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id',
                  rc2.id,
                  'reviewId',
                  rc2.reviewId,
                  'userId',
                  rc2.userId,
                  'comment',
                  rc2.comment,
                  'createdAt',
                  rc2.createdAt,
                  'updatedAt',
                  rc2.updatedAt,
                  'user',
                  JSON_EXTRACT(
                    (
                      SELECT
                        JSON_OBJECT('id', u3.id, 'name', u3.name, 'image', u3.image)
                      FROM
                        \`user\` u3
                      WHERE
                        u3.id = rc2.userId
                    ),
                    '$'
                  )
                )
              )
            FROM
              reviewComment rc2
            WHERE
              rc2.reviewId = r.id
          ),
          JSON_ARRAY()
        ) AS \`comments\`
      FROM
        review r
      WHERE
        r.id = ${id}
    `,
    );
    return res.json({ review });
  } catch (e) {
    console.error("updateReview", e);
    return res.status(500).json({ error: "Failed to update review" });
  }
}

export async function deleteReview(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const id = req.params.id as string;
    const existing = await one<Review>(
      sql`SELECT r.* FROM review r WHERE r.id = ${id} LIMIT 1`,
    );
    if (!existing) return res.status(404).json({ error: "Review not found" });
    if (existing.userId !== userId)
      return res.status(403).json({ error: "Not your review" });
    await write(sql`DELETE r FROM review r WHERE r.id = ${id}`);
    return res.json({ success: true });
  } catch (e) {
    console.error("deleteReview", e);
    return res.status(500).json({ error: "Failed to delete review" });
  }
}

export async function createComment(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const reviewId = req.params.reviewId as string;
    const { comment } = req.body as { comment: string };
    if (!comment || typeof comment !== "string" || comment.trim().length < 2)
      return res
        .status(400)
        .json({ error: "Comment must be at least 2 characters" });
    const review = await one<Review>(
      sql`SELECT r.* FROM review r WHERE r.id = ${reviewId} LIMIT 1`,
    );
    if (!review) return res.status(404).json({ error: "Review not found" });
    const created = await insertRow<
      ReviewComment & { user: Pick<User, "id" | "name" | "image"> }
    >(
      (id) => sql`
      INSERT INTO
        reviewComment (id, reviewId, userId, comment)
      VALUES
        (${id}, ${reviewId}, ${userId}, ${comment.trim()})
    `,
      (id) => sql`
      SELECT
        rc.*,
        (
          SELECT
            JSON_OBJECT('id', u1.id, 'name', u1.name, 'image', u1.image)
          FROM
            \`user\` u1
          WHERE
            u1.id = rc.userId
        ) AS \`user\`
      FROM
        reviewComment rc
      WHERE
        rc.id = ${id}
    `,
    );
    return res.status(201).json({ comment: created });
  } catch (e) {
    console.error("createComment", e);
    return res.status(500).json({ error: "Failed to create comment" });
  }
}

export async function deleteComment(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const id = req.params.commentId as string;
    const existing = await one<ReviewComment>(
      sql`SELECT rc.* FROM reviewComment rc WHERE rc.id = ${id} LIMIT 1`,
    );
    if (!existing) return res.status(404).json({ error: "Comment not found" });
    if (existing.userId !== userId)
      return res.status(403).json({ error: "Not your comment" });
    await write(sql`DELETE rc FROM reviewComment rc WHERE rc.id = ${id}`);
    return res.json({ success: true });
  } catch (e) {
    console.error("deleteComment", e);
    return res.status(500).json({ error: "Failed to delete comment" });
  }
}
