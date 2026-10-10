import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AbstractRelay } from "nostr-tools/abstract-relay";
import type { NostrEvent } from "nostr-tools/core";
import { validateEvent, verifyEvent } from "nostr-tools/pure";
import { relayUrl, type Config } from "../config.js";
import { contentHash } from "../diff.js";
import { tagValue } from "../tags.js";
import { checkRunConfig } from "../manifest.js";
import { connectRelay, publishEvent } from "../relay.js";
import type { State } from "../state.js";

const ITEM_KIND = 39999;
const DELETION_KIND = 5;
/** The kind of the source video an item is built from. */
const SOURCE_KIND = 34236;
/** Any non-empty d, line breaks and separators included (`s`), so publish never refuses what build wrote. */
const SOURCE_ADDRESS_RE = new RegExp(`^${SOURCE_KIND}:([0-9a-f]{64}:.+)$`, "s");
const PENDING = "pending";
const RATE_LIMITED = "rate-limited";
/** The message nostr-tools rejects a publish with when no OK came within the timeout. */
const TIMED_OUT = "publish timed out";
const DEFAULT_BACKOFF_MS = 30_000;
const DEFAULT_PROGRESS_EVERY = 500;
const DEFAULT_TIMEOUT_BREAKER = 20;
/** Why a deletion refused by a relay that never held its item needs no retry. */
const NEVER_HELD = "the relay never held the item";
/** Why a refusal `--settle-refused` closed needs no retry. */
const SETTLED_BY_OPERATOR = "settled by the operator with --settle-refused";

export interface PublishOptions {
  /**
   * Test hook, called once the final result of an (event, relay) pair is recorded, with the
   * number of pairs this call has finished across all relays. A throw stops the publish, as a
   * crash would, and propagates.
   */
  onEventSent?: (n: number) => void;
  /** The wait after a `rate-limited` reply before the one retry. Defaults to 30 s. */
  backoffMs?: number;
  /** A progress line goes out after every this many results recorded on a relay. Defaults to 500. */
  progressEvery?: number;
  /** Takes each progress line, `<relay>: <n>/<total>`. Defaults to a line on stderr. */
  onProgress?: (line: string) => void;
  /**
   * A relay is given up on, as if it had dropped the connection, after this many
   * `publish timed out` results in a row. Defaults to 20.
   */
  timeoutBreaker?: number;
  /** Takes a line for each refusal publish settles by itself (see publishTo). Defaults to a line on stderr. */
  onNotice?: (line: string) => void;
}

export interface RelayPublishResult {
  /** Events sent in this call, each counted once however many tries it took. */
  sent: number;
  ok: number;
  failed: number;
  /** Events the relay had already accepted, or refused with the refusal settled, in this run or an earlier one. Never resent. */
  skipped: number;
  /**
   * Deletions the relay refused although it never held any version of their item: nothing is
   * left to delete there, so they are settled, not failed. Present only when above 0.
   */
  settled?: number;
  /** Why the relay was given up on: it could not be reached, or it dropped the connection. */
  error?: string;
}

/**
 * A checked signed event, with the `d` of the item it publishes or deletes. An item also
 * carries `address`, `<pubkey>:<d>` of its source video, read from its `a` tag.
 */
interface Outgoing {
  event: NostrEvent;
  d: string;
  address?: string;
}

interface Run {
  cfg: Config;
  state: State;
  runId: string;
  outgoing: Outgoing[];
  backoffMs: number;
  progressEvery: number;
  onProgress: (line: string) => void;
  timeoutBreaker: number;
  onNotice: (line: string) => void;
  onEventSent?: (n: number) => void;
  /** Pairs finished so far, across relays. */
  finished: number;
  /** Aborted when any relay's loop throws, so the others stop too. */
  stop: AbortController;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The throttle protects public relays, so it must never fail open: a zero or missing rate
 * would make the gap between events infinite or NaN, and Node turns both into 1 ms.
 * loadConfig checks this too; publish does not rely on it.
 */
function checkPublishConfig(cfg: Config): void {
  const { eventsPerSecond, okTimeoutMs } = cfg.publish;
  for (const [name, value] of [["eventsPerSecond", eventsPerSecond], ["okTimeoutMs", okTimeoutMs]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`publish.${name} must be a number above 0, got ${String(value)}`);
    }
  }
}

