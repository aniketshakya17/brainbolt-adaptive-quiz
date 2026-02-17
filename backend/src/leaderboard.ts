import { PoolClient } from "pg";
import { query } from "./db";
import { getRedisClient } from "./redis";

const SCORE_SET_KEY = "leaderboard:score";
const STREAK_SET_KEY = "leaderboard:streak";
const TOP_CACHE_TTL_SECONDS = 30;

export interface LeaderboardEntry {
  userId: string;
  totalScore: number;
  maxStreak: number;
  rank: number;
}

export async function upsertLeaderboardTx(
  client: PoolClient,
  userId: string,
  totalScore: number,
  maxStreak: number,
): Promise<{ leaderboardRankScore: number; leaderboardRankStreak: number }> {
  await client.query(
    `INSERT INTO leaderboard_score (user_id, total_score, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET total_score = EXCLUDED.total_score, updated_at = NOW()`,
    [userId, totalScore],
  );

  await client.query(
    `INSERT INTO leaderboard_streak (user_id, max_streak, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET max_streak = EXCLUDED.max_streak, updated_at = NOW()`,
    [userId, maxStreak],
  );

  const rankScoreRes = await client.query<{ rank: number }>(
    `SELECT COUNT(*)::int + 1 AS rank FROM leaderboard_score WHERE total_score > $1`,
    [totalScore],
  );
  const rankStreakRes = await client.query<{ rank: number }>(
    `SELECT COUNT(*)::int + 1 AS rank FROM leaderboard_streak WHERE max_streak > $1`,
    [maxStreak],
  );

  return {
    leaderboardRankScore: rankScoreRes.rows[0].rank,
    leaderboardRankStreak: rankStreakRes.rows[0].rank,
  };
}

export async function getTopByScore(limit = 10): Promise<LeaderboardEntry[]> {
  return getTop("score", SCORE_SET_KEY, limit);
}

export async function getTopByStreak(limit = 10): Promise<LeaderboardEntry[]> {
  return getTop("streak", STREAK_SET_KEY, limit);
}

export async function getRank(userId: string): Promise<{ leaderboardRankScore: number | null; leaderboardRankStreak: number | null }> {
  const [scoreRes, streakRes] = await Promise.all([
    query<{ rank: number }>(
      `SELECT COUNT(*)::int + 1 AS rank FROM leaderboard_score WHERE total_score > COALESCE((
         SELECT total_score FROM leaderboard_score WHERE user_id = $1
       ), -1)`,
      [userId],
    ),
    query<{ rank: number }>(
      `SELECT COUNT(*)::int + 1 AS rank FROM leaderboard_streak WHERE max_streak > COALESCE((
         SELECT max_streak FROM leaderboard_streak WHERE user_id = $1
       ), -1)`,
      [userId],
    ),
  ]);

  // If user not present in leaderboard tables, return null ranks
  const hasScore = await query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM leaderboard_score WHERE user_id = $1) AS exists`,
    [userId],
  );
  const hasStreak = await query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM leaderboard_streak WHERE user_id = $1) AS exists`,
    [userId],
  );

  return {
    leaderboardRankScore: hasScore.rows[0].exists ? scoreRes.rows[0].rank : null,
    leaderboardRankStreak: hasStreak.rows[0].exists ? streakRes.rows[0].rank : null,
  };
}

export async function updateLeaderboardCaches(userId: string, totalScore: number, maxStreak: number): Promise<void> {
  const redis = await getRedisClient();
  await Promise.all([
    redis.zAdd(SCORE_SET_KEY, [{ score: totalScore, value: userId }]),
    redis.zAdd(STREAK_SET_KEY, [{ score: maxStreak, value: userId }]),
  ]);

  await Promise.all([
    redis.del(cacheKeyForTop("score")),
    redis.del(cacheKeyForTop("streak")),
  ]);
}

async function getTop(kind: "score" | "streak", setKey: string, limit: number): Promise<LeaderboardEntry[]> {
  const redis = await getRedisClient();
  const safeLimit = Math.max(1, Math.floor(limit));
  const cacheKey = cacheKeyForTop(kind, safeLimit);

  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as LeaderboardEntry[];
  }

  const raw = await redis.zRangeWithScores(setKey, 0, safeLimit - 1, { REV: true });
  const entries: LeaderboardEntry[] = await Promise.all(
    raw.map(async (item, index) => {
      const [score, streak] = await Promise.all([
        kind === "score" ? Promise.resolve(item.score) : redis.zScore(SCORE_SET_KEY, item.value),
        kind === "streak" ? Promise.resolve(item.score) : redis.zScore(STREAK_SET_KEY, item.value),
      ]);

      return {
        userId: item.value,
        totalScore: Number(score ?? 0),
        maxStreak: Number(streak ?? 0),
        rank: index + 1,
      };
    }),
  );

  await redis.set(cacheKey, JSON.stringify(entries), { EX: TOP_CACHE_TTL_SECONDS });
  return entries;
}

function cacheKeyForTop(kind: "score" | "streak", limit = 10): string {
  return `leaderboard:cache:${kind}:${limit}`;
}
