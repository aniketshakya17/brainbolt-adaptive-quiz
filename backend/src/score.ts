const MAX_MULTIPLIER = 2;
const WRONG_PENALTY = -5;

export function calculateScore(
  difficulty: number,
  streak: number,
  correct: boolean,
): number {
  const baseScore = difficulty * 10;
  const multiplier = Math.min(1 + streak * 0.1, MAX_MULTIPLIER);

  if (!correct) return WRONG_PENALTY;
  return baseScore * multiplier;
}
