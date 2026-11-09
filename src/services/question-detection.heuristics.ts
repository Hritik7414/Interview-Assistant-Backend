/**
 * Pure linguistic heuristics that decide whether an utterance is an interview
 * question. Kept free of state and I/O so every rule is unit-testable.
 */

export const FILLER_WORDS: ReadonlySet<string> = new Set([
  'um',
  'umm',
  'uh',
  'uhh',
  'uhm',
  'erm',
  'er',
  'ah',
  'ahh',
  'eh',
  'hmm',
  'hm',
  'mm',
  'mmm',
  'mhm',
]);

const DISCOURSE_WORDS: ReadonlySet<string> = new Set([
  'so',
  'okay',
  'ok',
  'well',
  'and',
  'but',
  'now',
  'alright',
  'right',
  'also',
  'then',
]);

const ACK_WORDS: ReadonlySet<string> = new Set([
  'great',
  'good',
  'okay',
  'ok',
  'thanks',
  'thank',
  'you',
  'so',
  'much',
  'cool',
  'nice',
  'perfect',
  'awesome',
  'sure',
  'right',
  'got',
  'it',
  'makes',
  'sense',
  'interesting',
  'i',
  'see',
  'alright',
  'all',
  'sounds',
  'wonderful',
  'excellent',
  'yeah',
  'yes',
  'mhm',
  'that',
  "that's",
  'fair',
]);

const LEADING_DISCOURSE =
  /^(?:(?:so|okay|ok|alright|all right|well|right|now|and|but|also|then|great|cool|perfect|thanks|thank you)\b[\s,.!-]*)+/i;

const RULES = {
  questionMark: { weight: 0.55, reason: 'question-mark' },
  interrogative: { weight: 0.35, reason: 'interrogative-start' },
  interrogativeAux: { weight: 0.25, reason: 'interrogative-auxiliary' },
  auxiliaryYou: { weight: 0.45, reason: 'auxiliary-inversion' },
  auxiliaryOther: { weight: 0.35, reason: 'auxiliary-inversion' },
  imperative: { weight: 0.5, reason: 'imperative-prompt' },
  embeddedImperative: { weight: 0.2, reason: 'embedded-prompt' },
  curiosity: { weight: 0.5, reason: 'curiosity-phrase' },
} as const;

