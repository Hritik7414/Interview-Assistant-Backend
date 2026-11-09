/** Maximum characters accepted for each context field. */
export const CONTEXT_LIMITS = {
  resume: 20_000,
  jobDescription: 12_000,
  instructions: 2_000,
} as const;

/** Target shape of a generated answer. */
export const ANSWER_GUIDELINES = {
  minWords: 60,
  maxWords: 90,
  minBullets: 3,
  maxBullets: 6,
} as const;

/** Latency budgets (ms) used to colour diagnostics. `good` ≤ first value, `fair` ≤ second. */
export const LATENCY_BUDGETS_MS = {
  audioIngestion: [80, 250],
  transcription: [400, 900],
  questionDetection: [1_500, 2_500],
  llmFirstToken: [900, 1_800],
  answerTotal: [4_000, 7_000],
  endToEnd: [2_500, 4_000],
} as const;
