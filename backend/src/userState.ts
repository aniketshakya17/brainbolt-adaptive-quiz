import { query } from "./db";
import { getRedisClient } from "./redis";

export interface UserState {
  userId: string;
  currentDifficulty: number;
  streak: number;
  maxStreak: number;
  totalScore: number;
  stateVersion: number;
  confidence: number;
  lastAnswerAt?: string;
  lastQuestionId?: string;
}

const USER_STATE_PREFIX = "user_state:";
const TTL_SECONDS = 60 * 60; // 1 hour
const STREAK_DECAY_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_STATE: UserState = {
  userId: "",
  currentDifficulty: 1,
  streak: 0,
  maxStreak: 0,
  totalScore: 0,
  stateVersion: 1,
  confidence: 0,
  lastAnswerAt: undefined,
};

export async function getUserState(userId: string): Promise<UserState | null> {
  const redis = await getRedisClient();
  const cacheKey = USER_STATE_PREFIX + userId;

  const cached = await redis.get(cacheKey);
  if (cached) {
    const parsed: UserState = JSON.parse(cached);
    return applyDecay(parsed, redis, cacheKey);
  }

  const res = await query(
    "SELECT * FROM user_state WHERE user_id = $1",
    [userId],
  );

  if (res.rowCount === 0) {
    return null;
  }

  const raw = res.rows[0];
  const state = hydrateState(raw);

  await redis.set(cacheKey, JSON.stringify(state), { EX: TTL_SECONDS });

  return applyDecay(state, redis, cacheKey);
}

export async function updateUserState(userId: string, state: UserState): Promise<void> {
  const redis = await getRedisClient();
  const cacheKey = USER_STATE_PREFIX + userId;
  await redis.set(cacheKey, JSON.stringify(state), { EX: TTL_SECONDS });
}

export async function invalidateUserState(userId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.del(USER_STATE_PREFIX + userId);
}

function hydrateState(row: any): UserState {
  return {
    userId: row.user_id,
    currentDifficulty: Number(row.current_difficulty ?? DEFAULT_STATE.currentDifficulty),
    streak: Number(row.streak ?? DEFAULT_STATE.streak),
    maxStreak: Number(row.max_streak ?? DEFAULT_STATE.maxStreak),
    totalScore: Number(row.total_score ?? DEFAULT_STATE.totalScore),
    stateVersion: Number(row.state_version ?? DEFAULT_STATE.stateVersion),
    confidence: Number(row.confidence ?? DEFAULT_STATE.confidence),
    lastAnswerAt: row.last_answer_at ?? undefined,
    lastQuestionId: row.last_question_id ?? undefined,
  };
}

async function applyDecay(state: UserState, redis: any, cacheKey: string): Promise<UserState> {
  if (!state.lastAnswerAt) {
    return state;
  }

  const last = Date.parse(state.lastAnswerAt);
  if (Number.isNaN(last)) {
    return state;
  }

  if (Date.now() - last > STREAK_DECAY_MS && state.streak > 0) {
    const decayed: UserState = {
      ...state,
      streak: Math.floor(state.streak / 2),
      confidence: Math.max(state.confidence - 1, -2),
      stateVersion: state.stateVersion + 1,
    };
    await redis.set(cacheKey, JSON.stringify(decayed), { EX: TTL_SECONDS });
    await query(
      `UPDATE user_state SET streak = $1, confidence = $2, state_version = $3 WHERE user_id = $4`,
      [decayed.streak, decayed.confidence, decayed.stateVersion, state.userId],
    );
    return decayed;
  }

  return state;
}
