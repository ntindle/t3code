import { describe, expect, it } from "vite-plus/test";

import {
  matchSpokenProject,
  parseSpokenConfirmation,
  spokenProjectNames,
} from "./spokenProjectMatch";

function project(title: string, workspaceRoot?: string) {
  return { title, spokenNames: spokenProjectNames({ title, workspaceRoot }) };
}

describe("spokenProjectNames", () => {
  it("splits compound names the way a recognizer hears them", () => {
    expect(spokenProjectNames({ title: "AutoGPT" })).toEqual(["auto gpt"]);
    expect(spokenProjectNames({ title: "t3code" })).toEqual(["t 3 code"]);
    expect(spokenProjectNames({ title: "my-site_v2" })).toEqual(["my site v 2"]);
  });

  it("adds the workspace folder when it differs from the title", () => {
    expect(
      spokenProjectNames({ title: "T3 Code", workspaceRoot: "/Users/me/code/t3code/" }),
    ).toEqual(["t 3 code"]);
    expect(spokenProjectNames({ title: "Marketing", workspaceRoot: "/srv/site-www" })).toEqual([
      "marketing",
      "site www",
    ]);
  });
});

describe("matchSpokenProject", () => {
  const t3code = project("t3code", "/Users/me/code/t3code");
  const autogpt = project("AutoGPT");
  const carplay = project("t3code-carplay");
  const projects = [t3code, autogpt, carplay];

  it("matches names spoken with number words, spacing, and filler", () => {
    expect(matchSpokenProject("T three code", projects)).toEqual({
      type: "match",
      candidate: t3code,
    });
    expect(matchSpokenProject("the T3 Code project please", projects)).toEqual({
      type: "match",
      candidate: t3code,
    });
    expect(matchSpokenProject("Auto GPT", projects)).toEqual({ type: "match", candidate: autogpt });
  });

  it("prefers an exact name over a longer name that contains it", () => {
    expect(matchSpokenProject("t3code", projects)).toEqual({ type: "match", candidate: t3code });
  });

  it("accepts one distinctive word of a longer name", () => {
    expect(matchSpokenProject("CarPlay", projects)).toEqual({ type: "match", candidate: carplay });
  });

  it("tolerates a misheard spelling", () => {
    expect(matchSpokenProject("tea three code", [t3code, autogpt])).toEqual({
      type: "match",
      candidate: t3code,
    });
  });

  it("asks for a choice when two projects answer equally well", () => {
    const work = project("T3 Code", "/Users/me/work/t3code");
    expect(matchSpokenProject("t3 code", [t3code, work])).toEqual({
      type: "ambiguous",
      candidates: [t3code, work],
    });
  });

  it("reports no match for unrelated speech", () => {
    expect(matchSpokenProject("the grocery list", projects)).toEqual({ type: "none" });
    expect(matchSpokenProject("um the", projects)).toEqual({ type: "none" });
  });

  it("matches a project named like a filler word", () => {
    const go = project("Go");
    expect(matchSpokenProject("Go", [go, autogpt])).toEqual({ type: "match", candidate: go });
  });
});

describe("parseSpokenConfirmation", () => {
  it("reads common answers", () => {
    expect(parseSpokenConfirmation("Yes")).toBe("yes");
    expect(parseSpokenConfirmation("yeah go ahead")).toBe("yes");
    expect(parseSpokenConfirmation("start it")).toBe("yes");
    expect(parseSpokenConfirmation("no")).toBe("no");
    expect(parseSpokenConfirmation("cancel that")).toBe("no");
    expect(parseSpokenConfirmation("hmm")).toBe("unclear");
  });

  it("lets a negative win when both appear", () => {
    expect(parseSpokenConfirmation("don't start it")).toBe("no");
    expect(parseSpokenConfirmation("do not start it")).toBe("no");
    expect(parseSpokenConfirmation("no, wait, yes")).toBe("no");
  });
});
