import type { Request, Response } from "express";
import {
  sql,
  one,
  rows,
  write,
  insertRow,
  updateRow,
  assignments,
  transaction,
} from "../db/pool.js";
import type { User, Product, Address, Phone, Review } from "../db/models.js";

export async function getProfile(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;

    const user = await one<
      User & { addresses: Address[]; phones: Phone[] }
    >(sql`
      SELECT
        u.*,
        COALESCE(
          (
            SELECT
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id',
                  a1.id,
                  'userId',
                  a1.userId,
                  'label',
                  a1.label,
                  'street',
                  a1.street,
                  'city',
                  a1.city,
                  'zip',
                  a1.zip,
                  'country',
                  a1.country,
                  'isDefault',
                  a1.isDefault,
                  'createdAt',
                  a1.createdAt,
                  'updatedAt',
                  a1.updatedAt
                )
              )
            FROM
              address a1
            WHERE
              a1.userId = u.id
          ),
          JSON_ARRAY()
        ) AS \`addresses\`,
        COALESCE(
          (
            SELECT
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id',
                  ph2.id,
                  'userId',
                  ph2.userId,
                  'number',
                  ph2.number,
                  'label',
                  ph2.label,
                  'isDefault',
                  ph2.isDefault,
                  'createdAt',
                  ph2.createdAt,
                  'updatedAt',
                  ph2.updatedAt
                )
              )
            FROM
              phone ph2
            WHERE
              ph2.userId = u.id
          ),
          JSON_ARRAY()
        ) AS \`phones\`
      FROM
        \`user\` u
      WHERE
        u.id = ${userId}
      LIMIT
        1
    `);

    if (!user) return res.status(404).json({ error: "User not found" });

    const defaultAddress =
      user.addresses.find((a) => a.isDefault) || user.addresses[0] || null;
    const defaultPhone =
      user.phones.find((p) => p.isDefault) || user.phones[0] || null;

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role,
      banned: user.banned,
      defaultAddress,
      defaultPhone,
      addresses: user.addresses,
      phones: user.phones,
    });
  } catch (error) {
    console.error("Get user profile error", error);
    return res.status(500).json({ error: "Failed to fetch user profile" });
  }
}

export async function updateProfile(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const { phone } = req.body as { phone: string };

    if (!phone) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    if (phone.trim().length < 7) {
      return res
        .status(400)
        .json({ error: "Phone number must be at least 7 characters" });
    }

    // Update or create default phone
    let defaultPhone = await one<Phone>(
      sql`SELECT ph.* FROM phone ph WHERE ph.userId = ${userId} AND ph.isDefault = ${true} LIMIT 1`,
    );

    if (defaultPhone) {
      await updateRow<Phone>(
        assignments([
          [sql`ph.number`, phone],
          [sql`ph.updatedAt`, new Date()],
        ]),
        (fields) =>
          sql`UPDATE phone ph SET ${fields} WHERE ph.id = ${defaultPhone.id}`,
        sql`SELECT ph.* FROM phone ph WHERE ph.id = ${defaultPhone.id}`,
      );
    } else {
      await insertRow<Phone>(
        (id) => sql`
      INSERT INTO
        phone (id, userId, label, number, isDefault)
      VALUES
        (${id}, ${userId}, ${"Mobile"}, ${phone}, ${true})
    `,
        (id) => sql`SELECT ph.* FROM phone ph WHERE ph.id = ${id}`,
      );
    }

    const user = await one<
      User & { addresses: Address[]; phones: Phone[] }
    >(sql`
      SELECT
        u.*,
        COALESCE(
          (
            SELECT
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id',
                  a1.id,
                  'userId',
                  a1.userId,
                  'label',
                  a1.label,
                  'street',
                  a1.street,
                  'city',
                  a1.city,
                  'zip',
                  a1.zip,
                  'country',
                  a1.country,
                  'isDefault',
                  a1.isDefault,
                  'createdAt',
                  a1.createdAt,
                  'updatedAt',
                  a1.updatedAt
                )
              )
            FROM
              address a1
            WHERE
              a1.userId = u.id
          ),
          JSON_ARRAY()
        ) AS \`addresses\`,
        COALESCE(
          (
            SELECT
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id',
                  ph2.id,
                  'userId',
                  ph2.userId,
                  'number',
                  ph2.number,
                  'label',
                  ph2.label,
                  'isDefault',
                  ph2.isDefault,
                  'createdAt',
                  ph2.createdAt,
                  'updatedAt',
                  ph2.updatedAt
                )
              )
            FROM
              phone ph2
            WHERE
              ph2.userId = u.id
          ),
          JSON_ARRAY()
        ) AS \`phones\`
      FROM
        \`user\` u
      WHERE
        u.id = ${userId}
      LIMIT
        1
    `);

    const defaultAddress =
      user?.addresses.find((a) => a.isDefault) || user?.addresses[0] || null;
    const defaultPhoneResult =
      user?.phones.find((p) => p.isDefault) || user?.phones[0] || null;

    return res.json({
      id: user?.id,
      name: user?.name,
      email: user?.email,
      image: user?.image,
      role: user?.role,
      banned: user?.banned,
      defaultAddress,
      defaultPhone: defaultPhoneResult,
      addresses: user?.addresses ?? [],
      phones: user?.phones ?? [],
    });
  } catch (error) {
    console.error("Update user profile error", error);
    return res.status(500).json({ error: "Failed to update user profile" });
  }
}

