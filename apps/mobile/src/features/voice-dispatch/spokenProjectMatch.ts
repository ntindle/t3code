/**
 * Matches a transcribed utterance ("the t three code one") against project
 * names ("t3code"). Speech recognizers spell numbers as words, split or join
 * compound names unpredictably, and add filler, so both sides are reduced to
 * a spoken form before comparison.
 */

// Homophones such as "to" and "for" stay words: mapping them corrupts more
// answers than it fixes.
const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

const FILLER_WORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "called",
  "folder",
  "go",
  "i",
  "in",
  "into",
  "it",
  "it's",
  "its",
  "let's",
  "lets",
  "my",
  "named",
  "on",
  "open",
  "please",
  "project",
  "repo",
  "repository",
  "the",
  "um",
  "uh",
  "use",
  "with",
  "work",
]);

function splitWords(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      // camelCase and PascalCase boundaries: "AutoGPT" → "Auto GPT".
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      // Letter/digit boundaries: "t3code" → "t 3 code".
      .replace(/([a-zA-Z])(\d)/g, "$1 $2")
      .replace(/(\d)([a-zA-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/&/g, " and ")
      .split(/[^a-z0-9']+/)
      .filter((word) => word.length > 0)
  );
}

/** Words as a recognizer would hear them, with number words as digits. */
function spokenWords(value: string, options: { readonly dropFiller: boolean }): string[] {
  const words = splitWords(value).map((word) => NUMBER_WORDS[word] ?? word);
  return options.dropFiller ? words.filter((word) => !FILLER_WORDS.has(word)) : words;
}

/**
 * Spoken forms of a project, most specific first. Each form is a single
 * space-separated string; comparisons also try the forms with spaces removed.
 */
export function spokenProjectNames(input: {
  readonly title: string;
  readonly workspaceRoot?: string | null;
}): string[] {
  const names = new Set<string>();
  const add = (value: string) => {
    const words = spokenWords(value, { dropFiller: false });
    if (words.length > 0) names.add(words.join(" "));
  };
  add(input.title);
  const folder = input.workspaceRoot?.split(/[\\/]/).findLast((segment) => segment.length > 0);
  if (folder) add(folder);
  return [...names];
}

export interface SpokenProjectCandidate {
  readonly spokenNames: ReadonlyArray<string>;
}

export type SpokenProjectMatch<T extends SpokenProjectCandidate> =
  | { readonly type: "match"; readonly candidate: T }
  | { readonly type: "ambiguous"; readonly candidates: ReadonlyArray<T> }
  | { readonly type: "none" };

/**
 * How strongly an utterance names a project. Higher tiers always win; within
 * the fuzzy tier, closer spellings win.
 */
const MatchTier = { None: 0, Fuzzy: 1, Partial: 2, Contains: 3, Exact: 4 } as const;
type MatchTier = (typeof MatchTier)[keyof typeof MatchTier];

interface MatchScore {
  readonly tier: MatchTier;
  /** Spelling similarity of the compact forms, 0 to 1. */
  readonly similarity: number;
}

const FUZZY_THRESHOLD = 0.7;
const FUZZY_AMBIGUITY_MARGIN = 0.08;

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + substitution,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 0 : 1 - editDistance(left, right) / longest;
}

function scoreName(utteranceWords: ReadonlyArray<string>, name: string): MatchScore {
  const nameWords = name.split(" ");
  const utterance = utteranceWords.join("");
  const compactName = nameWords.join("");
  const spelling = similarity(utterance, compactName);
  if (utterance.length === 0 || compactName.length === 0) {
    return { tier: MatchTier.None, similarity: 0 };
  }
  if (utterance === compactName) return { tier: MatchTier.Exact, similarity: 1 };
  // "start the t3code project" still names it.
  if (compactName.length >= 3 && utterance.includes(compactName)) {
    return { tier: MatchTier.Contains, similarity: spelling };
  }
  // A partial answer ("carplay" for "t3code carplay") names one of its words.
  if (
    utterance.length >= 4 &&
    (nameWords.includes(utterance) || compactName.startsWith(utterance))
  ) {
    return { tier: MatchTier.Partial, similarity: spelling };
  }
  // Misheard spellings: "tea three code" for "t3code".
  if (spelling >= FUZZY_THRESHOLD) return { tier: MatchTier.Fuzzy, similarity: spelling };
  return { tier: MatchTier.None, similarity: spelling };
}

function compareScores(left: MatchScore, right: MatchScore): number {
  return left.tier === right.tier ? left.similarity - right.similarity : left.tier - right.tier;
}

function scoreCandidate(
  utteranceWords: ReadonlyArray<string>,
  candidate: SpokenProjectCandidate,
): MatchScore {
  let best: MatchScore = { tier: MatchTier.None, similarity: 0 };
  for (const name of candidate.spokenNames) {
    const score = scoreName(utteranceWords, name);
    if (compareScores(score, best) > 0) best = score;
  }
  return best;
}

/** Picks the project an answer to "Which project?" names, if it is clear. */
export function matchSpokenProject<T extends SpokenProjectCandidate>(
  utterance: string,
  candidates: ReadonlyArray<T>,
): SpokenProjectMatch<T> {
  // A project can be named like a filler word ("Go"), so keep an answer that
  // is only filler.
  const meaningful = spokenWords(utterance, { dropFiller: true });
  const utteranceWords =
    meaningful.length > 0 ? meaningful : spokenWords(utterance, { dropFiller: false });
  if (utteranceWords.length === 0) return { type: "none" };
  // .sort() on a fresh array, not .toSorted(): Hermes doesn't ship the ES2023 method.
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(utteranceWords, candidate) }))
    .filter((entry) => entry.score.tier !== MatchTier.None)
    .sort((left, right) => compareScores(right.score, left.score));
  const [best, ...rest] = ranked;
  if (best === undefined) return { type: "none" };
  // Two projects named the same way at the same strength need a choice;
  // fuzzy guesses only tie when their spellings are about equally close.
  const tied = rest.filter(
    (entry) =>
      entry.score.tier === best.score.tier &&
      (best.score.tier !== MatchTier.Fuzzy ||
        best.score.similarity - entry.score.similarity < FUZZY_AMBIGUITY_MARGIN),
  );
  if (tied.length === 0) return { type: "match", candidate: best.candidate };
  return { type: "ambiguous", candidates: [best, ...tied].map((entry) => entry.candidate) };
}

const AFFIRMATIVE = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "start",
  "send",
  "go",
  "do",
  "confirm",
  "correct",
  "right",
  "affirmative",
]);
// Recognizers often write "don't" as "do not", so "not" must count as a refusal.
const NEGATIVE = new Set([
  "no",
  "not",
  "negative",
  "nope",
  "nah",
  "cancel",
  "stop",
  "don't",
  "dont",
  "wait",
  "discard",
  "never",
]);

/** Reads a spoken answer to "Should I start it?". Negatives win over positives. */
export function parseSpokenConfirmation(utterance: string): "yes" | "no" | "unclear" {
  const words = splitWords(utterance);
  if (words.some((word) => NEGATIVE.has(word))) return "no";
  if (words.some((word) => AFFIRMATIVE.has(word))) return "yes";
  return "unclear";
}
