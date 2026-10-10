import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../config.js";
import { earlierRunWarnings } from "../earlier-runs.js";
import type { GuardBreach } from "../guards.js";
import { defaultKeyPath, loadPassphraseFile } from "../key.js";
import { withLock } from "../lock.js";
import { runMediaChecks } from "../media.js";
import { refreshProfiles } from "../profiles.js";
import { sweep } from "../source/sweep.js";
import { sync, unixNow, type SyncResult } from "../source/sync.js";
import type { State } from "../state.js";
import { build, type BuildResult } from "./build.js";
import { publish, type RelayPublishResult } from "./publish.js";
import { sign } from "./sign.js";
import { verify, verifySummary } from "./verify.js";

const SWEEP_EVERY_SECONDS = 7 * 86_400;

/** Each step of a run, so tests can stand in for the network, plus the clock and where lines go. */
export interface PipelineDeps {
  sync: typeof sync;
  sweep: typeof sweep;
  refreshProfiles: typeof refreshProfiles;
  runMediaChecks: typeof runMediaChecks;
  build: typeof build;
  sign: typeof sign;
  publish: typeof publish;
  verify: typeof verify;
  /** Unix seconds. */
  now: () => number;
  /** Progress and results, one line each. Defaults to stdout. */
  log: (line: string) => void;
  /** Warnings and reasons to stop. Defaults to stderr. */
  warn: (line: string) => void;
}

