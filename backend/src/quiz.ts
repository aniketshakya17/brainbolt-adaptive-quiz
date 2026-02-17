import crypto from "crypto";
import { calculateScore } from "./score";
import { computeNextDifficulty } from "./adaptive";
import { QuestionRecord } from "./questions";
import { getRank, upsertLeaderboardTx, updateLeaderboardCaches } from "./leaderboard";
import { checkIdempotency, storeIdempotency } from "./idempotency";
import { UserState, updateUserState } from "./userState";
import { withTransaction } from "./db";
import { getRedisClient } from "./redis";

const INACTIVITY_DECAY_MS = 5 * 60 * 1000;
const RATE_LIMIT_PER_MINUTE = 20;

class RateLimitError extends Error {
  status: number;
  constructor(message: string) {
    super(message);
    this.status = 429;
  }
}

export interface SubmitAnswerBody {
  userId: string;
  questionId: string;
  answer: string;
  stateVersion: number;
  answerIdempotencyKey?: string;
}

export interface SubmitAnswerResponse {
  correct: boolean;
  newDifficulty: number;
  newConfidence: number;
  newStreak: number;
  scoreDelta: number;
  totalScore: number;
  stateVersion: number;
  leaderboardRankScore: number | null;
  leaderboardRankStreak: number | null;
  maxStreak?: number;
  answeredAt?: string;
}

export async function submitAnswer(body: SubmitAnswerBody): Promise<SubmitAnswerResponse> {
  const { userId, questionId, answer, stateVersion, answerIdempotencyKey } = body;

  if (!userId || !questionId || !answer) {
    throw new Error("Missing required fields");
  }

  if (!Number.isInteger(stateVersion)) {
    throw new Error("Invalid stateVersion");
  }

  const redis = await getRedisClient();
  const rateKey = `rate:${userId}`;
  const attempts = await redis.incr(rateKey);
  if (attempts === 1) {
    await redis.expire(rateKey, 60);
  }
  if (attempts > RATE_LIMIT_PER_MINUTE) {
    throw new RateLimitError("Rate limit exceeded");
  }

  if (answerIdempotencyKey) {
    const existing = await checkIdempotency(answerIdempotencyKey);
    if (existing) return JSON.parse(existing);
  }

  const result = await withTransaction<SubmitAnswerResponse>(async (client) => {
    // Lock user state for update
    const stateRes = await client.query(
      `SELECT user_id, current_difficulty, streak, max_streak, total_score, state_version, confidence, last_answer_at
       FROM user_state
       WHERE user_id = $1
       FOR UPDATE`,
      [userId],
    );

    if (stateRes.rowCount === 0) {
      throw new Error("User state not found");
    }

    const row = stateRes.rows[0];
    const lastAnswerAt = row.last_answer_at ? Date.parse(row.last_answer_at) : undefined;
    const decayMs = lastAnswerAt ? Date.now() - lastAnswerAt : 0;
    const decay = lastAnswerAt && decayMs > INACTIVITY_DECAY_MS;

    const currentState: UserState = {
      userId: row.user_id,
      currentDifficulty: Number(row.current_difficulty),
      streak: Number(row.streak),
      maxStreak: Number(row.max_streak),
      totalScore: Number(row.total_score),
      stateVersion: Number(row.state_version),
      confidence: Number(row.confidence ?? 0),
      lastAnswerAt: row.last_answer_at ?? undefined,
    };

    if (decay) {
      currentState.streak = Math.floor(currentState.streak / 2); // gradual decay
      currentState.confidence = Math.max(currentState.confidence - 1, -2);
      currentState.stateVersion += 1;
    }

    if (stateVersion !== currentState.stateVersion) {
      throw new Error("State version mismatch");
    }

    const questionRes = await client.query<QuestionRecord>(
      `SELECT id, difficulty, prompt, choices, correct_answer_hash FROM questions WHERE id = $1`,
      [questionId],
    );

    if (questionRes.rowCount === 0) {
      throw new Error("Question not found");
    }

    const question = questionRes.rows[0];
    const incomingHash = crypto.createHash("sha256").update(answer).digest("hex");
    const correct = incomingHash === question.correct_answer_hash;

    const newStreak = correct ? currentState.streak + 1 : 0;
    const newMaxStreak = Math.max(currentState.maxStreak, newStreak);

    const scoreDelta = calculateScore(question.difficulty, newStreak, correct);
    const newTotalScore = Math.max(0, currentState.totalScore + scoreDelta);

    const { nextDifficulty, nextConfidence } = computeNextDifficulty(
      currentState.currentDifficulty,
      correct,
      currentState.confidence,
      newStreak,
    );

    const newStateVersion = currentState.stateVersion + 1;
    const answeredAt = new Date().toISOString();

    await client.query(
      `UPDATE user_state
       SET streak = $1,
           max_streak = $2,
           total_score = $3,
           current_difficulty = $4,
           confidence = $5,
           state_version = $6,
           last_question_id = $7,
           last_answer_at = $8
       WHERE user_id = $9`,
      [
        newStreak,
        newMaxStreak,
        newTotalScore,
        nextDifficulty,
        nextConfidence,
        newStateVersion,
        questionId,
        answeredAt,
        userId,
      ],
    );

    await client.query(
      `INSERT INTO answer_log (
          user_id,
          question_id,
          difficulty,
          answer,
          correct,
          score_delta,
          streak_at_answer,
          confidence_after,
          answered_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        userId,
        questionId,
        question.difficulty,
        answer,
        correct,
        scoreDelta,
        newStreak,
        nextConfidence,
        answeredAt,
      ],
    );

    const { leaderboardRankScore, leaderboardRankStreak } = await upsertLeaderboardTx(
      client,
      userId,
      newTotalScore,
      newMaxStreak,
    );

    const response: SubmitAnswerResponse = {
      correct,
      newDifficulty: nextDifficulty,
      newConfidence: nextConfidence,
      newStreak,
      scoreDelta,
      totalScore: newTotalScore,
      stateVersion: newStateVersion,
      leaderboardRankScore,
      leaderboardRankStreak,
      maxStreak: newMaxStreak,
      answeredAt,
    };

    return response;
  });

  // Outside transaction: update caches/leaderboard/idempotency
  const cacheState: UserState = {
    userId,
    currentDifficulty: result.newDifficulty,
    streak: result.newStreak,
    maxStreak: result.maxStreak ?? result.newStreak,
    totalScore: result.totalScore,
    stateVersion: result.stateVersion,
    confidence: result.newConfidence,
    lastAnswerAt: result.answeredAt,
  };
  await updateLeaderboardCaches(userId, result.totalScore, cacheState.maxStreak);
  await updateUserState(userId, cacheState);
  await redis.del(`metrics:${userId}`);

  if (answerIdempotencyKey) {
    await storeIdempotency(answerIdempotencyKey, result);
  }

  return result;
}
