# BrainBolt Backend LLD

## Module Responsibilities
- **server.ts**: Configures Express app, applies rate limiting, exposes quiz APIs, orchestrates transactions, and coordinates scoring, adaptive difficulty, persistence, and caching.
- **questions.ts**: Holds static quiz question bank and lookup helper by difficulty.
- **adaptive.ts**: Encapsulates next-difficulty selection logic with boundary and streak rules.
- **score.ts**: Computes score deltas, streak updates, and multiplier caps.
- **userState.ts**: Manages user state persistence via Redis hashes with optional PostgreSQL transaction participation and inactivity streak decay.
- **leaderboard.ts**: Updates and reads Redis sorted-set leaderboards for score and streak rankings.
- **idempotency.ts**: Stores in-memory responses keyed by answer idempotency tokens.
- **db.ts**: Provides PostgreSQL connection pooling and helper utilities.
- **redis.ts**: Lazily instantiates and reuses a shared Redis client.

## API Schemas
- **GET /v1/quiz/next**
  - Query: `userId` (string, required)
  - Response: `{ questionId, difficulty, prompt, choices, currentScore, currentStreak, stateVersion }`
- **POST /v1/quiz/answer**
  - Body: `{ userId, questionId, answer, stateVersion, answerIdempotencyKey? }`
  - Response: `{ correct, newDifficulty, newStreak, scoreDelta, totalScore, stateVersion }`
- **GET /v1/quiz/metrics**
  - Query: `userId` (string, required)
  - Response: `{ currentDifficulty, streak, maxStreak, totalScore, accuracy, difficultyHistogram }`
# BrainBolt Low-Level Design

## Architecture

```
[Next.js (frontend)] --REST--> [Express/Node backend]
                 |---> [PostgreSQL]
                 \---> [Redis]
```
- Frontend uses the app router (SSR for leaderboard/metrics) and talks to REST endpoints.
- Backend handles quiz logic, strong transactions, and cache coordination.
- PostgreSQL stores user_state, questions, answer_log, and durable leaderboard mirrors.
- Redis covers fast paths: user state cache, metrics cache, leaderboard top cache, rate limiting, and idempotency keys.

## Adaptive Algorithm (pseudocode)
```
input: currentDifficulty, correct, confidence, streak, lastAnswerAt
const MIN = 1, MAX = 10
const STEP_CONFIDENCE = 2      // hysteresis band
const INACTIVITY_DECAY_MS = 5 minutes

if (now - lastAnswerAt > INACTIVITY_DECAY_MS):
  streak = 0
  stateVersion += 1

if correct:
  confidence += 1
  streak += 1
else:
  confidence -= 1
  streak = 0

if confidence >= STEP_CONFIDENCE:
  currentDifficulty += 1
  confidence = 0            // reset after jump (hysteresis)
elif confidence <= -STEP_CONFIDENCE:
  currentDifficulty -= 1
  confidence = 0            // reset after drop

currentDifficulty = clamp(currentDifficulty, MIN, MAX)
confidence = clamp(confidence, -STEP_CONFIDENCE, STEP_CONFIDENCE)
```
- Minimum streak to increase arises from needing two confidence increments (hysteresis) before moving up.
- Confidence stabilizer + hysteresis prevents ping-pong.
- Inactivity decay zeros streak first; stateVersion bumps for concurrency safety.
- Difficulty always clamped 1–10.

## Scoring Formula
```
base = difficulty * 10
multiplier = min(1 + streak * 0.1, 2.0)
score = correct ? base * multiplier : 0
```
- Capped multiplier prevents runaway inflation while still rewarding streaks.

## Database Schema & Indexes
- `user_state(user_id PK, current_difficulty, streak, max_streak, total_score, confidence, state_version, last_answer_at, last_question_id)`
- `questions(id PK, difficulty, prompt, choices, correct_answer_hash, tags)`
- `answer_log(id PK, user_id, question_id, difficulty, correct, score_delta, streak_at_answer, confidence_after, answered_at)`
- `leaderboard_score(user_id PK, total_score, updated_at)`
- `leaderboard_streak(user_id PK, max_streak, updated_at)`

Indexes (required):
```
CREATE INDEX idx_answer_user ON answer_log(user_id);
CREATE INDEX idx_answer_user_diff ON answer_log(user_id, difficulty);
CREATE INDEX idx_lb_score ON leaderboard_score(total_score DESC);
CREATE INDEX idx_lb_streak ON leaderboard_streak(max_streak DESC);
```

