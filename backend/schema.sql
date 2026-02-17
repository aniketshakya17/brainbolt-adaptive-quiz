CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================
-- USERS
-- =========================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =========================
-- QUESTIONS
-- =========================
CREATE TABLE IF NOT EXISTS questions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    difficulty INT NOT NULL CHECK (difficulty BETWEEN 1 AND 10),
    prompt TEXT NOT NULL,
    choices JSONB NOT NULL,
    correct_answer_hash TEXT NOT NULL,
    tags TEXT[],
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index for adaptive lookup
CREATE INDEX idx_questions_difficulty 
ON questions(difficulty);

-- =========================
-- USER STATE
-- =========================
CREATE TABLE IF NOT EXISTS user_state (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

    current_difficulty INT NOT NULL DEFAULT 1,
    streak INT NOT NULL DEFAULT 0,
    max_streak INT NOT NULL DEFAULT 0,
    total_score BIGINT NOT NULL DEFAULT 0,

    correct_count INT NOT NULL DEFAULT 0,
    wrong_count INT NOT NULL DEFAULT 0,

    confidence INT NOT NULL DEFAULT 0,

    last_question_id UUID,
    last_answer_at TIMESTAMP,
    
    state_version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_state_user_id ON user_state(user_id);

-- =========================
-- ANSWER LOG
-- =========================
CREATE TABLE answer_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  question_id UUID NOT NULL REFERENCES questions(id),
  difficulty INT NOT NULL,
  answer TEXT NOT NULL,
  correct BOOLEAN NOT NULL,
  score_delta INT NOT NULL,
  streak_at_answer INT NOT NULL,
  confidence_after INT NOT NULL DEFAULT 0,
  answered_at TIMESTAMP DEFAULT NOW()
);

-- Optimized for metrics & recent performance
CREATE INDEX idx_answer_user_time 
ON answer_log(user_id, answered_at DESC);

CREATE INDEX idx_answer_user_difficulty
ON answer_log(user_id, difficulty);

CREATE INDEX IF NOT EXISTS idx_answer_log_user_id ON answer_log(user_id);

-- =========================
-- LEADERBOARD TABLES (Persistent backup)
-- Redis is primary, DB is backup
-- =========================
CREATE TABLE IF NOT EXISTS leaderboard_score (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_score BIGINT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_leaderboard_score 
ON leaderboard_score(total_score DESC);

CREATE INDEX IF NOT EXISTS idx_leaderboard_score_score ON leaderboard_score(total_score DESC);

CREATE TABLE IF NOT EXISTS leaderboard_streak (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    max_streak INT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_leaderboard_streak 
ON leaderboard_streak(max_streak DESC);

CREATE INDEX IF NOT EXISTS idx_leaderboard_streak_streak ON leaderboard_streak(max_streak DESC);
