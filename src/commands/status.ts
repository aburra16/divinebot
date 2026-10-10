import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { earlierRunWarnings } from "../earlier-runs.js";
import type { CursorName, State } from "../state.js";

const CLASSES = ["native", "vine", "user-submitted"] as const;
const CURSORS: [CursorName, string][] = [
  ["videos", "videos cursor"],
  ["deletions", "deletions cursor"],
  ["last_sweep", "last sweep"],
];

/** Unix seconds as `2027-01-15 08:00:00 UTC`. */
function utc(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "")} UTC`;
}

/** The run dirs in `<paths.out>` that hold a NEEDS_REVIEW file, in name order. */
function runsNeedingReview(cfg: Config): string[] {
  let entries: string[];
  try {
    entries = readdirSync(cfg.paths.out, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((name) => existsSync(join(cfg.paths.out, name, "NEEDS_REVIEW")));
}

/**
 * What `npm run status` prints, as plain lines: live and deleted items, eligible active sources by
 * class, the active sources that are skipped and why, the cursors as UTC times, each relay's
 * latest run, the earlier runs that are not fully published (what actually stops an unattended
 * run), and the run dirs marked NEEDS_REVIEW. Reads state with counts and tallies only, so
 * it stays quick on a large state.
 */
export function status(cfg: Config, state: State): string {
  const lines: string[] = [];
  const { live, deleted } = state.counts();
  lines.push(`items: ${live} live, ${deleted} deleted`);

  const tally = state.sourceTally();
  const eligible = (cls: string) =>
    tally.filter((t) => t.class === cls && t.status === "active" && t.skipReason === null).reduce((n, t) => n + t.count, 0);
  lines.push(`eligible sources: ${CLASSES.map((cls) => `${cls} ${eligible(cls)}`).join(", ")}`);
  const ofStatus = (s: string) => tally.filter((t) => t.status === s).reduce((n, t) => n + t.count, 0);
  lines.push(`sources gone: ${ofStatus("deleted")} deleted by their author, ${ofStatus("vanished")} vanished from the source relay`);

  const skips = new Map<string, number>();
  for (const t of tally) {
    if (t.status === "active" && t.skipReason !== null) skips.set(t.skipReason, (skips.get(t.skipReason) ?? 0) + t.count);
  }
  if (skips.size === 0) {
    lines.push("skipped sources: none");
  } else {
    lines.push("skipped sources, by reason:");
    for (const [reason, count] of [...skips].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
      lines.push(`  ${reason}: ${count}`);
    }
  }

  for (const [name, label] of CURSORS) {
    const value = state.cursor(name);
    lines.push(`${label}: ${value === undefined ? "never" : utc(value)}`);
  }

  const latest = new Map<string, { runId: string; ok: number; failed: number }>();
  for (const run of state.runs()) {
    const seen = latest.get(run.relay);
    if (seen === undefined || run.runId > seen.runId) latest.set(run.relay, run);
  }
  if (latest.size === 0) {
    lines.push("relays: no relay has had a run yet");
  } else {
    lines.push("last run per relay:");
    for (const [relay, run] of [...latest].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      lines.push(`  ${relay}: run ${run.runId}, ${run.ok} accepted, ${run.failed} failed`);
    }
  }

  const unfinished = earlierRunWarnings(cfg, state);
  if (unfinished.length > 0) {
    lines.push("unfinished runs (an unattended run builds nothing while any exists):");
    for (const warning of unfinished) lines.push(`  ${warning}`);
    lines.push("  sign and publish the run you want to keep, or delete the run's folder under out/ to discard it");
  }

  const review = runsNeedingReview(cfg);
  if (review.length > 0) {
    lines.push(`runs marked NEEDS_REVIEW (the build breached a guard): ${review.join(", ")}`);
    lines.push("  NEEDS_REVIEW is only a marker; deleting it unblocks nothing. Read it and report.md, then finish or discard the run as above");
  }
  return `${lines.join("\n")}\n`;
}