export async function getUserReviews(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;

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
            JSON_OBJECT('id', u1.id, 'name', u1.name, 'image', u1.image)
          FROM
            \`user\` u1
          WHERE
            u1.id = r.userId
        ) AS \`user\`,
        (
          SELECT
            JSON_OBJECT('id', p2.id, 'name', p2.name, 'images', JSON_EXTRACT(p2.images, '$'))
          FROM
            product p2
          WHERE
            p2.id = r.productId
        ) AS \`product\`
      FROM
        review r
      WHERE
        r.userId = ${userId}
      ORDER BY
        r.createdAt DESC
    `);

    return res.json({ reviews });
  } catch (error) {
    console.error("Get user reviews error", error);
    return res.status(500).json({ error: "Failed to fetch user reviews" });
  }
}

// Address CRUD
export async function listAddresses(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;

    const addresses = await rows<Address>(
      sql`SELECT a.* FROM address a WHERE a.userId = ${userId} ORDER BY a.isDefault DESC`,
    );

    return res.json({ addresses });
  } catch (error) {
    console.error("List addresses error", error);
    return res.status(500).json({ error: "Failed to fetch addresses" });
  }
}

export async function createAddress(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const { label, street, city, zip, country, isDefault } = req.body as {
      label: string;
      street: string;
      city: string;
      zip: string;
      country: string;
      isDefault?: boolean;
    };

    if (!label || !street || !city || !zip || !country) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      await write(
        sql`UPDATE address a SET a.isDefault = ${false} WHERE a.userId = ${userId} AND a.isDefault = ${true}`,
      );
    }

    const address = await insertRow<Address>(
      (id) => sql`
      INSERT INTO
        address (id, userId, label, street, city, zip, country, isDefault)
      VALUES
        (
          ${id},
          ${userId},
          ${label},
          ${street},
          ${city},
          ${zip},
          ${country},
          ${isDefault ?? false}
        )
    `,
      (id) => sql`SELECT a.* FROM address a WHERE a.id = ${id}`,
    );

    return res.status(201).json({ address });
  } catch (error) {
    console.error("Create address error", error);
    return res.status(500).json({ error: "Failed to create address" });
  }
}

export async function updateAddress(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const id = req.params.id as string;
    const { label, street, city, zip, country, isDefault } = req.body as {
      label?: string;
      street?: string;
      city?: string;
      zip?: string;
      country?: string;
      isDefault?: boolean;
    };

    // Verify ownership
    const existing = await one<Address>(
      sql`SELECT a.* FROM address a WHERE a.id = ${id} AND a.userId = ${userId} LIMIT 1`,
    );

    if (!existing) {
      return res.status(404).json({ error: "Address not found" });
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      await write(sql`
      UPDATE address a
      SET
        a.isDefault = ${false}
      WHERE
        a.userId = ${userId}
        AND a.isDefault = ${true}
        AND a.id <> ${id}
    `);
    }

    const address = await updateRow<Address>(
      assignments([
        [sql`a.label`, label],
        [sql`a.street`, street],
        [sql`a.city`, city],
        [sql`a.zip`, zip],
        [sql`a.country`, country],
        [sql`a.isDefault`, isDefault],
      ]),
      (fields) => sql`UPDATE address a SET ${fields} WHERE a.id = ${id}`,
      sql`SELECT a.* FROM address a WHERE a.id = ${id}`,
    );

    return res.json({ address });
  } catch (error) {
    console.error("Update address error", error);
    return res.status(500).json({ error: "Failed to update address" });
  }
}

export async function deleteAddress(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const id = req.params.id as string;

    const existing = await one<Address>(
      sql`SELECT a.* FROM address a WHERE a.id = ${id} AND a.userId = ${userId} LIMIT 1`,
    );

    if (!existing) {
      return res.status(404).json({ error: "Address not found" });
    }

    await write(sql`DELETE a FROM address a WHERE a.id = ${id}`);

    return res.json({ success: true });
  } catch (error) {
    console.error("Delete address error", error);
    return res.status(500).json({ error: "Failed to delete address" });
  }
}

