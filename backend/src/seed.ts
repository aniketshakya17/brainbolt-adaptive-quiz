import crypto from "crypto";
import { pool } from "./db";
import { questionsSeed } from "./questionsSeed";

const DEMO_USER_ID =
  process.env.SEED_USER_ID || "11111111-1111-1111-1111-111111111111";

async function main(): Promise<void> {
  const client = await pool.connect();

  let insertedQuestions = 0;
  let skippedQuestions = 0;

  try {
    await client.query("BEGIN");

    // -------------------------
    // Ensure demo user exists
    // -------------------------
    await client.query(
      `
      INSERT INTO users (id)
      VALUES ($1)
      ON CONFLICT (id) DO NOTHING
      `,
      [DEMO_USER_ID]
    );

    // -------------------------
    // Ensure user_state exists
    // -------------------------
    await client.query(
      `
      INSERT INTO user_state (
        user_id,
        current_difficulty,
        streak,
        max_streak,
        total_score,
        state_version,
        confidence
      )
      VALUES ($1, 1, 0, 0, 0, 1, 0)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [DEMO_USER_ID]
    );

    // -------------------------
    // Insert Questions
    // -------------------------
    for (const q of questionsSeed) {
      const correctHash = crypto
        .createHash("sha256")
        .update(q.correctAnswer)
        .digest("hex");

      const res = await client.query(
        `
        INSERT INTO questions (
          difficulty,
          prompt,
          choices,
          correct_answer_hash,
          tags
        )
        SELECT $1, $2, $3, $4, $5
        WHERE NOT EXISTS (
          SELECT 1
          FROM questions
          WHERE prompt = $2
            AND difficulty = $1
        )
        RETURNING id
        `,
        [
          q.difficulty,
          q.prompt,
          JSON.stringify(q.choices),
          correctHash,
          q.tags,
        ]
      );

      if (res.rows.length > 0) {
        insertedQuestions++;
      } else {
        skippedQuestions++;
      }
    }

    await client.query("COMMIT");

    console.log("✅ Seeding successful");
    console.log(`Inserted: ${insertedQuestions}`);
    console.log(`Skipped (already exists): ${skippedQuestions}`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Seed failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
