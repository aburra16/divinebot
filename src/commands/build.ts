import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NostrEvent } from "nostr-tools/core";
import { readSearch, relayUrl, type Config } from "../config.js";
import { deletionFor, type Unsigned } from "../deletion.js";
import { diffItems, parseTags, summarizeChanges } from "../diff.js";
import { breachesOf, guardResults, type GuardBreach, type GuardInput } from "../guards.js";
import { checkHeader, fetchHeader } from "../header.js";
import { buildItem, fitItem, itemD } from "../item.js";
import { configIdentity } from "../manifest.js";
import { thumbnailUrl, videoUrl, type MediaRunResult } from "../media.js";
import { selectPilot } from "../pilot.js";
import { cachedNip05, creatorName } from "../profiles.js";
import { renderReport, type ReportBuildError, type ReportDeletion } from "../report.js";
import { imeta } from "../source/classify.js";
import { unixNow, type SyncResult } from "../source/sync.js";
import type { SourceRow, State } from "../state.js";
import { tagValue, type Tags } from "../tags.js";

export interface BuildOptions {
  /** Build only this many new items, chosen by `selectPilot`. Never emits changed items or deletions. */
  pilot?: number;
  /** Allow a state that holds no items, live or deleted: the very first import only. */
  firstRun?: boolean;
  /** Defaults to `YYYYMMDDTHHMMSSZ` (UTC) from `now`, plus `-pilot` for a pilot build. */
  runId?: string;
  /** The header event; when absent it is read from `cfg.headerRelay`. Tests inject it. */
  header?: NostrEvent;
  /** This run's media checks, for the outage guard; null or absent when none ran. */
  media?: MediaRunResult | null;
  /** This run's sync, for the empty-source guard; null or absent when none ran. */
  sync?: SyncResult | null;
  /** Sources the sweep marked vanished in this run; 0 when no sweep ran. */
  vanished?: number;
  /** Unix seconds. */
  now?: () => number;
}

export interface BuildResult {
  runDir: string;
  created: number;
  changed: number;
  unchanged: number;
  deletions: number;
  /**
   * Active native videos not built, by skip reason, plus `media-failed`, `media-pending`,
   * `too-large` (over the item size limit even without a description) and `build-error`.
   */
  skipped: Record<string, number>;
  /** Guards this run breaches. The run is written anyway; `run --auto` decides what to do. */
  breaches: GuardBreach[];
}

const ITEM_KIND = 39999;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WEEK_SECONDS = 7 * 86_400;

/**
 * `<paths.out>/<runId>`. A run id is a plain directory name: it cannot be empty, hold a
 * separator, or start with a dot, so it can never point outside `paths.out`.
 */
export function runDirFor(cfg: Config, runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`run id "${runId}" must be a plain directory name`);
  return join(cfg.paths.out, runId);
}

