import { describe, expect, it } from "vitest";
import { buildForms, componentWords, textMatches, transcriptMatches } from "./matcher.ts";

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

describe("component words", () => {
  it("lists the meaningful words of a phrase", () => {
    expect(componentWords("camping tent")).toEqual(["camping", "tent"]);
    expect(componentWords("Stairway to Heaven")).toEqual(["stairway", "heaven"]);
    expect(componentWords("tent")).toEqual([]);
  });

  it("makes components off limits for the describer, including inflections", () => {
    const describer = buildForms("camping tent", [], { components: true });
    expect(textMatches("you sleep in a tent", describer)).toBe(true);
    expect(textMatches("lots of tents", describer)).toBe(true);
    expect(textMatches("we camped outside", describer)).toBe(true);
    expect(textMatches("you sleep outside in it", describer)).toBe(false);
  });

  it("keeps filler words allowed", () => {
    const describer = buildForms("Stairway to Heaven", [], { components: true });
    expect(textMatches("go to the store", describer)).toBe(false);
    expect(textMatches("steps up to the sky, heavenly", describer)).toBe(false);
    expect(textMatches("heaven", describer)).toBe(true);
  });

  it("still needs the full phrase for guessers", () => {
    const guess = buildForms("camping tent", []);
    expect(textMatches("tent", guess)).toBe(false);
    expect(textMatches("a camping tent", guess)).toBe(true);
  });
});
