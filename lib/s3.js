import {
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const bucket = process.env.S3_BUCKET;
const region = process.env.AWS_REGION;
const client = new S3Client({ region });

function getRequiredBucket() {
  if (!bucket) {
    throw new Error("S3_BUCKET is not configured");
  }

  return bucket;
}

export async function uploadCarImage({ key, body, contentType }) {
  const bucketName = getRequiredBucket();

  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=300",
    })
  );

  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `/api/images/${encodedKey}`;
}

export async function deleteCarImages(imageUrls) {
  const allowedHosts = new Set(
    bucket ? [`${bucket}.s3.${region}.amazonaws.com`] : []
  );
  const keys = imageUrls.flatMap((imageUrl) => {
    try {
      if (imageUrl.startsWith("/cars/")) {
        return [decodeURIComponent(imageUrl.slice(1))];
      }
      if (imageUrl.startsWith("/api/images/cars/")) {
        return [
          decodeURIComponent(imageUrl.slice("/api/images/".length)),
        ];
      }

      const url = new URL(imageUrl);
      if (!allowedHosts.has(url.hostname)) {
        return [];
      }

      const objectPath = url.pathname.startsWith("/api/images/cars/")
        ? url.pathname.slice("/api/images/".length)
        : url.pathname.startsWith("/cars/")
          ? url.pathname.slice(1)
          : null;
      return objectPath ? [decodeURIComponent(objectPath)] : [];
    } catch {
      return [];
    }
  });

  if (keys.length === 0) {
    return;
  }

  const bucketName = getRequiredBucket();
  const response = await client.send(
    new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: {
        Objects: keys.map((Key) => ({ Key })),
        Quiet: true,
      },
    })
  );

  if (response.Errors?.length) {
    throw new Error(
      `Failed to delete ${response.Errors.length} car image(s) from S3`
    );
  }
}