/** The relay names to publish to: all configured ones, or the given subset, each known. */
function selectRelays(cfg: Config, names: string[] | undefined): string[] {
  if (names === undefined) return Object.keys(cfg.relays);
  const unique = [...new Set(names)];
  if (unique.length === 0) throw new Error("no relays selected");
  for (const name of unique) relayUrl(cfg, name);
  return unique;
}

/** The `d` named by a deletion's single `a` tag, `39999:<curator>:<d>`, if it has one. */
function deletedD(ev: NostrEvent, curatorPubkey: string): string | undefined {
  const coordinates = ev.tags.filter((t) => t[0] === "a").map((t) => t[1] ?? "");
  const prefix = `${ITEM_KIND}:${curatorPubkey}:`;
  if (coordinates.length !== 1 || !coordinates[0]!.startsWith(prefix)) return undefined;
  const d = coordinates[0]!.slice(prefix.length);
  return d === "" ? undefined : d;
}

/**
 * The source video's address, `<pubkey>:<d>`, named by an item's one `a` tag
 * `34236:<pubkey>:<d>`. Undefined when the item has none, has more than one, or the one is not
 * well formed: such an item is not one this tool built.
 */
function sourceAddress(tags: string[][]): string | undefined {
  const sources = tags.filter((t) => t[0] === "a" && (t[1] ?? "").startsWith(`${SOURCE_KIND}:`));
  if (sources.length !== 1) return undefined;
  return SOURCE_ADDRESS_RE.exec(sources[0]![1]!)?.[1];
}

/**
 * Reads `signed.jsonl` and checks every line before anything is sent: a nostr event, kind
 * 39999 or 5, signed by the curator with a valid id and signature, not repeated, items before
 * deletions, an item with a `d` tag and exactly one `z` naming the configured header, and a
 * deletion with an `a` tag naming the curator's item. The first bad line stops the publish,
 * so a run is never half sent because of its own file. An item must also name its source
 * video in one well-formed `a` tag (`34236:<pubkey>:<d>`), which is where state's address comes
 * from.
 */
