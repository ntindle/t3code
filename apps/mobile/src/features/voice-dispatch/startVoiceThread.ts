import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  T3_PROJECT_FILE_NAME,
  ThreadId,
  WS_METHODS,
  type ModelSelection,
  type ServerConfig,
  type VcsRef,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import { connectionAtomRuntime } from "../../connection/runtime";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  pendingThreadCreationOutcomesAtom,
  type PendingThreadCreationOutcome,
} from "../../state/pending-thread-creation";
import { environmentProjects } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { enqueueThreadOutboxMessage, type QueuedThreadMessage } from "../../state/thread-outbox";
import { stickyComposerModelSelectionAtom } from "../../state/use-composer-drafts";
import type { VoiceDispatchTarget } from "./voiceDispatchProjects";

/** How long a driver waits to hear "started" before hearing "queued". */
const DELIVERY_WAIT_MS = 12_000;

const listRefsOnce = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "voice-dispatch:list-refs",
  tag: WS_METHODS.vcsListRefs,
});
const readFileOnce = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "voice-dispatch:read-project-file",
  tag: WS_METHODS.projectsReadFile,
});

/** Thrown with a sentence the driver can hear. */
export class VoiceThreadStartError extends Error {}

export type VoiceThreadStartOutcome = "started" | "queued";

/**
 * Starts a thread from a voice note with the project's defaults, the same way
 * an untouched new-task draft would: it goes through the thread outbox, so an
 * offline environment receives it when it reconnects.
 */
export async function startVoiceThread(
  target: VoiceDispatchTarget,
  text: string,
): Promise<VoiceThreadStartOutcome> {
  const project = appAtomRegistry.get(environmentProjects.projectAtom(target));
  if (!project) {
    throw new VoiceThreadStartError("That project isn't available right now.");
  }
  if (!readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)) {
    throw new VoiceThreadStartError(`This connection can't start tasks in ${project.title}.`);
  }
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(target.environmentId));
  const [projectFile, refs] = await Promise.all([
    readProjectFile(target, project.workspaceRoot),
    listRefs(target, project.workspaceRoot),
  ]);
  // With the checkout's t3.json (or null), every default resolves to a value.
  const settings = resolveProjectSettings(
    config?.settings ?? DEFAULT_SERVER_SETTINGS,
    project.id,
    project,
    projectFile,
  ).settings;
  const modelSelection = defaultModelSelection(config, settings.defaultModelSelection);
  if (!modelSelection) {
    throw new VoiceThreadStartError(`${project.title} has no model available.`);
  }
  const workspaceMode = settings.defaultThreadEnvMode;
  if (workspaceMode === "worktree" && refs === null) {
    // A worktree needs a base branch, and without the environment there is
    // no list to pick it from; a queued creation without one never sends.
    throw new VoiceThreadStartError(
      `I can't reach ${project.title} to choose a branch for its worktree. Try again when it's back online.`,
    );
  }
  const branch = pickBranch(refs ?? [], workspaceMode);
  if (workspaceMode === "worktree" && branch === null) {
    throw new VoiceThreadStartError(`I couldn't find a branch to start from in ${project.title}.`);
  }

  const metadata = makeTurnCommandMetadata();
  const message: QueuedThreadMessage = {
    environmentId: target.environmentId,
    threadId: ThreadId.make(metadata.threadId),
    messageId: MessageId.make(metadata.messageId),
    commandId: CommandId.make(metadata.commandId),
    text,
    attachments: [],
    modelSelection,
    runtimeMode: settings.defaultRuntimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    creation: {
      projectId: project.id,
      projectTitle: project.title,
      projectCwd: project.workspaceRoot,
      workspaceMode,
      branch,
      worktreePath: null,
      ...(workspaceMode === "worktree" && settings.newWorktreesStartFromOrigin
        ? { startFromOrigin: true }
        : {}),
    },
    createdAt: metadata.createdAt,
  };
  await enqueueThreadOutboxMessage(message);

  const outcome = await waitForCreationOutcome(
    scopedThreadKey(message.environmentId, message.threadId),
  );
  if (outcome?.kind === "failed") {
    throw new VoiceThreadStartError(outcome.reason);
  }
  return outcome?.kind === "delivered" ? "started" : "queued";
}

/** Project default, then the last model picked anywhere, then the provider default. */
function defaultModelSelection(config: ServerConfig | null, projectDefault: ModelSelection | null) {
  const projectDefaultSelection =
    resolveDefaultableModelSelection(config, projectDefault) ??
    resolveDefaultableModelSelection(
      config,
      (config?.settings ?? DEFAULT_SERVER_SETTINGS).defaultModelSelection,
    );
  const stickySelection = resolveDefaultableModelSelection(
    config,
    appAtomRegistry.get(stickyComposerModelSelectionAtom),
  );
  return resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection,
    stickySelection,
    modelOptions: buildModelOptions(config, projectDefaultSelection ?? stickySelection),
  });
}

async function readProjectFile(target: VoiceDispatchTarget, cwd: string) {
  const result = await runAtomCommand(
    appAtomRegistry,
    readFileOnce,
    { environmentId: target.environmentId, input: { cwd, relativePath: T3_PROJECT_FILE_NAME } },
    { reportFailure: false },
  );
  return result._tag === "Success" && !result.value.truncated
    ? parseT3ProjectFile(result.value.contents)
    : null;
}

async function listRefs(target: VoiceDispatchTarget, cwd: string) {
  const result = await runAtomCommand(
    appAtomRegistry,
    listRefsOnce,
    { environmentId: target.environmentId, input: { cwd } },
    { reportFailure: false },
  );
  // Null when the environment can't answer, as opposed to a repository without branches.
  return result._tag === "Success" ? result.value.refs : null;
}

/**
 * A worktree starts from the default branch, else the checked-out one, as
 * the new-task screen picks; a local thread records the checked-out branch.
 */
function pickBranch(
  refs: ReadonlyArray<VcsRef>,
  workspaceMode: "local" | "worktree",
): string | null {
  const current = refs.find((ref) => ref.current && !ref.isRemote)?.name ?? null;
  if (workspaceMode === "local") {
    return current;
  }
  return refs.find((ref) => ref.isDefault)?.name ?? current;
}

function waitForCreationOutcome(threadKey: string): Promise<PendingThreadCreationOutcome | null> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      resolve(null);
    }, DELIVERY_WAIT_MS);
    const check = (outcomes: Readonly<Record<string, PendingThreadCreationOutcome>>) => {
      const outcome = outcomes[threadKey];
      if (!outcome) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(outcome);
    };
    unsubscribe = appAtomRegistry.subscribe(pendingThreadCreationOutcomesAtom, check);
    check(appAtomRegistry.get(pendingThreadCreationOutcomesAtom));
  });
}