const WH_START = /^(what|why|how|when|where|which|who|whom|whose)\b/;
const WH_DECLARATIVE = /^(what|why|how|when|where|who)\s+(i|we|he|she|they)\b/;
const WH_AUX =
  /^(what|why|how|when|where|which|who|whose)(?:\s+[\w'-]+){0,3}?\s+(would|do|does|did|is|are|was|were|can|could|should|will|have|has|had|might|may)\b/;
const AUX_YOU = /^(can|could|would|will|do|did|have|are|were|should)\s+(you|we)\b/;
const AUX_OTHER =
  /^(is|are|was|were|does|do|did|has|have|can|could|would|should|will)\s+(there|it|this|that|the|your|they|he|she|i)\b/;
const IMPERATIVE =
  /^(tell (me|us)|walk (me|us) through|talk (me|us) through|take (me|us) through|run (me|us) through|describe|explain|give (me|us)|share|talk about|elaborate|help (me|us) understand|think (of|about) a time|imagine|outline|summari[sz]e|compare)\b/;
const EMBEDDED_IMPERATIVE =
  /\b(walk (me|us) through|talk (me|us) through|tell (me|us) about|give (me|us) an example|describe|explain)\b/;
const CURIOSITY =
  /\b(i'?d like to (know|hear|understand)|i would like to (know|hear|understand)|i'?m curious|i am curious|i want to (know|hear|understand)|i'?d love to hear|i was wondering|wondering (if|whether|how|what|why)|curious (about|how|what|why))\b/;
const SMALL_TALK =
  /\b(can you hear me|can you see my screen|is my audio|you'?re on mute|are you there|how are you( doing)?( today)?)\b/;

export interface HeuristicsConfig {
  minWords: number;
  confidenceThreshold: number;
  minChars?: number;
  maxQuestionChars?: number;
}

export type RejectionReason = 'too_short' | 'acknowledgement' | 'small_talk' | 'low_confidence';

export interface UtteranceAnalysis {
  isQuestion: boolean;
  confidence: number;
  reasons: string[];
  /** Cleaned question text (fillers removed, leading acknowledgements dropped). */
  questionText: string;
  meaningfulWords: number;
  rejection: RejectionReason | null;
}

interface SentenceScore {
  sentence: string;
  score: number;
  reasons: string[];
}

/** Removes filler words while preserving terminal punctuation attached to them. */
export function stripFillers(text: string): string {
  const kept: string[] = [];
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const bare = token.toLowerCase().replace(/[^\p{L}']/gu, '');
    if (FILLER_WORDS.has(bare)) {
      const previous = kept.at(-1);
      const terminal = token.match(/[.?!]+$/)?.[0];
      if (previous !== undefined && terminal) {
        kept[kept.length - 1] = `${previous.replace(/[,;:]+$/, '')}${terminal}`;
      } else if (previous !== undefined && /,$/.test(token)) {
        // "that, uh, needs" → "that needs": drop the comma that only framed the filler.
        kept[kept.length - 1] = previous.replace(/,$/, '');
      }
      continue;
    }
    kept.push(token);
  }
  return kept
    .join(' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([.?!])/g, '$1')
    .replace(/^[,;:\s]+/, '')
    .trim();
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function isAcknowledgement(sentence: string): boolean {
  const tokens = words(sentence);
  return tokens.length > 0 && tokens.length <= 5 && tokens.every((token) => ACK_WORDS.has(token));
}

function stripLeadingDiscourse(text: string): string {
  return text.replace(LEADING_DISCOURSE, '').trim();
}

/** Scores a single sentence; clause starts are checked so "To start, could you…" still counts. */
function scoreSentence(sentence: string): SentenceScore {
  const lower = sentence.toLowerCase().trim();
  const clauses = [lower, ...lower.split(/[,;:—–]\s*/)].map(stripLeadingDiscourse).filter(Boolean);
  const fired = new Map<string, number>();
  const fire = (rule: (typeof RULES)[keyof typeof RULES]) => {
    fired.set(rule.reason, Math.max(fired.get(rule.reason) ?? 0, rule.weight));
  };

  let bestStart = 0;
  let bestStartReasons: Array<(typeof RULES)[keyof typeof RULES]> = [];
  for (const clause of clauses) {
    const rules: Array<(typeof RULES)[keyof typeof RULES]> = [];
    if (WH_START.test(clause) && !WH_DECLARATIVE.test(clause)) {
      rules.push(RULES.interrogative);
      if (WH_AUX.test(clause)) rules.push(RULES.interrogativeAux);
    }
    if (AUX_YOU.test(clause)) rules.push(RULES.auxiliaryYou);
    else if (AUX_OTHER.test(clause)) rules.push(RULES.auxiliaryOther);
    if (IMPERATIVE.test(clause)) rules.push(RULES.imperative);
    const total = rules.reduce((sum, rule) => sum + rule.weight, 0);
    if (total > bestStart) {
      bestStart = total;
      bestStartReasons = rules;
    }
  }
  bestStartReasons.forEach(fire);

  if (/\?\s*$/.test(lower)) fire(RULES.questionMark);
  if (EMBEDDED_IMPERATIVE.test(lower)) fire(RULES.embeddedImperative);
  if (CURIOSITY.test(lower)) fire(RULES.curiosity);

  const score = Math.min(
    1,
    [...fired.values()].reduce((sum, weight) => sum + weight, 0),
  );
  return { sentence, score, reasons: [...fired.keys()] };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Decides whether a complete utterance is a question worth answering. */
export function analyzeUtterance(text: string, config: HeuristicsConfig): UtteranceAnalysis {
  const cleaned = stripFillers(text);
  const sentences = splitSentences(cleaned);
  const minChars = config.minChars ?? 10;
  const maxChars = config.maxQuestionChars ?? 600;
  const reject = (
    rejection: RejectionReason,
    confidence = 0,
    meaningfulWords = 0,
  ): UtteranceAnalysis => ({
    isQuestion: false,
    confidence,
    reasons: [],
    questionText: cleaned,
    meaningfulWords,
    rejection,
  });

  if (sentences.length === 0) return reject('too_short');
  if (sentences.every(isAcknowledgement)) return reject('acknowledgement');
  if (SMALL_TALK.test(cleaned.toLowerCase())) return reject('small_talk');

  const scored = sentences.map(scoreSentence);
  const firstQuestionIndex = scored.findIndex((entry) => entry.score >= 0.3);
  const best = scored.reduce((top, entry) => (entry.score > top.score ? entry : top), scored[0]!);

  let startIndex = firstQuestionIndex === -1 ? 0 : firstQuestionIndex;
  const previous = scored[startIndex - 1];
  if (previous && !isAcknowledgement(previous.sentence) && words(previous.sentence).length >= 4) {
    startIndex -= 1; // Keep one sentence of lead-in context ("Let's talk about databases.").
  }
  const selected = sentences.slice(startIndex);
  selected[0] = capitalize(stripLeadingDiscourse(selected[0] ?? '').replace(/^[,\s]+/, ''));
  let questionText = selected.join(' ').trim();
  if (questionText.length > maxChars)
    questionText = `${questionText.slice(0, maxChars - 1).trimEnd()}…`;

  const meaningfulWords = words(questionText).filter(
    (token) => !FILLER_WORDS.has(token) && !DISCOURSE_WORDS.has(token),
  ).length;
  if (meaningfulWords < config.minWords || questionText.length < minChars) {
    return reject('too_short', best.score, meaningfulWords);
  }
  if (best.score < config.confidenceThreshold) {
    return reject('low_confidence', best.score, meaningfulWords);
  }
  return {
    isQuestion: true,
    confidence: Math.round(best.score * 100) / 100,
    reasons: best.reasons,
    questionText,
    meaningfulWords,
    rejection: null,
  };
}

export function endsWithQuestionMark(text: string): boolean {
  return /\?\s*$/.test(text.trim());
}
