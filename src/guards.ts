import type { Config } from "./config.js";
import type { MediaRunResult } from "./media.js";

/** What one run did, as the guards of spec § 7.3 read it. */
export interface GuardInput {
  /** Live items in state before this run. */
  liveItems: number;
  newOrChanged: number;
  deletions: number;
  /** Sources the sweep marked vanished in this run; 0 when no sweep ran. */
  vanished: number;
  /** This run's media checks, or null when none ran. */
  media: MediaRunResult | null;
  /** The source read no videos for a window where state holds some (see `build`). */
  sourceEmpty: boolean;
}

export interface GuardBreach {
  guard: string;
  limit: number;
  actual: number;
  message: string;
}

/** One guard's verdict, breached or not: the report shows every guard. */
export interface GuardResult extends GuardBreach {
  passed: boolean;
}

const GUARD_FIELDS = [
  "maxNewOrChanged",
  "maxDeletionsFloor",
  "maxDeletionsFraction",
  "maxVanishedFraction",
  "maxMediaFailureFraction",
] as const;

/**
 * A guard must never fail open: `n > NaN` is false, so a missing limit would pass everything.
 * loadConfig checks this too; the guards do not rely on it.
 */
function checkLimits(cfg: Config): void {
  for (const field of GUARD_FIELDS) {
    const value: unknown = cfg.guards?.[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`guards.${field} must be a number of 0 or more, got ${String(value)}`);
    }
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const percent = (fraction: number) => `${Number((fraction * 100).toFixed(2))}%`;

/**
 * Every guard of spec § 7.3 with its limit and this run's value. Limits on counts are whole
 * numbers: for a whole count, `n > x` exactly when `n > floor(x)`, so flooring changes no verdict.
 */
export function guardResults(cfg: Config, input: GuardInput): GuardResult[] {
  checkLimits(cfg);
  const g = cfg.guards;
  const live = input.liveItems;
  const results: GuardResult[] = [];
  const add = (guard: string, limit: number, actual: number, passed: boolean, message: string) =>
    results.push({ guard, limit, actual, passed, message });

  add(
    "maxNewOrChanged",
    g.maxNewOrChanged,
    input.newOrChanged,
    input.newOrChanged <= g.maxNewOrChanged,
    `This run has ${plural(input.newOrChanged, "new or changed item")}; the limit is ${g.maxNewOrChanged}.`,
  );

  const deletionLimit = Math.max(g.maxDeletionsFloor, Math.floor(g.maxDeletionsFraction * live));
  add(
    "maxDeletions",
    deletionLimit,
    input.deletions,
    input.deletions <= deletionLimit,
    `This run deletes ${plural(input.deletions, "item")} of ${live} live; the limit is ${deletionLimit} ` +
      `(the larger of ${g.maxDeletionsFloor} and ${percent(g.maxDeletionsFraction)} of the live items).`,
  );

  const vanishedLimit = Math.floor(g.maxVanishedFraction * live);
  add(
    "maxVanished",
    vanishedLimit,
    input.vanished,
    input.vanished <= vanishedLimit,
    `The sweep marked ${plural(input.vanished, "video")} vanished; the limit is ${vanishedLimit} ` +
      `(${percent(g.maxVanishedFraction)} of ${live} live items).`,
  );

  const m = input.media;
  const failedFraction = m !== null && m.checked > 0 ? m.failed / m.checked : 0;
  add(
    "mediaOutage",
    g.maxMediaFailureFraction,
    failedFraction,
    !(m?.outage ?? false),
    m === null
      ? "No media checks ran in this run."
      : m.outage
        ? `${m.failed} of ${m.checked} media checks failed, more than ${percent(g.maxMediaFailureFraction)}. ` +
          "This looks like a media outage, so none of the failures were recorded."
        : `${m.failed} of ${m.checked} media checks failed.`,
  );

  add(
    "sourceEmpty",
    0,
    input.sourceEmpty ? 1 : 0,
    !input.sourceEmpty,
    input.sourceEmpty
      ? "The source relay returned no videos, yet state holds active videos from the week before the " +
          "videos cursor. This looks like relay trouble."
      : "No source read came back empty for a window that held videos.",
  );

  return results;
}

/** The breached guards among `results`, in their order. */
export function breachesOf(results: GuardResult[]): GuardBreach[] {
  return results.filter((r) => !r.passed).map(({ guard, limit, actual, message }) => ({ guard, limit, actual, message }));
}

/** The guards this run breaches, in the order of spec § 7.3; empty when every guard passes. */
export function checkGuards(cfg: Config, input: GuardInput): GuardBreach[] {
  return breachesOf(guardResults(cfg, input));
}
