import { getRedisClient } from "./redis";

const IDEMP_PREFIX = "idemp:";
const IDEMP_TTL_SECONDS = 60 * 60 * 24; // 24h TTL per spec

export async function checkIdempotency(key: string) {
  const redis = await getRedisClient();
  return redis.get(IDEMP_PREFIX + key);
}

export async function storeIdempotency(key: string, response: any) {
  const redis = await getRedisClient();
  await redis.set(IDEMP_PREFIX + key, JSON.stringify(response), { EX: IDEMP_TTL_SECONDS });
}