function readSigned(path: string, cfg: Pick<Config, "curatorPubkey" | "headerCoordinate">): Outgoing[] {
  const { curatorPubkey, headerCoordinate } = cfg;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${path} not found; run npm run sign -- <runId> first`);
    }
    throw err;
  }
  if (text.trim() === "") throw new Error(`${path} has no events; nothing to publish`);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop(); // the newline that ends the last line

  const lineOf = new Map<string, number>();
  let deletionSeen = false;
  return lines.map((line, i): Outgoing => {
    const n = i + 1;
    const bad = (why: string): never => {
      throw new Error(`signed.jsonl line ${n}: ${why}; nothing was sent`);
    };
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return bad("not valid JSON");
    }
    if (!validateEvent(raw)) return bad("not a nostr event");
    const ev = raw as NostrEvent;
    if (typeof ev.id !== "string" || typeof ev.sig !== "string") return bad("not a nostr event");
    if (ev.kind !== ITEM_KIND && ev.kind !== DELETION_KIND) {
      return bad(`kind ${ev.kind} is not published here; publish sends only items (39999) and deletions (5)`);
    }
    if (ev.pubkey !== curatorPubkey) return bad(`signed by ${ev.pubkey}, not the curator ${curatorPubkey}`);
    if (!verifyEvent(ev)) return bad("the id or signature does not verify");
    const earlier = lineOf.get(ev.id);
    if (earlier !== undefined) return bad(`repeats line ${earlier}`);
    lineOf.set(ev.id, n);

    if (ev.kind === DELETION_KIND) {
      deletionSeen = true;
      return { event: ev, d: deletedD(ev, curatorPubkey) ?? bad(`a deletion needs one a tag ${ITEM_KIND}:${curatorPubkey}:<d>`) };
    }
    if (deletionSeen) return bad("an item after a deletion; deletions go last");
    const d = tagValue(ev.tags, "d") ?? "";
    if (d === "") return bad("an item needs a d tag");
    const z = ev.tags.filter((t) => t[0] === "z").map((t) => t[1] ?? "");
    if (z.length !== 1) return bad(`an item needs exactly one z tag, the header ${headerCoordinate}`);
    if (z[0] !== headerCoordinate) return bad(`z is ${z[0]}, not the header ${headerCoordinate}`);
    const address = sourceAddress(ev.tags);
    if (address === undefined) {
      return bad(`an item needs one a tag naming its source video, ${SOURCE_KIND}:<pubkey>:<d>`);
    }
    return { event: ev, d, address };
  });
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Spaces the sends it is awaited before at least `1 / eventsPerSecond` seconds apart. */
function throttle(eventsPerSecond: number, signal: AbortSignal): () => Promise<void> {
  const gapMs = 1000 / eventsPerSecond;
  let next = 0;
  return async () => {
    await sleep(next - Date.now(), signal);
    next = Date.now() + gapMs;
  };
}

function record(
  run: Run,
  relay: string,
  { event, d }: Outgoing,
  res: { ok: boolean; message: string; settled?: string },
): void {
  run.state.recordResult({
    eventId: event.id,
    d,
    kind: event.kind,
    createdAt: event.created_at,
    runId: run.runId,
    relay,
    ok: res.ok,
    message: res.message,
    ...(res.settled === undefined ? {} : { settled: res.settled }),
  });
}

/**
 * True for a deletion `relay` has never accepted any version of the item for: neither an id the
 * deletion names nor any version state recorded for its `d`. A refusal there leaves nothing
 * on the relay to delete.
 */
function neverHeld(state: State, { event, d }: Outgoing, relay: string): boolean {
  if (event.kind !== DELETION_KIND) return false;
  const ids = new Set([...event.tags.filter((t) => t[0] === "e" && t[1]).map((t) => t[1]!), ...state.versionsOf(d)]);
  return ![...ids].some((id) => state.acceptedOn(id, relay));
}

/**
 * What an event's first acceptance on any relay means for the item. Nothing, when a newer
 * event already moved the item (an older run published after a newer one): state never goes
 * back in time, and the relays keep the newer version too.
 */
function applyFirstOk(state: State, { event, d, address }: Outgoing): void {
  const changedAt = state.lastChanged(d);
  if (changedAt !== undefined && changedAt > event.created_at) return;
  if (event.kind === ITEM_KIND) {
    state.markLive(d, contentHash(event.tags), JSON.stringify(event.tags), event.id, event.created_at, address!);
  } else {
    state.markDeleted(d, event.created_at);
  }
}

/**
 * Sends the run's events that `name` has not accepted yet, in file order, one at a time.
 * Every pair is recorded as pending before it is sent and with its real result after, so a
 * crash in between never hides a version from a later deletion. An item becomes live (or a
 * deletion's item deleted) on the event's first OK on any relay, and that happens before the
 * OK is recorded: if the process dies in between, the pair is resent and applied again.
 *
 * Every `progressEvery` results a line `<relay>: <n>/<total>` goes to `onProgress`, counting
 * the events this call sends. A relay that drops the connection, or lets `timeoutBreaker`
 * events in a row time out, is given up on with an `error`; what it did not accept is sent
 * again by the next publish of the run.
 */
async function publishTo(run: Run, name: string): Promise<RelayPublishResult> {
  const { cfg, state } = run;
  const url = relayUrl(cfg, name);
  const todo = run.outgoing.filter((o) => !state.acceptedOn(o.event.id, name) && !state.settledOn(o.event.id, name));
  const result: RelayPublishResult = { sent: 0, ok: 0, failed: 0, skipped: run.outgoing.length - todo.length };
  if (todo.length === 0 || run.stop.signal.aborted) return result;

  let relay: AbstractRelay;
  try {
    relay = await connectRelay(url, cfg.publish.okTimeoutMs);
  } catch (err) {
    return { ...result, error: errorText(err) };
  }
  try {
    const signal = run.stop.signal;
    const pace = throttle(cfg.publish.eventsPerSecond, signal);
    let timeoutsInARow = 0;
    for (const out of todo) {
      await pace();
      if (signal.aborted) break;
      record(run, name, out, { ok: false, message: PENDING });
      let res = await publishEvent(relay, out.event, cfg.publish.okTimeoutMs);
      if (!res.ok && res.message.startsWith(RATE_LIMITED)) {
        record(run, name, out, res);
        await sleep(run.backoffMs, signal);
        await pace();
        if (signal.aborted) break;
        res = await publishEvent(relay, out.event, cfg.publish.okTimeoutMs);
      }
      if (res.ok && !state.acceptedAnywhere(out.event.id)) applyFirstOk(state, out);
      // A real refusal: the relay answered OK false, not a timeout, a rate limit or a dropped connection.
      const refused = !res.ok && relay.connected && res.message !== TIMED_OUT && !res.message.startsWith(RATE_LIMITED);
      const settle = refused && neverHeld(state, out, name);
      if (settle) {
        record(run, name, out, { ...res, settled: NEVER_HELD });
        result.settled = (result.settled ?? 0) + 1;
        run.onNotice(`deletion refused by ${name}; ${NEVER_HELD} (${out.d}, event ${out.event.id})`);
      } else {
        record(run, name, out, res);
      }
      result.sent++;
      if (res.ok) result.ok++;
      else if (!settle) result.failed++;
      run.onEventSent?.(++run.finished);
      if (result.sent % run.progressEvery === 0) run.onProgress(`${name}: ${result.sent}/${todo.length}`);
      const events = `${result.sent} event${result.sent === 1 ? "" : "s"}`;
      if (!res.ok && !relay.connected) {
        result.error = `lost the connection to ${url} after ${events} (${res.message})`;
        break;
      }
      timeoutsInARow = !res.ok && res.message === TIMED_OUT ? timeoutsInARow + 1 : 0;
      if (timeoutsInARow >= run.timeoutBreaker) {
        result.error =
          `${url} did not answer ${timeoutsInARow} events in a row within ` +
          `${cfg.publish.okTimeoutMs / 1000} s each; gave up after ${events}`;
        break;
      }
    }
  } finally {
    relay.close();
  }
  return result;
}

/**
 * Publishes `<runDir>/signed.jsonl` to the named relays (default: every configured relay).
 *
 * The run must have been built with this config (checkRunConfig), and every line is checked
 * first (see readSigned): one bad line sends nothing. Then each
 * relay gets its own connection and throttle loop at `publish.eventsPerSecond`, all relays at
 * once, file order kept within each, so items go before deletions. Pairs the relay already
 * accepted are skipped, which makes a rerun resume an interrupted publish. Every result is
 * recorded, but an event older than the item's last change never moves it (applyFirstOk).
 * A `rate-limited` reply waits `backoffMs` and is retried once. A relay that cannot be
 * reached, drops the connection, or times out `timeoutBreaker` events in a row gets an `error`
 * and the others carry on. Progress goes to stderr (see publishTo). Anything else that throws
 * (the `onEventSent` hook, the state store) stops every relay and propagates.
 */
export async function publish(
  cfg: Config,
  state: State,
  runDir: string,
  relayNames?: string[],
  opts: PublishOptions = {},
): Promise<Record<string, RelayPublishResult>> {
  checkPublishConfig(cfg);
  checkRunConfig(cfg, runDir);
  const names = selectRelays(cfg, relayNames);
  const run: Run = {
    cfg,
    state,
    runId: basename(runDir),
    outgoing: readSigned(join(runDir, "signed.jsonl"), cfg),
    backoffMs: opts.backoffMs ?? DEFAULT_BACKOFF_MS,
    progressEvery: opts.progressEvery ?? DEFAULT_PROGRESS_EVERY,
    onProgress: opts.onProgress ?? ((line) => process.stderr.write(`${line}\n`)),
    timeoutBreaker: opts.timeoutBreaker ?? DEFAULT_TIMEOUT_BREAKER,
    onNotice: opts.onNotice ?? ((line) => process.stderr.write(`${line}\n`)),
    onEventSent: opts.onEventSent,
    finished: 0,
    stop: new AbortController(),
  };
  const settled = await Promise.allSettled(
    names.map((name) =>
      publishTo(run, name).catch((err: unknown) => {
        run.stop.abort();
        throw err;
      }),
    ),
  );
  const results: Record<string, RelayPublishResult> = {};
  for (const [i, s] of settled.entries()) {
    if (s.status === "rejected") throw s.reason;
    results[names[i]!] = s.value;
  }
  return results;
}

/**
 * `publish --settle-refused`: settles every final refusal recorded for the run (see
 * `State.settleRefused`), so a run a relay will never fully accept can be closed without
 * deleting its folder. Sends nothing. Returns what was settled, for the caller to print.
 */
export function settleRefused(
  cfg: Config,
  state: State,
  runDir: string,
): { eventId: string; d: string; kind: number; relay: string; message: string }[] {
  checkRunConfig(cfg, runDir);
  return state.settleRefused(basename(runDir), SETTLED_BY_OPERATOR);
}