## Cache Strategy
- **User state** → Redis, TTL 1h. Refresh after each answer.
- **Metrics** → Redis, TTL 30s. Invalidated after every answer.
- **Leaderboard tops** → Redis cached zsets (30s). DB is the source of truth for ranks; caches invalidated on score/streak update.
- **Idempotency** → Redis, TTL 24h. Stored after successful commit; replay serves cached response.

## Invalidation Strategy
- After `submitAnswer` commit: refresh user state cache, update leaderboard caches, delete metrics cache, store idempotent response.
- Leaderboard cache keys `leaderboard:cache:*` deleted whenever score/streak updates.
- Metrics cache key `metrics:{userId}` deleted after each answer.

## Request Flows
- **/v1/quiz/next**: read cached user state → fetch nearest-difficulty question (Redis pool + DB fallback) → return prompt.
- **/v1/quiz/answer**: rate-limit check → idempotency check → DB transaction (lock state, apply decay, score, adaptive step, log answer, upsert leaderboard, compute ranks) → commit → refresh caches → store idempotency.
- **/v1/leaderboard/***: read Redis cached tops; `/rank` computes ranks from DB.
- **/v1/quiz/metrics**: serve from Redis (30s) else single SQL aggregate.

## Docker/Runtime
- `docker-compose` starts postgres, redis, backend, frontend. Backend uses `DATABASE_URL` and `REDIS_URL`; schema + seed auto-run. Frontend uses `NEXT_PUBLIC_API_URL` to call backend; `NEXT_PUBLIC_USER_ID` selects the demo user.

## Module Responsibilities (backend)
- `adaptive.ts`: computes next difficulty with confidence + streak hysteresis and clamping.
- `score.ts`: deterministic score with difficulty weight, streak multiplier cap, and wrong-answer penalty.
- `quiz.ts`: answer submission orchestration (rate limit, idempotency, transaction, decay, scoring, adaptive, logging, leaderboard upsert, cache invalidation).
- `questions.ts`: nearest-difficulty question fetch with Redis pool cache.
- `userState.ts`: Redis-backed user state cache, hydrate/decay, TTL management.
- `leaderboard.ts`: DB-backed leaderboard upserts/ranks; Redis cached tops.
- `metrics.ts`: single-query aggregates + 30s cache.
- `idempotency.ts`: 24h Redis idempotent responses.
- `redis.ts`/`db.ts`: connection helpers.

## API Schemas (key endpoints)
- `GET /v1/quiz/next?userId`: `{ questionId, difficulty, prompt, choices, currentScore, currentStreak, stateVersion }`
- `POST /v1/quiz/answer`: `{ userId, questionId, answer, stateVersion, answerIdempotencyKey? }` → `{ correct, newDifficulty, newConfidence, newStreak, scoreDelta, totalScore, stateVersion, leaderboardRankScore, leaderboardRankStreak, maxStreak, answeredAt }`
- `GET /v1/quiz/metrics?userId`: `{ currentDifficulty, streak, maxStreak, totalScore, confidence, accuracy, difficultyHistogram, recentPerformance }`
- `GET /v1/leaderboard/score|streak?limit`: `[{ userId, totalScore, maxStreak, rank }]`
- `GET /v1/leaderboard/rank?userId`: `{ leaderboardRankScore, leaderboardRankStreak }`

## Score & Adaptive Notes
- Score: `base = difficulty * 10`; `multiplier = min(1 + streak * 0.1, 2.0)`; correct → `base * multiplier`; wrong → `-5`; total score clamped to ≥ 0.
- Adaptive: confidence ±2 threshold with streak ≥2 to move up; confidence reset after a step; clamp difficulty 1–10; inactivity decay halves streak and lowers confidence by 1 before scoring.

## Cache Strategy (summary)
- User state: Redis 1h TTL; refreshed after answers.
- Metrics: Redis 30s TTL; invalidated after answers.
- Leaderboard tops: Redis cached zsets (30s); invalidated on updates; DB for ranks.
- Idempotency: Redis 24h; write after commit; replay returns cached response.

## Consistency Guarantees
- `SELECT ... FOR UPDATE` on user_state; all mutations + leaderboard upsert inside one transaction.
- Idempotent responses stored post-commit; duplicates short-circuit.
- Redis/state/metrics caches updated only after commit.
- State version incremented on decay and update; mismatches rejected.

## Edge Cases
- Streak reset on wrong; decay halves streak after 5m inactivity and lowers confidence.
- Difficulty clamped 1–10; ping-pong reduced via hysteresis and streak threshold.
- Duplicate submissions served from idempotency store; rate limit returns 429.
- Total score never negative; fallback to nearest difficulty for questions; missing user state → 404.
