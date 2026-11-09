/** Text normalisation rules shared by transcript and question models. */

const PUNCTUATION = /[^\p{L}\p{N}\s']/gu;
const WHITESPACE = /\s+/g;

/** Lower-cases, strips punctuation and collapses whitespace. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(PUNCTUATION, ' ').replace(WHITESPACE, ' ').trim();
}

export function countWords(text: string): number {
  const normalized = normalizeText(text);
  return normalized === '' ? 0 : normalized.split(' ').length;
}

const SIMILARITY_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'and',
  'or',
  'in',
  'on',
  'at',
  'for',
  'with',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
  'that',
  'this',
  'me',
  'my',
  'i',
  'you',
  'your',
  'we',
  'our',
  'us',
  'so',
  'um',
  'uh',
  'just',
  'really',
  'very',
  'okay',
  'ok',
]);

/** Content-word tokens used for fuzzy comparisons. */
export function contentTokens(text: string): Set<string> {
  const tokens = normalizeText(text)
    .split(' ')
    .filter((token) => token !== '' && !SIMILARITY_STOPWORDS.has(token));
  return new Set(tokens);
}

/** Jaccard similarity of content tokens, in [0, 1]. */
export function textSimilarity(a: string, b: string): number {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (left.size === 0 && right.size === 0) return normalizeText(a) === normalizeText(b) ? 1 : 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