/** Unix seconds `1800000000` becomes `20270115T080000Z`. */
function timestampId(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

function checkOptions(opts: BuildOptions): void {
  if (opts.pilot !== undefined && !(Number.isInteger(opts.pilot) && opts.pilot > 0)) {
    throw new Error(`pilot must be a positive integer, got ${opts.pilot}`);
  }
  if (opts.vanished !== undefined && !(Number.isSafeInteger(opts.vanished) && opts.vanished >= 0)) {
    throw new Error(`vanished must be a whole number of at least 0, got ${opts.vanished}`);
  }
}

/**
 * State is the only record of what was published. A lost or replaced state file reads as empty,
 * and a build on it would publish every video again as new and never delete the old versions.
 * So an empty state is refused unless the caller says this is the very first import.
 */
function checkFirstRun(cfg: Config, state: State, firstRun: boolean): void {
  const { live, deleted } = state.counts();
  if (live + deleted > 0 || firstRun) return;
  throw new Error(
    `state ${cfg.paths.state} holds no items, live or deleted. If anything was published before, the ` +
      "state file was lost or replaced, and this build would publish every video again; restore it " +
      "from a backup. For the very first import, run build again with --first-run",
  );
}

/**
 * Claims `runDir` (mkdir fails if it exists) and writes each file through a temp name, so a
 * crash never leaves a truncated file. On a write error the half-written run is removed.
 */
function writeRun(runDir: string, files: [name: string, data: string][]): void {
  mkdirSync(dirname(runDir), { recursive: true });
  mkdirSync(runDir);
  try {
    for (const [name, data] of files) {
      const path = join(runDir, name);
      writeFileSync(`${path}.tmp`, data);
      renameSync(`${path}.tmp`, path);
    }
  } catch (err) {
    rmSync(runDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Where a source stands for this build:
 * - `build`: eligible, active, in scope, and every media row it needs is a pass;
 * - `pending`: as `build`, but a media row is missing (never checked, or only inconclusive so far);
 * - `gone`: anything else, with the reason. Only a stored `fail` row counts against the media.
 */
type Verdict = { kind: "build" } | { kind: "pending" } | { kind: "gone"; reason: string; mediaFailed?: boolean };

function inScope(cfg: Config, row: SourceRow): boolean {
  return row.class === "native" || (cfg.scope.includeVines && row.class === "vine");
}

function verdictFor(cfg: Config, state: State, row: SourceRow | undefined): Verdict {
  if (row === undefined) return { kind: "gone", reason: "its source video is no longer in state" };
  if (row.status === "deleted") return { kind: "gone", reason: "deleted by its author" };
  if (row.status === "vanished") return { kind: "gone", reason: "vanished from the source relay" };
  if (row.skipReason !== null) {
    return { kind: "gone", reason: `no longer eligible: ${row.skipReason}` };
  }
  if (!inScope(cfg, row)) return { kind: "gone", reason: `out of scope: ${row.class}` };

  const meta = imeta(row.event);
  const sha = meta?.x;
  if (!sha) return { kind: "gone", reason: "no longer eligible: no video hash" };
  // The exact string media.ts checks and buildItem writes.
  const thumb = thumbnailUrl(row.event);
  const video = state.media(videoUrl(sha, cfg.media.base));
  const image = thumb === undefined ? undefined : state.media(thumb);
  if (video?.status === "fail") {
    return { kind: "gone", reason: `the video failed its media check (HTTP ${video.httpStatus})`, mediaFailed: true };
  }
  if (image?.status === "fail") {
    return { kind: "gone", reason: `the thumbnail failed its media check (HTTP ${image.httpStatus})`, mediaFailed: true };
  }
  if (video === undefined || (thumb !== undefined && image === undefined)) return { kind: "pending" };
  return { kind: "build" };
}

/**
 * True when this run's sync read no videos at all while state holds active native videos from the
 * week before the videos cursor: a window that held events now reads empty, which points at the
 * relay rather than at the creators.
 */
function sourceEmpty(state: State, sync: SyncResult | null | undefined, natives: SourceRow[]): boolean {
  if (!sync) return false;
  const v = sync.videos;
  if (v.new + v.updated + v.same + v.older > 0) return false;
  const cursor = state.cursor("videos");
  if (cursor === undefined) return false;
  return natives.some((row) => row.status === "active" && row.createdAt >= cursor - WEEK_SECONDS && row.createdAt <= cursor);
}

const increment = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * Builds the next run from state. Checks the header (read from `cfg.headerRelay` unless
 * injected), builds an item for every eligible active native source whose media rows pass, diffs
 * them against the live items and writes `<paths.out>/<runId>/{unsigned.jsonl,manifest.json,report.md}`:
 * new and changed items first, then a kind 5 for every live item that is gone (spec § 6.2). A live
 * item whose media checks are pending is kept as it is, neither changed nor deleted, so a media
 * outage never deletes anything. A pilot build writes only new items chosen by `selectPilot`.
 * The guards of spec § 7.3 are checked and recorded, and the run is written whether or not they
 * pass. A state with no items at all is refused unless `firstRun` is set. The header is the only
 * network read: profiles and NIP-05 handles come from state alone.
 */
export async function build(cfg: Config, state: State, opts: BuildOptions = {}): Promise<BuildResult> {
  checkOptions(opts);
  const now = opts.now ?? unixNow;
  const pilot = opts.pilot;
  const firstRun = opts.firstRun ?? false;

  const runId = opts.runId ?? `${timestampId(now())}${pilot !== undefined ? "-pilot" : ""}`;
  const runDir = runDirFor(cfg, runId);
  if (existsSync(runDir)) throw new Error(`${runDir} already exists; a run is never overwritten`);

  checkFirstRun(cfg, state, firstRun);

  const header =
    opts.header ??
    (await fetchHeader(relayUrl(cfg, cfg.headerRelay), cfg.headerCoordinate, undefined, readSearch(cfg, cfg.headerRelay)));
  checkHeader(header, cfg);

  const natives = state.sources({ class: "native" });
  const scoped = cfg.scope.includeVines ? [...natives, ...state.sources({ class: "vine" })] : natives;
  const byAddress = new Map(scoped.map((row) => [row.address, row]));
  const live = state.liveItems();

  const profiles = new Map<string, { creator?: string; nip05?: string }>();
  const contextFor = (pubkey: string) => {
    let ctx = profiles.get(pubkey);
    if (ctx === undefined) {
      const content = state.profile(pubkey)?.content;
      ctx = { creator: creatorName(content), nip05: cachedNip05(pubkey, content, state) };
      profiles.set(pubkey, ctx);
    }
    return ctx;
  };

  const skipped: Record<string, number> = {};
  const sourceCounts = { active: 0, eligible: 0, deleted: 0, vanished: 0 };
  const buildable = new Map<string, { tags: Tags; pubkey: string }>();
  const verdicts = new Map<string, Verdict>();
  const buildErrors: ReportBuildError[] = [];
  for (const row of scoped) {
    if (row.class === "native") {
      if (row.status === "active") sourceCounts.active++;
      else sourceCounts[row.status]++;
      if (row.status === "active" && row.skipReason !== null) increment(skipped, row.skipReason);
      if (row.status === "active" && row.skipReason === null) sourceCounts.eligible++;
    }
    if (row.status !== "active" || row.skipReason !== null) continue;
    const verdict = verdictFor(cfg, state, row);
    verdicts.set(row.address, verdict);
    if (verdict.kind === "build") {
      let tags: Tags | undefined;
      try {
        tags = buildItem(row.event, { headerCoordinate: cfg.headerCoordinate, mediaBase: cfg.media.base, ...contextFor(row.event.pubkey) });
      } catch (err) {
        // One odd source must not stop the build. Its live item, if any, is kept as it is.
        increment(skipped, "build-error");
        buildErrors.push({ address: row.address, message: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const fitted = fitItem(tags);
      if (fitted === undefined) {
        increment(skipped, "too-large");
        verdicts.set(row.address, { kind: "gone", reason: "no longer eligible: too-large" });
        continue;
      }
      buildable.set(itemD(row.event), { pubkey: row.event.pubkey, tags: fitted });
    } else if (verdict.kind === "gone" && verdict.mediaFailed) {
      increment(skipped, "media-failed");
    } else if (verdict.kind === "pending" && !live.has(itemD(row.event))) {
      increment(skipped, "media-pending");
    }
  }

  // Every live item is built, kept (pending media, or a build error) or gone.
  let keptPending = 0;
  const gone: { d: string; reason: string }[] = [];
  for (const [d, item] of live) {
    if (buildable.has(d)) continue;
    const verdict = verdicts.get(item.address) ?? verdictFor(cfg, state, byAddress.get(item.address) ?? state.source(item.address));
    if (verdict.kind === "pending") keptPending++;
    else if (verdict.kind === "gone") gone.push({ d, reason: verdict.reason });
  }
  gone.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));

  let built: Map<string, Tags>;
  let candidates = 0;
  if (pilot !== undefined) {
    const fresh = [...buildable].filter(([d]) => !live.has(d));
    candidates = fresh.length;
    const picks = selectPilot(
      fresh.map(([d, { tags, pubkey }]) => ({ d, pubkey, published: tagValue(tags, "published") ?? "" })),
      pilot,
    );
    built = new Map(picks.map((d) => [d, buildable.get(d)!.tags]));
  } else {
    built = new Map([...buildable].map(([d, { tags }]) => [d, tags]));
  }

  const diff = diffItems(built, live, { detectGone: false });
  const doomed = pilot === undefined ? gone : [];
  // Every recorded version, plus the latest id in case a crash kept it out of the events table.
  const deletions = doomed.map(({ d }) =>
    deletionFor(d, [...state.versionsOf(d), live.get(d)!.latestEventId], cfg.curatorPubkey),
  );
  const events: Unsigned[] = [
    ...[...diff.created, ...diff.changed].map((tags) => ({ kind: ITEM_KIND, tags, content: "" })),
    ...deletions,
  ];

  const guardInput: GuardInput = {
    liveItems: live.size,
    newOrChanged: diff.created.length + diff.changed.length,
    deletions: deletions.length,
    vanished: opts.vanished ?? 0,
    media: opts.media ?? null,
    sourceEmpty: sourceEmpty(state, opts.sync, natives),
  };
  const guards = guardResults(cfg, guardInput);
  const breaches = breachesOf(guards);

  const result: BuildResult = {
    runDir,
    created: diff.created.length,
    changed: diff.changed.length,
    unchanged: diff.unchanged,
    deletions: deletions.length,
    skipped,
    breaches,
  };
  const manifest = {
    runId,
    // sign and publish refuse the run under any other config (checkRunConfig).
    config: configIdentity(cfg),
    headerEventId: header.id,
    options: { pilot: pilot ?? null, firstRun },
    counts: {
      created: result.created,
      changed: result.changed,
      unchanged: result.unchanged,
      deletions: result.deletions,
      keptPending,
      skipped,
    },
    breaches,
  };

  const reportDeletions: ReportDeletion[] = doomed.map(({ d, reason }, i) => {
    const title = tagValue(parseTags(live.get(d)!.tagsJson), "title");
    const eventIds = deletions[i]!.tags.filter((t) => t[0] === "e").length;
    return title === undefined ? { d, reason, eventIds } : { d, title, reason, eventIds };
  });
  const report = renderReport({
    runId,
    header,
    firstRun,
    pilot: pilot === undefined ? null : { size: pilot, candidates },
    sources: sourceCounts,
    counts: { ...result, keptPending },
    skipped,
    changes: summarizeChanges(diff.changed, live),
    titles: new Map(diff.changed.map((tags) => [tagValue(tags, "d") ?? "", tagValue(tags, "title") ?? ""])),
    deletions: reportDeletions,
    buildErrors,
    guards,
    built,
  });

  writeRun(runDir, [
    ["report.md", report],
    ["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["unsigned.jsonl", events.map((e) => `${JSON.stringify(e)}\n`).join("")],
  ]);
  return result;
}

