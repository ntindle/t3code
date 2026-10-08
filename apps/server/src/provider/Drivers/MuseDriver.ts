import { MuseSettings, ProviderDriverKind } from "@t3tools/contracts";
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

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeMuseTextGeneration } from "../../textGeneration/MuseTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeMuseAdapterV2 } from "../../orchestration-v2/Adapters/MuseAdapterV2.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderContinuationRequests from "../../orchestration-v2/ProviderContinuationRequests.ts";
import { checkMuseProviderStatus, makePendingMuseProvider } from "../MuseProvider.ts";
import * as ProviderEventLoggers from "../ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { enrichMuseSnapshot, latestMuseVersion, museMaintenance } from "../museMaintenance.ts";
import type { MuseSubscriptionUsage } from "../museProtocol.ts";
import { makeMuseEnvironment } from "../museSdk.ts";
import {
  museStatusUsageLimits,
  museUsageAccount,
  museUsageStillApplies,
  museUsageWindows,
} from "../museUsageLimits.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("muse");
const decodeMuseSettings = Schema.decodeSync(MuseSettings);

export type MuseDriverEnv =
  | IdAllocator.IdAllocatorV2
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

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
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const { cwd } = serverConfig;
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
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      // Meta reports subscription usage only with a model response, and a status
      // check makes none. Keep the newest report from any of this instance's
      // sessions so a refresh re-derives the windows instead of dropping them,
      // with the account it arrived under so a logout or another login drops it.
      const latestUsage = yield* Ref.make<
        { readonly usage: MuseSubscriptionUsage; readonly account: string | undefined } | undefined
      >(undefined);
      // Sessions report concurrently; one at a time keeps an older report from publishing last.
      const usagePermit = yield* Semaphore.make(1);
      const withUsageLimits = (provider: ServerProviderDraft) =>
        Effect.gen(function* () {
          const retained = yield* Ref.updateAndGet(latestUsage, (current) =>
            current && museUsageStillApplies(current.account, provider.auth) ? current : undefined,
          );
          const usageLimits = museStatusUsageLimits({
            auth: provider.auth,
            enabled: provider.enabled,
            observation: retained?.usage,
            nowMs: DateTime.toEpochMillis(yield* DateTime.now),
          });
          return usageLimits ? { ...provider, usageLimits } : provider;
        });
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
        serverConfig,
        fileSystem,
        modelCatalog,
        latestSubscriptionUsage: Ref.get(latestUsage).pipe(
          Effect.map((retained) => retained?.usage),
        ),
        onSubscriptionUsage: (usage) =>
          usagePermit.withPermits(1)(
            Effect.gen(function* () {
              const { auth } = yield* snapshot.getSnapshot;
              // Every session's host reports; an older report arriving late must not win.
              const newer = yield* Ref.modify(latestUsage, (previous) =>
                previous && previous.usage.observedAtMs >= usage.observedAtMs
                  ? [false, previous]
                  : [true, { usage, account: museUsageAccount(auth) }],
              );
              // An API-key instance leaves the account to its hub; see museStatusUsageLimits.
              if (!newer || auth.type === "apiKey") return;
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
