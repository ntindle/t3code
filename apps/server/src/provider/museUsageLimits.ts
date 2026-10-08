/**
 * Muse Code subscription usage. Meta reports the account's windows with every
 * model response; Muse forwards them as `usage/changed`, and CLIProxyAPI
 * records the same report as `X-Meta-*` quota signals. Both map onto the same
 * window ids, so a hub row and a native row land in the same pool.
 *
 * Meta has no usage endpoint, so the last report is all there is between
 * responses. Windows are re-derived from it against the clock: a window whose
 * reset has passed starts over empty.
 *
 * @module provider/museUsageLimits
 */
import type {
  ServerProviderAuth,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "./providerUsageLimits.ts";

const WEEK_MINS = 7 * 24 * 60;

/** One report of the account's windows, from Muse or from the hub. */
export interface MuseUsageObservation {
  readonly observedAtMs: number;
  /** Meta's five-hour-class block. */
  readonly window?: {
    readonly usedPercent: number;
    readonly windowDurationMins: number;
    readonly resetsAtMs: number;
  };
  readonly weekly?: { readonly usedPercent: number; readonly resetsAtMs: number };
}

const isoFromMillis = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function makeWindow(
  id: "window" | "weekly",
  windowDurationMins: number,
  usedPercent: number,
  resetsAtMs: number,
  nowMs: number,
): ServerProviderUsageWindow {
  const kind = windowDurationMins >= WEEK_MINS ? "weekly" : "session";
  // Meta opens the next window with the account's next request, so a window
  // that has reset since the report is empty and its new reset is unknown.
  const current = resetsAtMs > nowMs;
  return {
    id,
    kind,
    label: kind === "weekly" ? "Weekly" : "Session",
    windowDurationMins: Math.round(windowDurationMins),
    usedPercent: current ? clampPercent(usedPercent) : 0,
    ...(current ? { resetsAt: isoFromMillis(resetsAtMs) } : {}),
  };
}

export function museUsageWindows(
  observation: MuseUsageObservation,
  nowMs: number,
): ReadonlyArray<ServerProviderUsageWindow> {
  const { window, weekly } = observation;
  return [
    ...(window
      ? [
          makeWindow(
            "window",
            window.windowDurationMins,
            window.usedPercent,
            window.resetsAtMs,
            nowMs,
          ),
        ]
      : []),
    ...(weekly
      ? [makeWindow("weekly", WEEK_MINS, weekly.usedPercent, weekly.resetsAtMs, nowMs)]
      : []),
  ];
}

/** Limits as of `nowMs`, dated when Meta reported them so the freshest report wins across environments. */
export function museUsageLimits(
  observation: MuseUsageObservation,
  nowMs: number,
): ServerProviderUsageLimits {
  return makeUsageLimits({
    checkedAt: isoFromMillis(observation.observedAtMs),
    windows: museUsageWindows(observation, nowMs),
  });
}

/** The account a report belongs to: the login's address or label, when a status check named one. */
export function museUsageAccount(auth: ServerProviderAuth): string | undefined {
  return auth.type === "accountLogin" ? (auth.email ?? auth.label) : undefined;
}

/**
 * Whether a report that arrived under `account` still belongs to the login a
 * status check found. A logout or another account's login drops it, so a
 * report never shows under an account it did not come from.
 */
export function museUsageStillApplies(
  account: string | undefined,
  auth: ServerProviderAuth,
): boolean {
  if (auth.status === "unauthenticated") return false;
  const current = museUsageAccount(auth);
  return account === undefined || current === undefined || account === current;
}

/**
 * What a status check publishes for an instance. An API key is a gateway such
 * as CLIProxyAPI, or API billing, and neither names the Meta account, so a hub
 * reports that subscription instead, as for Claude through a proxy. Otherwise
 * the newest report stands, or a login says when to expect one.
 */
export function museStatusUsageLimits(input: {
  readonly auth: ServerProviderAuth;
  readonly enabled: boolean;
  readonly observation: MuseUsageObservation | undefined;
  readonly nowMs: number;
}): ServerProviderUsageLimits | undefined {
  const checkedAt = isoFromMillis(input.nowMs);
  if (input.auth.type === "apiKey") {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "Muse uses an API key here. A CLIProxyAPI hub reports its own accounts.",
    });
  }
  // Signed out, there is no account to report on.
  if (input.auth.status === "unauthenticated") return undefined;
  if (input.observation) return museUsageLimits(input.observation, input.nowMs);
  if (!input.enabled || input.auth.type !== "accountLogin") return undefined;
  return makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Muse reports usage limits with its next reply.",
  });
}

/**
 * Muse surfaces Meta's quota refusal as `API error 429: Subscription quota
 * exhausted… (rate_limit_error)` and drops the reset time Meta sent with it.
 */
export function isMuseUsageLimitFailure(message: string | undefined): boolean {
  return message !== undefined && /\b429\b/.test(message) && /quota|usage limit/i.test(message);
}

/**
 * When a stopped turn can run again: every exhausted window must reset first.
 * The last report before the refusal is the one that crossed the limit.
 */
export function museUsageLimitResetAt(
  observation: MuseUsageObservation | undefined,
  nowMs: number,
): string | null {
  const resets = [observation?.window, observation?.weekly].flatMap((window) =>
    window && window.usedPercent >= 100 && window.resetsAtMs > nowMs ? [window.resetsAtMs] : [],
  );
  return resets.length > 0 ? isoFromMillis(Math.max(...resets)) : null;
}

/**
 * The hub's record of the same report: `X-Meta-*` quota signals on the
 * account, with reset times in unix seconds.
 */
export function museUsageObservationFromHubSignals(
  signals: Readonly<Record<string, string>>,
  observedAtMs: number,
): MuseUsageObservation | undefined {
  const values = new Map(
    Object.entries(signals).map(([name, value]) => [name.toLowerCase(), value.trim()]),
  );
  const number = (name: string) => {
    const raw = values.get(name);
    const value = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(value) ? value : undefined;
  };
  const windowUsed = number("x-meta-window-used-percent");
  const windowMins = number("x-meta-window-minutes");
  const windowReset = number("x-meta-window-reset-at");
  const weeklyUsed = number("x-meta-weekly-used-percent");
  const weeklyReset = number("x-meta-weekly-reset-at");
  const window =
    windowUsed !== undefined &&
    windowUsed >= 0 &&
    windowMins !== undefined &&
    windowMins > 0 &&
    windowReset !== undefined &&
    windowReset > 0
      ? { usedPercent: windowUsed, windowDurationMins: windowMins, resetsAtMs: windowReset * 1000 }
      : undefined;
  const weekly =
    weeklyUsed !== undefined && weeklyUsed >= 0 && weeklyReset !== undefined && weeklyReset > 0
      ? { usedPercent: weeklyUsed, resetsAtMs: weeklyReset * 1000 }
      : undefined;
  if (!window && !weekly) return undefined;
  return { observedAtMs, ...(window ? { window } : {}), ...(weekly ? { weekly } : {}) };
}
