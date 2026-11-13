import { UploadThingError } from "uploadthing/server";
import { createUploadthing, type FileRouter } from "uploadthing/express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";

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
  return { userId: session.user.id };
}

export const uploadRouter = {
  productImageUploader: f({
    image: {
      maxFileSize: "8MB",
      maxFileCount: 5,
    },
  })
    .middleware(({ req }) => requireUploadUser(req, true))
    .onUploadComplete(({ metadata, file }) => {
      console.log("Product image uploaded:", file.name);
      return { url: file.url, name: file.name, size: file.size };
    }),

  avatarUploader: f({
    image: {
      maxFileSize: "2MB",
      maxFileCount: 1,
    },
  })
    .middleware(({ req }) => requireUploadUser(req))
    .onUploadComplete(({ metadata, file }) => {
      console.log("Avatar uploaded:", file.name);
      return { url: file.url, name: file.name, size: file.size };
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof uploadRouter;
