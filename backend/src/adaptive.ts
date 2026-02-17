const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;
const CONFIDENCE_UP_THRESHOLD = 2;
const CONFIDENCE_DOWN_THRESHOLD = -2;
const MIN_STREAK_FOR_INCREASE = 2;

export function computeNextDifficulty(
  currentDifficulty: number,
  correct: boolean,
  confidence: number,
  streak: number,
): { nextDifficulty: number; nextConfidence: number } {
  let nextConfidence = correct ? confidence + 1 : confidence - 1;
  let nextDifficulty = currentDifficulty;

  // Require momentum (confidence) and minimum streak before moving up
  if (nextConfidence >= CONFIDENCE_UP_THRESHOLD && streak >= MIN_STREAK_FOR_INCREASE) {
    nextDifficulty += 1;
    nextConfidence = 0; // reset to avoid ping-pong
  } else if (nextConfidence <= CONFIDENCE_DOWN_THRESHOLD) {
    nextDifficulty -= 1;
    nextConfidence = 0; // reset after drop
  }

  nextDifficulty = clampDifficulty(nextDifficulty);
  nextConfidence = clampConfidence(nextConfidence);

  return { nextDifficulty, nextConfidence };
}

function clampDifficulty(value: number): number {
  if (Number.isNaN(value)) return MIN_DIFFICULTY;
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.trunc(value)));
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(-CONFIDENCE_UP_THRESHOLD, Math.min(CONFIDENCE_UP_THRESHOLD, value));
}
