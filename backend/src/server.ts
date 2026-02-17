import express from "express";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import cors from "cors";
import { getQuestionByDifficulty } from "./questions";
import { submitAnswer } from "./quiz";
import { getUserState } from "./userState";
import { getUserMetrics } from "./metrics";
import { getTopByScore, getTopByStreak, getRank } from "./leaderboard";

dotenv.config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 100,
  })
);

// ✅ Health Check Route
app.get("/", (_req, res) => {
  res.json({
    status: "BrainBolt Backend Running 🚀",
    endpoints: {
      next: "GET /v1/quiz/next?userId=<uuid>",
      answer: "POST /v1/quiz/answer",
    },
  });
});

// ✅ Get Next Question
app.get("/v1/quiz/next", async (req, res, next) => {
  try {
    const { userId } = req.query as { userId: string };

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const state = await getUserState(userId);
    if (!state) {
      return res.status(404).json({ error: "User state not found" });
    }
    console.log("Current difficulty:", state.currentDifficulty);

    const question = await getQuestionByDifficulty(
      state.currentDifficulty,
      state.lastQuestionId,
    );

    if (!question) {
      return res.status(404).json({ error: "No question found" });
    }

    res.json({
      questionId: question.id,
      difficulty: question.difficulty,
      prompt: question.prompt,
      choices: question.choices,
      currentScore: state.totalScore,
      currentStreak: state.streak,
      stateVersion: state.stateVersion,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------
// GET USER METRICS
// ------------------------------------
app.get("/v1/quiz/metrics", async (req, res, next) => {
  try {
    const { userId } = req.query as { userId?: string };

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const metrics = await getUserMetrics(userId);
    return res.json(metrics);
  } catch (err) {
    next(err);
  }
});
// ----------------------------------
// Leaderboard by Score
// ----------------------------------
app.get("/v1/leaderboard/score", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 10;
    const data = await getTopByScore(limit);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ----------------------------------
// Leaderboard by Streak
// ----------------------------------
app.get("/v1/leaderboard/streak", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 10;
    const data = await getTopByStreak(limit);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ----------------------------------
// Leaderboard rank for a user (DB-backed)
// ----------------------------------
app.get("/v1/leaderboard/rank", async (req, res, next) => {
  try {
    const { userId } = req.query as { userId?: string };
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const rank = await getRank(userId);
    return res.json(rank);
  } catch (err) {
    next(err);
  }
});


// ✅ Submit Answer
app.post("/v1/quiz/answer", async (req, res, next) => {
  try {
    const result = await submitAnswer(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ✅ Global Error Handler
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error(err);
  const status = err.status ?? 500;
  res.status(status).json({
    error: status === 429 ? "Too Many Requests" : "Internal Server Error",
    message: err.message,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
});
