import { query } from "./db";

const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;

export interface Choice {
  id: string;
  text: string;
}

export interface QuestionRecord {
  id: string;
  difficulty: number;
  prompt: string;
  choices: Choice[];
  correct_answer_hash?: string;
}

export async function getQuestionByDifficulty(targetDifficulty: number, lastQuestionId?: string): Promise<QuestionRecord | null> {
  // Primary: same difficulty, avoid immediate repeat
  const primary = await query<QuestionRecord>(
    `SELECT id, difficulty, prompt, choices, correct_answer_hash
     FROM questions
     WHERE difficulty = $1
       AND ($2::uuid IS NULL OR id <> $2::uuid)
     ORDER BY RANDOM()
     LIMIT 1`,
    [targetDifficulty, lastQuestionId ?? null],
  );

if (primary.rows.length > 0) {
  return hydrate(primary.rows[0]);
}

  // Fallback: nearest difficulty, still avoid immediate repeat
  const fallback = await query<QuestionRecord>(
    `SELECT id, difficulty, prompt, choices, correct_answer_hash
     FROM questions
     WHERE ($2::uuid IS NULL OR id <> $2::uuid)
     ORDER BY ABS(difficulty - $1), RANDOM()
     LIMIT 1`,
    [targetDifficulty, lastQuestionId ?? null],
  );


if (fallback.rows.length > 0) {
  return hydrate(fallback.rows[0]);
}

  return null;
}

function hydrate(row: any): QuestionRecord {
  return {
    id: row.id,
    difficulty: Number(row.difficulty),
    prompt: row.prompt,
    choices: row.choices as Choice[],
    correct_answer_hash: row.correct_answer_hash,
  };
}
