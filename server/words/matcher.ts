// Decides whether a transcript contains the target word or one of its close forms.
import lemmatizer from "wink-lemmatizer";

export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  const norm = normalizeText(text);
  return norm ? norm.split(" ") : [];
}

function lemmas(token: string): Set<string> {
  return new Set([
    token,
    lemmatizer.noun(token),
    lemmatizer.verb(token),
    lemmatizer.adjective(token),
  ]);
}

export interface WordForms {
  /** Each form as a token sequence, e.g. ["perfect", "fifth"]. */
  forms: string[][];
  /** Lemmas of every single-token form, for matching inflections. */
  lemmas: Set<string>;
}

/** Filler words that stay allowed even when they're part of a phrase ("Stairway to Heaven"). */
const STOPWORDS = new Set(
  "a an the of to in on at by for from with and or but nor is are be as it its this that my your our their me i you we he she they o de la le el los las du des der die das".split(
    " ",
  ),
);

/** The meaningful words of a multi-word phrase: "camping tent" → ["camping", "tent"]. */
export function componentWords(word: string): string[] {
  const tokens = tokenize(word);
  if (tokens.length < 2) return [];
  return [...new Set(tokens.filter((t) => t.length > 1 && !STOPWORDS.has(t)))];
}

/**
 * Builds the forms that count as saying a word. Pass `components` for the
 * describer, who also may not say any meaningful word of a phrase.
 */
export function buildForms(word: string, variants: string[], opts: { components?: boolean } = {}): WordForms {
  const seen = new Set<string>();
  const forms: string[][] = [];
  const lemmaSet = new Set<string>();
  for (const raw of [word, ...variants, ...(opts.components ? componentWords(word) : [])]) {
    const tokens = tokenize(raw);
    const key = tokens.join(" ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    forms.push(tokens);
    if (tokens.length === 1) for (const l of lemmas(tokens[0]!)) lemmaSet.add(l);
  }
  return { forms, lemmas: lemmaSet };
}

export interface MatchResult {
  /** Indexes of the transcript tokens that matched. */
  start: number;
  end: number;
}

/**
 * Finds the first occurrence of any form in the transcript tokens. Matches
 * exact token sequences, the same sequence with spaces removed ("fire fly" vs
 * "firefly"), and single tokens sharing a lemma with a single-token form.
 */
export function findMatch(tokens: string[], wf: WordForms): MatchResult | null {
  for (let i = 0; i < tokens.length; i++) {
    for (const form of wf.forms) {
      if (form.every((f, j) => tokens[i + j] === f)) return { start: i, end: i + form.length };
    }
    for (let n = 1; n <= 3 && i + n <= tokens.length; n++) {
      const joined = tokens.slice(i, i + n).join("");
      if (wf.forms.some((f) => f.join("") === joined)) return { start: i, end: i + n };
    }
    for (const l of lemmas(tokens[i]!)) {
      if (wf.lemmas.has(l)) return { start: i, end: i + 1 };
    }
  }
  return null;
}

export function textMatches(text: string, wf: WordForms): boolean {
  return findMatch(tokenize(text), wf) !== null;
}

/**
 * Matches speech-to-text output, ignoring words the recognizer wasn't
 * confident about so a mumbled near-miss doesn't score.
 */
export function transcriptMatches(
  t: { text: string; words: { word: string; confidence: number }[] },
  wf: WordForms,
  minConfidence: number,
): boolean {
  if (t.words.length === 0) return textMatches(t.text, wf);
  // A placeholder token keeps low-confidence words from joining a phrase match.
  const tokens = t.words.flatMap((w) => (w.confidence >= minConfidence ? tokenize(w.word) : ["\u0000"]));
  return findMatch(tokens, wf) !== null;
}
