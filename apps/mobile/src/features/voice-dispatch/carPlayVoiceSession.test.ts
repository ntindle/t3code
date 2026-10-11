import { describe, expect, it, vi } from "vite-plus/test";

import type { NativeListenOutcome } from "../../native/voiceDispatch";
import { CarPlayVoiceSession } from "./carPlayVoiceSession";
import { spokenProjectNames } from "./spokenProjectMatch";
import { VOICE_BUTTON, type VoiceDispatchProject } from "./voiceDispatchConversation";

function project(title: string): VoiceDispatchProject {
  return { key: `env/${title}`, title, subtitle: null, spokenNames: spokenProjectNames({ title }) };
}

const demo = project("Demo");

/** A CarPlay screen whose speech and listening finish when the test says so. */
function fakeCar() {
  const spoken: string[] = [];
  const pendingListens: Array<(outcome: NativeListenOutcome) => void> = [];
  let finishSpeaking: (() => void) | null = null;
  const native = {
    showPrompt: vi.fn(async () => {}),
    speak: vi.fn(async (text: string) => {
      spoken.push(text);
      await new Promise<void>((resolve) => {
        finishSpeaking = resolve;
      });
    }),
    stopSpeaking: vi.fn(async () => finishSpeaking?.()),
    listen: vi.fn(
      () => new Promise<NativeListenOutcome>((resolve) => pendingListens.push(resolve)),
    ),
    stopListening: vi.fn(async () => {}),
    chooseProject: vi.fn(async () => null),
    endConversation: vi.fn(async () => {}),
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    native,
    spoken,
    /** Lets the current prompt finish, then waits for the session to react. */
    async finishSpeech() {
      finishSpeaking?.();
      await flush();
    },
    async answer(outcome: NativeListenOutcome) {
      pendingListens.shift()?.(outcome);
      await flush();
    },
    flush,
  };
}

describe("CarPlayVoiceSession", () => {
  it("routes a tap during listening to the native listener", async () => {
    const car = fakeCar();
    const session = new CarPlayVoiceSession({
      native: car.native,
      projects: async () => [demo],
      startThread: async () => "started",
    });

    void session.start();
    await car.flush();
    await car.finishSpeech();
    session.handleButton(VOICE_BUTTON.done.id);

    expect(car.native.stopListening).toHaveBeenCalledWith(VOICE_BUTTON.done.id, true);
    session.handleButton(VOICE_BUTTON.cancel.id);
    expect(car.native.stopListening).toHaveBeenLastCalledWith(VOICE_BUTTON.cancel.id, false);
  });

  it("answers the next question with a tap made while it was being read", async () => {
    const car = fakeCar();
    const session = new CarPlayVoiceSession({
      native: car.native,
      projects: async () => [demo],
      startThread: async () => "started",
    });

    const run = session.start();
    await car.flush();
    session.handleButton(VOICE_BUTTON.cancel.id);
    await car.flush();
    await car.finishSpeech();
    await run;

    expect(car.native.stopSpeaking).toHaveBeenCalled();
    expect(car.native.listen).not.toHaveBeenCalled();
    expect(car.spoken.at(-1)).toBe("Okay, cancelled.");
    expect(car.native.endConversation).toHaveBeenCalledTimes(1);
  });

  it("retries a failed start from the idle screen without asking again", async () => {
    const car = fakeCar();
    const startThread = vi
      .fn<(target: VoiceDispatchProject, request: string) => Promise<"started" | "queued">>()
      .mockRejectedValueOnce(new Error("Demo is offline."))
      .mockResolvedValueOnce("started");
    const session = new CarPlayVoiceSession({
      native: car.native,
      projects: async () => [demo],
      startThread,
    });

    const first = session.start();
    await car.flush();
    await car.finishSpeech();
    await car.answer({ type: "speech", transcript: "Fix the build" });
    await car.finishSpeech();
    await car.answer({ type: "speech", transcript: "yes" });
    await car.finishSpeech();
    await first;
    expect(car.spoken.at(-1)).toBe("I couldn't start the thread. Demo is offline.");

    session.handleButton(VOICE_BUTTON.retry.id);
    await car.flush();
    await car.finishSpeech();
    await car.flush();

    expect(startThread).toHaveBeenLastCalledWith(demo, "Fix the build");
    expect(car.spoken.at(-1)).toBe("Started in Demo.");
    expect(car.native.listen).toHaveBeenCalledTimes(2);
  });

  it("starts again when CarPlay reconnects while the last conversation unwinds", async () => {
    const car = fakeCar();
    const session = new CarPlayVoiceSession({
      native: car.native,
      projects: async () => [demo, project("Other")],
      startThread: async () => "started",
    });

    void session.start();
    await car.flush();
    session.stop();
    const reconnect = session.start();
    await car.flush();
    await car.finishSpeech();
    await car.answer({ type: "button", buttonId: VOICE_BUTTON.cancel.id });
    await car.finishSpeech();
    await reconnect;

    expect(car.native.stopSpeaking).toHaveBeenCalled();
    expect(car.native.stopListening).toHaveBeenCalledWith(VOICE_BUTTON.cancel.id, false);
    expect(car.spoken).toEqual(["Which project?", "Which project?", "Okay, cancelled."]);
  });

  it("speaks why voice failed instead of leaving the screen stuck", async () => {
    const car = fakeCar();
    car.native.listen.mockRejectedValueOnce(new Error("T3 Code needs microphone access."));
    const session = new CarPlayVoiceSession({
      native: car.native,
      projects: async () => [demo],
      startThread: async () => "started",
    });

    const run = session.start();
    await car.flush();
    await car.finishSpeech();
    await car.finishSpeech();
    await run;

    expect(car.spoken.at(-1)).toBe("T3 Code needs microphone access.");
    expect(car.native.showPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Voice isn't available" }),
    );
    expect(session.isRunning).toBe(false);
  });
});
