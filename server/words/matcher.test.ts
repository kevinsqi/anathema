import { describe, expect, it } from "vitest";
import { buildForms, textMatches, transcriptMatches } from "./matcher.ts";

describe("textMatches", () => {
  const flames = buildForms("flames", ["flame", "flaming"]);

  it("matches the word and listed variants", () => {
    expect(textMatches("is it Flames?", flames)).toBe(true);
    expect(textMatches("flame", flames)).toBe(true);
    expect(textMatches("something flaming hot", flames)).toBe(true);
  });

  it("matches inflections via lemmas", () => {
    const run = buildForms("run", []);
    expect(textMatches("running", run)).toBe(true);
    expect(textMatches("ran", run)).toBe(true);
  });

  it("does not match unrelated words", () => {
    expect(textMatches("fire smoke frame", flames)).toBe(false);
    expect(textMatches("", flames)).toBe(false);
  });

  it("matches multi-word phrases and spacing differences", () => {
    const fifth = buildForms("perfect fifth", []);
    expect(textMatches("a perfect fifth!", fifth)).toBe(true);
    expect(textMatches("perfect", fifth)).toBe(false);

    const firefly = buildForms("firefly", []);
    expect(textMatches("a fire fly", firefly)).toBe(true);
  });

  it("ignores case, punctuation and accents", () => {
    expect(textMatches("CAFÉ.", buildForms("cafe", []))).toBe(true);
    expect(textMatches("dont", buildForms("don't", []))).toBe(true);
  });
});

describe("transcriptMatches", () => {
  const flames = buildForms("flames", []);

  it("ignores low-confidence words", () => {
    const words = [
      { word: "is", confidence: 0.9 },
      { word: "it", confidence: 0.9 },
      { word: "flames", confidence: 0.3 },
    ];
    expect(transcriptMatches({ text: "is it flames", words }, flames, 0.5)).toBe(false);
    expect(transcriptMatches({ text: "is it flames", words }, flames, 0.2)).toBe(true);
  });

  it("falls back to the text when there are no word timings", () => {
    expect(transcriptMatches({ text: "flames", words: [] }, flames, 0.5)).toBe(true);
  });
});
