import { query } from "./db";
import { getRedisClient } from "./redis";
import { getUserState } from "./userState";

const METRICS_TTL_SECONDS = 30;

export async function getUserMetrics(userId: string) {
  const redis = await getRedisClient();
  const cacheKey = `metrics:${userId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const state = await getUserState(userId);
  if (!state) throw new Error("User state not found");

  const metricsRes = await query<{
    correct_count: string;
    total_count: string;
    histogram: { difficulty: number; count: number }[] | null;
    recent: { correct: boolean; difficulty: number; answered_at: string }[] | null;
  }>(
    `WITH agg AS (
        SELECT COUNT(*) FILTER (WHERE correct = true) AS correct_count,
               COUNT(*) AS total_count
        FROM answer_log
        WHERE user_id = $1
      ),
      hist AS (
        SELECT COALESCE(json_agg(json_build_object('difficulty', difficulty, 'count', cnt) ORDER BY difficulty), '[]'::json) AS histogram
        FROM (
          SELECT difficulty, COUNT(*) AS cnt
          FROM answer_log
          WHERE user_id = $1
          GROUP BY difficulty
        ) h
      ),
      recent AS (
        SELECT COALESCE(json_agg(row_to_json(r) ORDER BY answered_at DESC), '[]'::json) AS recent
        FROM (
          SELECT correct, difficulty, answered_at
          FROM answer_log
          WHERE user_id = $1
          ORDER BY answered_at DESC
          LIMIT 10
        ) r
      )
      SELECT agg.correct_count, agg.total_count, hist.histogram, recent.recent
      FROM agg, hist, recent`,
    [userId],
  );

  const row = metricsRes.rows[0];
  const totalCount = Number(row.total_count ?? 0);
  const correctCount = Number(row.correct_count ?? 0);
  const accuracy = totalCount === 0 ? 0 : correctCount / totalCount;

  const payload = {
    currentDifficulty: state.currentDifficulty,
    streak: state.streak,
    maxStreak: state.maxStreak,
    totalScore: state.totalScore,
    confidence: state.confidence,
    lastQuestionId: state.lastQuestionId,
    accuracy,
    difficultyHistogram: row.histogram ?? [],
    recentPerformance: row.recent ?? [],
  };

  await redis.set(cacheKey, JSON.stringify(payload), { EX: METRICS_TTL_SECONDS });
  return payload;
}
