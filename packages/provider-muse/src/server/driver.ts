import { ProviderDriverKind } from "@t3tools/contracts";
import { MuseSettings } from "../settings.ts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { makeMuseTextGeneration } from "./textGeneration.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeMuseAdapterV2 } from "./adapter.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import { checkMuseProviderStatus, makePendingMuseProvider } from "./status.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { enrichMuseSnapshot, latestMuseVersion, museMaintenance } from "./maintenance.ts";
import type { MuseSubscriptionUsage } from "./protocol.ts";
import { makeMuseEnvironment } from "./sdk.ts";
import {
  museStatusUsageLimits,
  museUsageWindows,
  nextMuseUsageAccount,
  type MuseUsageAccount,
} from "./usageLimits.ts";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";

const DRIVER_KIND = ProviderDriverKind.make("muse");
const decodeMuseSettings = Schema.decodeSync(MuseSettings);

export type MuseDriverEnv =
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Muse Code", supportsMultipleInstances: true },
  configSchema: MuseSettings,
  defaultConfig: () => decodeMuseSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const host = yield* ProviderHost.ProviderHost;
      const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const { cwd } = host.paths;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const hostEnvironment = yield* HostProcessEnvironment;
      // Drop an inherited META_API_KEY so Muse uses its login; an instance value still wins.
      const processEnvironment = mergeProviderInstanceEnvironment(
        environment,
        makeMuseEnvironment(hostEnvironment),
      );
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies MuseSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, host.settings);
      // Meta reports subscription usage only with a model response, and a status
      // check makes none. Keep the newest report from any of this instance's
      // sessions so a refresh re-derives the windows instead of dropping them.
      // Each report counts for the account generation its host started under.
      const usageAccount = yield* Ref.make<MuseUsageAccount>({
        generation: 0,
        identity: undefined,
      });
      const latestUsage = yield* Ref.make<
        { readonly usage: MuseSubscriptionUsage; readonly generation: number } | undefined
      >(undefined);
      // Reports and status checks take turns, so an older report cannot publish after a
      // newer one, and none publishes for a generation a check has just replaced.
      const usagePermit = yield* Semaphore.make(1);
      const withUsageLimits = (provider: ServerProviderDraft) =>
        usagePermit.withPermits(1)(
          Effect.gen(function* () {
            const { generation } = yield* Ref.updateAndGet(usageAccount, (account) =>
              nextMuseUsageAccount(account, provider.auth),
            );
            const { retained, dropped } = yield* Ref.modify(latestUsage, (current) => {
              const drop = current !== undefined && current.generation !== generation;
              const kept = drop ? undefined : current;
              return [{ retained: kept, dropped: drop }, kept] as const;
            });
            const usageLimits = museStatusUsageLimits({
              auth: provider.auth,
              enabled: provider.enabled,
              observation: retained?.usage,
              dropped,
              nowMs: DateTime.toEpochMillis(yield* DateTime.now),
            });
            return usageLimits ? { ...provider, usageLimits } : provider;
          }),
        );
      const resolveInstallation = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(museMaintenance, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnvironment,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const resolveMaintenance = (options?: { readonly fresh?: boolean }) =>
        Effect.gen(function* () {
          const capabilities = yield* resolveInstallation(options);
          // The maintenance runner requests fresh capabilities around an explicit update
          // and needs the native target version to verify that the command actually upgraded.
          const latestVersion = options?.fresh
            ? yield* latestMuseVersion(processEnvironment, { fresh: true }).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
              )
            : undefined;
          return latestVersion !== undefined ? { ...capabilities, latestVersion } : capabilities;
        });
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MuseSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingMuseProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkMuseProviderStatus(effectiveConfig, processEnvironment, cwd).pipe(
          Effect.flatMap(withUsageLimits),
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichMuseSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                environment: processEnvironment,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Muse Code snapshot.",
              cause,
            }),
        ),
      );
      const modelCatalog = snapshot.getSnapshot.pipe(Effect.map((current) => current.models));
      const orchestrationAdapter = makeMuseAdapterV2({
        instanceId,
        settings: effectiveConfig,
        environment: processEnvironment,
        idAllocator,
        host,
        fileSystem,
        modelCatalog,
        latestSubscriptionUsage: Ref.get(latestUsage).pipe(
          Effect.map((retained) => retained?.usage),
        ),
        usageAccountGeneration: Ref.get(usageAccount).pipe(
          Effect.map((account) => account.generation),
        ),
        onSubscriptionUsage: (usage, hostGeneration) =>
          usagePermit.withPermits(1)(
            Effect.gen(function* () {
              const account = yield* Ref.get(usageAccount);
              // A host from before a logout or another login reports for an account
              // that is gone, and signed out there is no account to report for.
              if (hostGeneration !== account.generation || account.identity === null) return;
              // Every session's host reports; an older report arriving late must not win.
              const newer = yield* Ref.modify(latestUsage, (previous) =>
                previous && previous.usage.observedAtMs >= usage.observedAtMs
                  ? [false, previous]
                  : [true, { usage, generation: hostGeneration }],
              );
              // An API-key instance leaves the account to its hub; see museStatusUsageLimits.
              if (!newer || (yield* snapshot.getSnapshot).auth.type === "apiKey") return;
              const now = yield* DateTime.now;
              yield* snapshot.applyUsageLimits({
                windows: museUsageWindows(usage, DateTime.toEpochMillis(now)),
                checkedAt: DateTime.formatIso(DateTime.makeUnsafe(usage.observedAtMs)),
                // A report is the account's whole state, so a window that has reset
                // since loses its old reset time instead of keeping it.
                replace: true,
              });
            }),
          ),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        continuationRequests,
      });
      const textGeneration = yield* makeMuseTextGeneration(effectiveConfig, {
        environment: processEnvironment,
        modelCatalog,
      });
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
