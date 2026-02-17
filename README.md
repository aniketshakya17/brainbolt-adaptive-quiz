# BrainBolt

## Overview
- Adaptive quiz platform with strong consistency, Redis caching, and PostgreSQL durability.
- Frontend: Next.js (SSR for leaderboard/metrics, CSR for quiz). Backend: Express/Node with transactional flows.

## Key APIs
- `GET /v1/quiz/next?userId` → next question at nearest difficulty.
- `POST /v1/quiz/answer` → scores, adaptive update, leaderboard rank, idempotent response.
- `GET /v1/quiz/metrics?userId` → accuracy, histogram, recent answers.
- `GET /v1/leaderboard/score|streak?limit` and `/v1/leaderboard/rank?userId`.

## Consistency & Caching
- `SELECT ... FOR UPDATE` + single transaction per answer (decay, score, adaptive, log, leaderboard upsert).
- Idempotency stored post-commit in Redis (24h TTL); retries return cached response.
- Redis caches: user state (1h), metrics (30s), leaderboard tops (30s); invalidated after answer updates.

## Adaptive & Scoring (at-a-glance)
- Difficulty range 1–10; hysteresis with confidence ±2 and streak ≥2 to move up; reset confidence after step; inactivity halves streak and lowers confidence by 1.
- Score: `base = difficulty * 10`; `multiplier = min(1 + streak * 0.1, 2.0)`; correct → `base*multiplier`; wrong → `-5`; total score floor at 0.

## Running with Docker
- One command spins everything: `docker compose up --build`
- Services: Postgres (schema+seed auto-run), Redis, backend (:3000), frontend (:3001, talks to backend via service name).

## Edge-Case Handling
- Rate limit 20 answers/min (429).
- State version checked; mismatches rejected.
- Idempotent duplicate answers return stored response without mutation.
- Difficulty clamped; question fallback searches nearest difficulties.
- Score never negative; decay applied on inactivity before scoring.
