import { createClient, RedisClientType } from "redis";

const DEFAULT_REDIS_URL = "redis://localhost:6379";

let client: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL ?? DEFAULT_REDIS_URL });
    client.on("error", (err) => {
      console.error("Redis connection error", err);
    });
    await client.connect();
  }

  return client;
}

export async function closeRedisClient(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
