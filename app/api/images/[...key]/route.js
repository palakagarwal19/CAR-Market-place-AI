import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const runtime = "nodejs";

const client = new S3Client({ region: process.env.AWS_REGION });

export async function GET(_request, { params }) {
  const { key } = await params;
  const objectKey = key.join("/");
  if (
    !objectKey.startsWith("cars/") ||
    key.some((segment) => segment === "." || segment === "..")
  ) {
    return new Response("Not found", { status: 404 });
  }

  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET is not configured");
  }

  const image = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: objectKey })
  );
  if (!image.Body) {
    throw new Error(`S3 returned an empty image body for ${objectKey}`);
  }

  return new Response(image.Body.transformToWebStream(), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": image.ContentType || "application/octet-stream",
    },
  });
}
