import { UploadThingError } from "uploadthing/server";
import { createUploadthing, type FileRouter } from "uploadthing/express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";
import { one, sql, write } from "../db/pool.js";

const f = createUploadthing();

async function requireUploadUser(
  req: import("express").Request,
  sellerOnly = false,
) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (
    !session ||
    session.user.banned ||
    (sellerOnly && session.user.role !== "seller")
  ) {
    throw new UploadThingError({
      code: "FORBIDDEN",
      message: "Upload is not allowed",
    });
  }
  if (sellerOnly) {
    const seller = await one(
      sql`SELECT id FROM seller WHERE userId = ${session.user.id} AND approved = TRUE`,
    );
    if (!seller)
      throw new UploadThingError({
        code: "FORBIDDEN",
        message: "Seller approval is required",
      });
  }
  return { userId: session.user.id };
}

async function recordUpload(userId: string, fileKey: string) {
  await write(sql`
    INSERT INTO uploadedFile (fileKey, userId) VALUES (${fileKey}, ${userId})
    ON DUPLICATE KEY UPDATE fileKey = fileKey
  `);
}

export const uploadRouter = {
  productImageUploader: f({
    image: {
      maxFileSize: "8MB",
      maxFileCount: 5,
    },
  })
    .middleware(({ req }) => requireUploadUser(req, true))
    .onUploadComplete(async ({ metadata, file }) => {
      await recordUpload(metadata.userId, file.key);
      console.log("Product image uploaded:", file.name);
      return { url: file.ufsUrl, name: file.name, size: file.size };
    }),

  avatarUploader: f({
    image: {
      maxFileSize: "2MB",
      maxFileCount: 1,
    },
  })
    .middleware(({ req }) => requireUploadUser(req))
    .onUploadComplete(async ({ metadata, file }) => {
      await recordUpload(metadata.userId, file.key);
      console.log("Avatar uploaded:", file.name);
      return { url: file.ufsUrl, name: file.name, size: file.size };
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof uploadRouter;
