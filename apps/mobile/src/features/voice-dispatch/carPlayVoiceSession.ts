import type { VoiceDispatchNativeModule } from "../../native/voiceDispatch";
import {
  runVoiceDispatch,
  VOICE_BUTTON,
  type VoiceDispatchIO,
  type VoiceDispatchProject,
} from "./voiceDispatchConversation";

type CarPlayNative = Pick<
  VoiceDispatchNativeModule,
  | "showPrompt"
  | "speak"
  | "stopSpeaking"
  | "listen"
  | "stopListening"
  | "chooseProject"
  | "endConversation"
>;

export interface CarPlayVoiceSessionDependencies<Project extends VoiceDispatchProject> {
  readonly native: CarPlayNative;
  /** Resolves once projects have loaded, or with none after a short wait. */
  readonly projects: () => Promise<ReadonlyArray<Project>>;
  readonly startThread: (project: Project, request: string) => Promise<"started" | "queued">;
}

/**
 * One CarPlay connection. Runs a conversation when the screen connects or the
 * driver taps New Thread, and routes screen buttons: during listening they
 * end it, mid-conversation they answer the next question, and otherwise they
 * start a new conversation or retry a failed start.
 */
export class CarPlayVoiceSession<Project extends VoiceDispatchProject> {
  private abort: AbortController | null = null;
  private listeningFinishIds: ReadonlySet<string> | null = null;
  private pendingButton: string | null = null;
  private failed: { readonly project: Project; readonly request: string } | null = null;
  /** Settles when the current conversation, if any, has fully unwound. */
  private settled: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: CarPlayVoiceSessionDependencies<Project>) {}

  get isRunning(): boolean {
    return this.abort !== null;
  }

  /**
   * The CarPlay screen connected; apps in this category launch into voice. A
   * reconnect can arrive while the previous conversation is still unwinding,
   * so it waits for that one instead of being dropped.
   */
  start(): Promise<void> {
    return this.settled.then(() => this.run());
  }

  /** The CarPlay screen went away mid-conversation. */
  stop(): void {
    if (!this.abort) return;
    this.abort.abort();
    void this.dependencies.native.stopSpeaking();
    void this.dependencies.native.stopListening(VOICE_BUTTON.cancel.id, false);
  }

  handleButton(buttonId: string): void {
    const { native } = this.dependencies;
    if (this.listeningFinishIds !== null) {
      void native.stopListening(buttonId, this.listeningFinishIds.has(buttonId));
      return;
    }
    if (this.isRunning) {
      // Tapped while a question is being read: skip it and answer with the tap.
      this.pendingButton = buttonId;
      void native.stopSpeaking();
      return;
    }
    if (buttonId === VOICE_BUTTON.retry.id && this.failed) {
      void this.run(this.failed);
    } else if (buttonId === VOICE_BUTTON.newThread.id || buttonId === VOICE_BUTTON.retry.id) {
      void this.run();
    }
  }

  private run(retry?: { readonly project: Project; readonly request: string }): Promise<void> {
    if (this.isRunning) return this.settled;
    const abort = new AbortController();
    this.abort = abort;
    this.settled = this.converse(abort, retry);
    return this.settled;
  }

  private async converse(
    abort: AbortController,
    retry?: { readonly project: Project; readonly request: string },
  ): Promise<void> {
    try {
      const projects = await this.dependencies.projects();
      const outcome = await runVoiceDispatch({
        io: this.io(projects),
        projects,
        startThread: (project, request) =>
          this.dependencies.startThread(project as Project, request),
        ...(retry ? { retry } : {}),
        signal: abort.signal,
      });
      this.failed =
        outcome.type === "failed"
          ? { project: outcome.project as Project, request: outcome.request }
          : null;
    } catch (error) {
      // Microphone or speech failures end the conversation with their reason.
      if (!abort.signal.aborted) {
        await this.announceFailure(error);
      }
    } finally {
      this.abort = null;
      this.listeningFinishIds = null;
      this.pendingButton = null;
      void this.dependencies.native.endConversation();
    }
  }

  private async announceFailure(error: unknown) {
    const { native } = this.dependencies;
    const message = error instanceof Error ? error.message : "Something went wrong.";
    void native.showPrompt({
      title: "Voice isn't available",
      listening: false,
      buttons: [VOICE_BUTTON.newThread],
    });
    await native.speak(message).catch(() => {});
  }

  private io(projects: ReadonlyArray<Project>): VoiceDispatchIO {
    const { native } = this.dependencies;
    return {
      showPrompt: (prompt) => {
        void native.showPrompt(prompt);
      },
      speak: (text) => native.speak(text),
      listen: async (request) => {
        const tapped = this.pendingButton;
        if (tapped !== null) {
          this.pendingButton = null;
          return { type: "button", buttonId: tapped };
        }
        this.listeningFinishIds = new Set(request.finishButtonIds);
        try {
          return await native.listen({
            endSilenceMs: request.endSilenceMs,
            startTimeoutMs: request.startTimeoutMs,
            maxDurationMs: request.maxDurationMs,
            hints: request.hints,
          });
        } finally {
          this.listeningFinishIds = null;
        }
      },
      chooseProject: async (candidates) => {
        const key = await native.chooseProject(candidates);
        return projects.find((project) => project.key === key) ?? null;
      },
    };
  }
}
