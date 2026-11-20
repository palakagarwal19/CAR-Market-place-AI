import { headers } from "next/headers";

const buckets = new Map();
const capacity = 10;
const intervalMs = 60 * 60 * 1000;

export async function allowImageSearch() {
  const requestHeaders = await headers();
  const forwardedFor = requestHeaders.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",").pop()?.trim() || "unknown";
  const now = Date.now();
  const bucket = buckets.get(clientIp);

  if (!bucket && buckets.size >= 5000) {
    for (const [ip, entry] of buckets) {
      if (now - entry.updatedAt > intervalMs) {
        buckets.delete(ip);
      }
    }

    if (buckets.size >= 5000) {
      return false;
    }
  }

  if (!bucket) {
    buckets.set(clientIp, { tokens: capacity - 1, updatedAt: now });
    return true;
  }

  const tokens = Math.min(
    capacity,
    bucket.tokens + ((now - bucket.updatedAt) * capacity) / intervalMs
  );
  if (tokens < 1) {
    return false;
  }

  buckets.set(clientIp, { tokens: tokens - 1, updatedAt: now });

  return true;
}
