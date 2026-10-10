import { domainToASCII } from "node:url";
import type { NostrEvent } from "nostr-tools/core";
import type { Config } from "./config.js";
import { streamEvents } from "./source/divine-relay.js";
import { pageOptions, unixNow } from "./source/sync.js";
import type { State } from "./state.js";

const PROFILE_KIND = 0;
const DAY_SECONDS = 86_400;
/** A NIP-05 answer is a few hundred bytes; anything past this is not one. */
const MAX_BODY_BYTES = 64 * 1024;
const HEX64_RE = /^[0-9a-f]{64}$/;
const LOCAL_RE = /^[a-z0-9._-]+$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const UNSAFE_DOMAIN_RE = /[\s/?#@:[\]\\]/;
/** A Divine user's own subdomain, `<u>.divine.video`, where `<u>` is one label. */
const DIVINE_SUBDOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?)\.divine\.video$/;

type ProfileContent = Record<string, unknown>;

/** The profile name to show: `display_name`, else `name`, trimmed and non-empty. Unicode is kept as it is. */
export function creatorName(content: ProfileContent | undefined): string | undefined {
  for (const key of ["display_name", "name"]) {
    const value = content?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Splits `local@domain` into its parts, lowercased, or returns undefined for anything that is not a
 * plain host name: no port, path, query, IP address or other oddity ever reaches a request.
 */
function parseIdentifier(identifier: string): { local: string; domain: string; id: string } | undefined {
  const parts = identifier.trim().split("@");
  if (parts.length !== 2) return undefined;
  const local = parts[0]!.toLowerCase();
  const rawDomain = parts[1]!.toLowerCase();
  if (!LOCAL_RE.test(local) || rawDomain === "" || UNSAFE_DOMAIN_RE.test(rawDomain)) return undefined;
  const domain = domainToASCII(rawDomain);
  const labels = domain.split(".");
  if (labels.length < 2 || domain.length > 253) return undefined;
  if (!labels.every((l) => l.length <= 63 && LABEL_RE.test(l))) return undefined;
  // A top-level label is never all digits, so this also keeps out IPv4 addresses.
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return undefined;
  return { local, domain, id: `${local}@${domain}` };
}

async function readLimited(res: Response, limit: number): Promise<string | null> {
  if (res.body === null) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function request(
  local: string,
  domain: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(local)}`;
    const res = await doFetch(url, { redirect: "manual", signal });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readLimited(res, MAX_BODY_BYTES);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const names = (parsed as { names?: unknown }).names;
    if (typeof names !== "object" || names === null || Array.isArray(names)) return null;
    if (!Object.hasOwn(names, local)) return null;
    const value = (names as Record<string, unknown>)[local];
    return typeof value === "string" && HEX64_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The pubkey that `local@domain` points to, or null. One HTTPS request with no redirects followed,
 * a time limit over the whole exchange (a server that ignores the abort is abandoned all the same)
 * and a 64 KB body limit. A malformed identifier makes no request. Every failure is null.
 */
export async function lookupNip05(
  identifier: string,
  opts: { timeoutMs: number; fetch?: typeof fetch },
): Promise<string | null> {
  const parsed = parseIdentifier(identifier);
  if (parsed === undefined) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, opts.timeoutMs);
  });
  try {
    return await Promise.race([request(parsed.local, parsed.domain, opts.fetch ?? fetch, controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** The normalized identifier the profile claims, or undefined when it has none or it is malformed. */
function claimedIdentifier(content: ProfileContent | undefined): string | undefined {
  const value = content?.nip05;
  return typeof value === "string" ? parseIdentifier(value)?.id : undefined;
}

/** For `_@<u>.divine.video`, the root-domain form `<u>@divine.video`. */
function divineRootOf(id: string): string | undefined {
  const [local, domain] = id.split("@") as [string, string];
  const user = local === "_" ? DIVINE_SUBDOMAIN_RE.exec(domain)?.[1] : undefined;
  return user === undefined ? undefined : `${user}@divine.video`;
}

/**
 * The one rule for the handle to write, given which identifiers are known to resolve to the pubkey:
 * `<u>@divine.video` when `_@<u>.divine.video` and `<u>@divine.video` both do, else the identifier
 * itself when it does, else nothing.
 */
function handleFor(id: string, matches: (id: string) => boolean): string | undefined {
  if (!matches(id)) return undefined;
  const root = divineRootOf(id);
  return root !== undefined && matches(root) ? root : id;
}

/**
 * The handle to write for the creator, from cached lookups only: no network, and the age of the
 * cached results is ignored. Undefined when nothing verified or nothing is cached.
 */
export function cachedNip05(pubkey: string, content: ProfileContent | undefined, state: State): string | undefined {
  const id = claimedIdentifier(content);
  if (id === undefined) return undefined;
  const want = pubkey.toLowerCase();
  return handleFor(id, (candidate) => state.nip05(candidate)?.pubkey === want);
}

/**
 * The handle to write for the creator, after a live lookup for each identifier whose cached result
 * is missing or older than `nip05TtlDays` (the root form is looked up only when the identifier itself
 * matched). Undefined when the profile's identifier does not resolve to `pubkey`.
 */
export async function verifiedNip05(
  pubkey: string,
  content: ProfileContent | undefined,
  state: State,
  cfg: Config,
  opts: { now?: () => number; fetch?: typeof fetch } = {},
): Promise<string | undefined> {
  const id = claimedIdentifier(content);
  if (id === undefined) return undefined;
  const now = opts.now ?? unixNow;
  const want = pubkey.toLowerCase();
  const ttl = cfg.profiles.nip05TtlDays * DAY_SECONDS;
  const fresh = (candidate: string) => {
    const cached = state.nip05(candidate);
    return cached !== undefined && now() - cached.checkedAt < ttl ? cached : undefined;
  };
  const ensure = async (candidate: string): Promise<boolean> => {
    let cached = fresh(candidate);
    if (cached === undefined) {
      const found = await lookupNip05(candidate, { timeoutMs: cfg.profiles.nip05TimeoutMs, fetch: opts.fetch });
      state.putNip05(candidate, found, now());
      cached = { pubkey: found, checkedAt: now() };
    }
    return cached.pubkey === want;
  };
  if (!(await ensure(id))) return undefined;
  const root = divineRootOf(id);
  if (root !== undefined) await ensure(root);
  return handleFor(id, (candidate) => fresh(candidate)?.pubkey === want);
}

/** The content object of a kind 0 event, or an empty one when it is not a JSON object. */
function parseProfile(ev: NostrEvent): ProfileContent {
  try {
    const parsed: unknown = JSON.parse(ev.content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as ProfileContent) : {};
  } catch {
    return {};
  }
}

/** True when `a` replaces `b` as an author's profile: newer, or the lower id on a tie. */
const supersedes = (a: NostrEvent, b: NostrEvent): boolean =>
  a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);

export interface RefreshOptions {
  /** Seconds since the epoch. */
  now?: () => number;
  stream?: typeof streamEvents;
  fetch?: typeof fetch;
}

/**
 * Reads kind 0 from the source relay for the creators of eligible active sources whose stored
 * profile is missing or older than `refreshDays`, `batchSize` authors per read, keeping each
 * author's newest. A batch is stored only after its read completes; a failed or stalled read
 * throws, and the batches before it stay stored. An author with no profile gets an empty one, so
 * the next run does not ask again before `refreshDays`; a stored profile newer than anything the
 * relay returned is kept. Then every creator whose profile names a NIP-05 identifier is verified
 * (live lookups only for results missing or older than `nip05TtlDays`), so that the cache is warm
 * for `cachedNip05`. `fetched` counts the profiles read from the relay, `verified` the creators
 * whose handle verified.
 */
export async function refreshProfiles(
  cfg: Config,
  state: State,
  opts: RefreshOptions = {},
): Promise<{ fetched: number; verified: number }> {
  const now = opts.now ?? unixNow;
  const stream = opts.stream ?? streamEvents;
  const page = pageOptions(cfg);
  const creators = [...new Set(state.sources({ status: "active", eligibleOnly: true }).map((s) => s.event.pubkey))].sort();
  const maxAge = cfg.profiles.refreshDays * DAY_SECONDS;
  const due = creators.filter((pk) => {
    const stored = state.profile(pk);
    return stored === undefined || now() - stored.fetchedAt >= maxAge;
  });

  let fetched = 0;
  for (let i = 0; i < due.length; i += cfg.profiles.batchSize) {
    const batch = due.slice(i, i + cfg.profiles.batchSize);
    const asked = new Set(batch);
    const newest = new Map<string, NostrEvent>();
    const read = await stream(cfg.source.relay, { kinds: [PROFILE_KIND], authors: batch }, page, (events) => {
      for (const ev of events) {
        if (ev.kind !== PROFILE_KIND || !asked.has(ev.pubkey)) continue;
        const held = newest.get(ev.pubkey);
        if (held === undefined || supersedes(ev, held)) newest.set(ev.pubkey, ev);
      }
    });
    if (read.stalledAt !== undefined) {
      throw new Error(
        `the relay at ${cfg.source.relay} holds more profiles at second ${read.stalledAt} than fit in one page, so older ones cannot be read`,
      );
    }
    const at = now();
    state.transaction(() => {
      for (const pk of batch) {
        const ev = newest.get(pk);
        const stored = state.profile(pk);
        if (ev !== undefined && (stored === undefined || ev.created_at >= stored.createdAt)) {
          state.putProfile(pk, parseProfile(ev), ev.created_at, at);
          fetched++;
        } else if (stored !== undefined) {
          state.putProfile(pk, stored.content, stored.createdAt, at);
        } else {
          state.putProfile(pk, {}, 0, at);
        }
      }
    });
  }

  let verified = 0;
  for (const pk of creators) {
    const content = state.profile(pk)?.content;
    if (claimedIdentifier(content) === undefined) continue;
    if ((await verifiedNip05(pk, content, state, cfg, { now, fetch: opts.fetch })) !== undefined) verified++;
  }
  return { fetched, verified };
}