export async function setDefaultAddress(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const id = req.params.id as string;

    const existing = await one<Address>(
      sql`SELECT a.* FROM address a WHERE a.id = ${id} AND a.userId = ${userId} LIMIT 1`,
    );

    if (!existing) {
      return res.status(404).json({ error: "Address not found" });
    }

    await transaction(async (connection) => {
      await one(
        sql`SELECT id FROM \`user\` WHERE id = ${userId} FOR UPDATE`,
        connection,
      );
      await write(
        sql`UPDATE address SET isDefault = (id = ${id}) WHERE userId = ${userId}`,
        connection,
      );
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Set default address error", error);
    return res.status(500).json({ error: "Failed to set default address" });
  }
}

// Phone CRUD
export async function listPhones(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;

    const phones = await rows<Phone>(
      sql`SELECT ph.* FROM phone ph WHERE ph.userId = ${userId} ORDER BY ph.isDefault DESC`,
    );

    return res.json({ phones });
  } catch (error) {
    console.error("List phones error", error);
    return res.status(500).json({ error: "Failed to fetch phones" });
  }
}

export async function createPhone(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const { label, number, isDefault } = req.body as {
      label: string;
      number: string;
      isDefault?: boolean;
    };

    if (!label || !number) {
      return res.status(400).json({ error: "Label and number are required" });
    }

    if (number.trim().length < 7) {
      return res
        .status(400)
        .json({ error: "Phone number must be at least 7 characters" });
    }

    if (isDefault) {
      await write(
        sql`UPDATE phone ph SET ph.isDefault = ${false} WHERE ph.userId = ${userId} AND ph.isDefault = ${true}`,
      );
    }

    const phone = await insertRow<Phone>(
      (id) => sql`
      INSERT INTO
        phone (id, userId, label, number, isDefault)
      VALUES
        (${id}, ${userId}, ${label}, ${number}, ${isDefault ?? false})
    `,
      (id) => sql`SELECT ph.* FROM phone ph WHERE ph.id = ${id}`,
    );

    return res.status(201).json({ phone });
  } catch (error) {
    console.error("Create phone error", error);
    return res.status(500).json({ error: "Failed to create phone" });
  }
}

export async function updatePhone(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const id = req.params.id as string;
    const { label, number, isDefault } = req.body as {
      label?: string;
      number?: string;
      isDefault?: boolean;
    };

    const existing = await one<Phone>(
      sql`SELECT ph.* FROM phone ph WHERE ph.id = ${id} AND ph.userId = ${userId} LIMIT 1`,
    );

    if (!existing) {
      return res.status(404).json({ error: "Phone not found" });
    }

    if (number && number.trim().length < 7) {
      return res
        .status(400)
        .json({ error: "Phone number must be at least 7 characters" });
    }

    if (isDefault) {
      await write(sql`
      UPDATE phone ph
      SET
        ph.isDefault = ${false}
      WHERE
        ph.userId = ${userId}
        AND ph.isDefault = ${true}
        AND ph.id <> ${id}
    `);
    }

    const phone = await updateRow<Phone>(
      assignments([
        [sql`ph.label`, label],
        [sql`ph.number`, number],
        [sql`ph.isDefault`, isDefault],
      ]),
      (fields) => sql`UPDATE phone ph SET ${fields} WHERE ph.id = ${id}`,
      sql`SELECT ph.* FROM phone ph WHERE ph.id = ${id}`,
    );

    return res.json({ phone });
  } catch (error) {
    console.error("Update phone error", error);
    return res.status(500).json({ error: "Failed to update phone" });
  }
}

export async function deletePhone(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const id = req.params.id as string;

    const existing = await one<Phone>(
      sql`SELECT ph.* FROM phone ph WHERE ph.id = ${id} AND ph.userId = ${userId} LIMIT 1`,
    );

    if (!existing) {
      return res.status(404).json({ error: "Phone not found" });
    }

    await write(sql`DELETE ph FROM phone ph WHERE ph.id = ${id}`);

    return res.json({ success: true });
  } catch (error) {
    console.error("Delete phone error", error);
    return res.status(500).json({ error: "Failed to delete phone" });
  }
}

export async function setDefaultPhone(req: Request, res: Response) {
  try {
    const session = (req as any).session;
    const userId = session.user.id as string;
    const id = req.params.id as string;

    const existing = await one<Phone>(
      sql`SELECT ph.* FROM phone ph WHERE ph.id = ${id} AND ph.userId = ${userId} LIMIT 1`,
    );

    if (!existing) {
      return res.status(404).json({ error: "Phone not found" });
    }

    await transaction(async (connection) => {
      await one(
        sql`SELECT id FROM \`user\` WHERE id = ${userId} FOR UPDATE`,
        connection,
      );
      await write(
        sql`UPDATE phone SET isDefault = (id = ${id}) WHERE userId = ${userId}`,
        connection,
      );
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Set default phone error", error);
    return res.status(500).json({ error: "Failed to set default phone" });
  }
}