export interface RunOutcome {
  /** The run `build` wrote; null when an unattended run stopped before building (an earlier run is unfinished). */
  runDir: string | null;
  /** True when an unattended run stopped at the review gate: the run is built and left unsigned. */
  stoppedForReview: boolean;
  breaches: GuardBreach[];
  /** 2 when the run stopped for review, else 0. Anything that goes wrong throws instead. */
  exitCode: 0 | 2;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const syncSummary = (r: SyncResult): string =>
  `sync: videos new ${r.videos.new}, updated ${r.videos.updated}, unchanged ${r.videos.same}, older ${r.videos.older}, ` +
  `rejected ${r.videos.rejected}; deletions applied ${r.deletions.applied}, ignored ${r.deletions.ignored}` +
  (r.firstHarvest ? " (first harvest)" : "");

/** The lines `build` and `run` print for a finished build. */
export function buildSummary(r: BuildResult): string[] {
  const skipped = Object.entries(r.skipped).map(([reason, n]) => `${reason} ${n}`).join(", ");
  const lines = [
    `wrote ${r.runDir}`,
    `created ${r.created}, changed ${r.changed}, unchanged ${r.unchanged}, deletions ${r.deletions}`,
    `skipped: ${skipped === "" ? "none" : skipped}`,
  ];
  for (const b of r.breaches) lines.push(`guard breached: ${b.message}`);
  return lines;
}

/** The relays a publish left short, by name: one that was unreachable, or refused some events. */
export function shortRelays(results: Record<string, RelayPublishResult>): string[] {
  return Object.entries(results)
    .filter(([, r]) => r.failed > 0 || r.error !== undefined)
    .map(([name]) => name);
}

/** The lines `publish` and `run` print for a finished publish. */
export function publishSummary(results: Record<string, RelayPublishResult>): string[] {
  return Object.entries(results).map(([name, r]) => {
    const line =
      `${name}: sent ${r.sent}, ok ${r.ok}, failed ${r.failed}, skipped ${r.skipped}` +
      (r.settled ? `, settled ${r.settled}` : "");
    return r.error === undefined ? line : `${line}; ${r.error}`;
  });
}

/**
 * The passphrase an unattended run gives `sign` for an `ncryptsec` key: read from the file
 * `DIVINEBOT_PASSPHRASE_FILE` names. With no such file there is no safe way to ask (a prompt
 * on a terminal nobody watches would hang, or leak into a log), so it refuses.
 */
async function autoPassphrase(): Promise<string> {
  const file = process.env.DIVINEBOT_PASSPHRASE_FILE;
  if (file === undefined || file === "") {
    throw new Error(
      "the key is encrypted (an ncryptsec), and an unattended run cannot ask for its passphrase: " +
        "set DIVINEBOT_PASSPHRASE_FILE to a file that holds it, or run npm run sign yourself",
    );
  }
  return loadPassphraseFile(file);
}

/**
 * One run, start to finish, holding `<paths.state>.lock` throughout so two runs never overlap.
 *
 * Both modes read the source (`sync`, then `sweep` when the last one is a week old, never on a
 * first harvest; a sweep that throws is a warning and the run goes on with nothing vanished), refresh profiles, check media and `build`. A manual run stops there and prints
 * the run dir and the commands that come next. An unattended run (`auto`) refuses `pilot` and
 * `firstRun`, which want a human, and a state with no items, before reading anything; it stops for review, writing `NEEDS_REVIEW` into the run and
 * returning exit code 2, when the build breached a guard. When an earlier run is not fully
 * published it still syncs, sweeps, refreshes and checks media, but builds nothing (so
 * unfinished runs never pile up) and returns exit code 2 with no run dir. Otherwise it signs,
 * publishes to every relay and verifies. It throws when a relay
 * did not accept every event or relays and state disagree afterwards.
 */
export async function runPipeline(
  cfg: Config,
  state: State,
  opts: { auto: boolean; pilot?: number; firstRun?: boolean; deps?: Partial<PipelineDeps> },
): Promise<RunOutcome> {
  if (opts.auto && opts.pilot !== undefined) throw new Error("--auto does not take --pilot: a pilot run is for a person to check");
  if (opts.auto && opts.firstRun) throw new Error("--auto does not take --first-run: the first import is for a person to check");
  if (opts.auto) {
    // build would refuse this state too, but only after a full harvest (about 1.1 GB) and hours of media checks.
    const { live, deleted } = state.counts();
    if (live + deleted === 0) {
      throw new Error(
        `state ${cfg.paths.state} holds no items, live or deleted, and an automatic run never does the first import. ` +
          "If anything was published before, the state file was lost or replaced; restore it from a backup. " +
          "For the very first import, run npm run run -- --first-run (or --pilot N --first-run) and review it",
      );
    }
  }
  const d: PipelineDeps = {
    sync,
    sweep,
    refreshProfiles,
    runMediaChecks,
    build,
    sign,
    publish,
    verify,
    now: unixNow,
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
    ...opts.deps,
  };

  return withLock(`${cfg.paths.state}.lock`, async () => {
    // Read before this run builds its own dir, which would otherwise count as unpublished.
    const earlier = earlierRunWarnings(cfg, state);
    for (const line of earlier) d.warn(line);

    const firstHarvest = state.cursor("videos") === undefined;
    const synced = await d.sync(cfg, state);
    d.log(syncSummary(synced));

    let vanished = 0;
    const lastSweep = state.cursor("last_sweep");
    if (!firstHarvest && (lastSweep === undefined || d.now() - lastSweep > SWEEP_EVERY_SECONDS)) {
      // A failed sweep must not hold up the day's new videos: it marked nothing, and the next run tries again.
      try {
        const swept = await d.sweep(cfg, state);
        vanished = swept.vanished.length;
        d.log(`sweep: saw ${swept.seen} videos, ${plural(vanished, "video")} vanished, ${swept.upserted} stored`);
      } catch (err) {
        d.warn(`warning: the sweep failed, so this run marks nothing vanished: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const profiles = await d.refreshProfiles(cfg, state);
    d.log(`profiles: read ${profiles.fetched}, verified ${profiles.verified} handles`);
    const media = await d.runMediaChecks(cfg, state);
    d.log(
      `media: checked ${media.checked}, passed ${media.passed}, failed ${media.failed}, inconclusive ${media.inconclusive}` +
        (media.outage ? "; so many checks failed that the host looks down, so no failure was recorded" : ""),
    );

    if (opts.auto && earlier.length > 0) {
      // An earlier run is unfinished: state stays current, but no new run is built on top of it.
      d.warn(
        `stopped for review: not building a new run while ${plural(earlier.length, "earlier run")} ` +
          "is not fully published; sign and publish it, or delete its folder under out/ to discard it",
      );
      return { runDir: null, stoppedForReview: true, breaches: [], exitCode: 2 };
    }

    const built = await d.build(cfg, state, {
      pilot: opts.pilot,
      firstRun: opts.firstRun,
      media,
      sync: synced,
      vanished,
    });
    for (const line of buildSummary(built)) d.log(line);
    const runId = basename(built.runDir);

    if (!opts.auto) {
      d.log(`review ${join(built.runDir, "report.md")}, then:`);
      d.log(`  npm run sign -- ${runId}`);
      d.log(`  npm run publish -- ${runId}`);
      d.log("  npm run verify");
      return { runDir: built.runDir, stoppedForReview: false, breaches: built.breaches, exitCode: 0 };
    }

    const reasons = built.breaches.map((b) => b.message);
    if (reasons.length > 0) {
      writeFileSync(join(built.runDir, "NEEDS_REVIEW"), `${reasons.join("\n")}\n`);
      d.warn(`stopped for review: ${plural(reasons.length, "reason")}, listed in ${join(built.runDir, "NEEDS_REVIEW")}`);
      for (const reason of reasons) d.warn(`  ${reason}`);
      return { runDir: built.runDir, stoppedForReview: true, breaches: built.breaches, exitCode: 2 };
    }

    if (built.created + built.changed + built.deletions > 0) {
      const signed = await d.sign(cfg, built.runDir, { keyPath: defaultKeyPath(), askPassphrase: autoPassphrase });
      d.log(`signed ${signed.signed} events`);
      const results = await d.publish(cfg, state, built.runDir, undefined, { onNotice: d.warn });
      for (const line of publishSummary(results)) d.log(line);
      const short = shortRelays(results);
      if (short.length > 0) {
        throw new Error(
          `not every event was accepted on ${short.join(", ")}; run npm run publish -- ${runId} --relays ${short.join(",")} to send the rest`,
        );
      }
    } else {
      d.log("nothing to publish");
    }

    const { lines, warnings, failed } = verifySummary(await d.verify(cfg, state));
    for (const line of lines) d.log(line);
    for (const warning of warnings) d.warn(`warning: ${warning}`);
    if (failed.length > 0) throw new Error(`relays and state do not match on ${failed.join(", ")}`);
    return { runDir: built.runDir, stoppedForReview: false, breaches: [], exitCode: 0 };
  }, { warn: d.warn });
}
