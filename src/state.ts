import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { NostrEvent } from "nostr-tools/core";

/** A live item. Structurally a superset of diff.ts's `LiveItem`, so `diffItems(state.liveItems(), …)` type-checks. */
export interface LiveItem {
  d: string;
  contentHash: string;
  tagsJson: string;
  latestEventId: string;
  /** `<pubkey>:<divine d>` of the source video the item was built from. */
  address: string;
}

export type SourceClass = "native" | "vine" | "user-submitted";
export type SourceStatus = "active" | "deleted" | "vanished";
export type CursorName = "videos" | "deletions" | "last_sweep";

export interface SourceRow {
  address: string;
  eventId: string;
  createdAt: number;
  event: NostrEvent;
  class: SourceClass;
  status: SourceStatus;
  /** Why the video is not eligible for the list, or null when it is. */
  skipReason: string | null;
  lastSeen: number;
}

export interface State {
  liveItems(): Map<string, LiveItem>;
  /** How many items are live and how many were deleted, for the console's overview. */
  counts(): { live: number; deleted: number };
  /** The `d` of every item whose status is deleted, sorted. Reads only. */
  deletedItems(): string[];
  /** Every kind-39999 event id ever recorded for `d`, on any relay, ok or not. Oldest first. */
  versionsOf(d: string): string[];
  acceptedOn(eventId: string, relay: string): boolean;
  /** True once any relay has accepted `eventId`: publish acts on an event's first OK only. */
  acceptedAnywhere(eventId: string): boolean;
  recordResult(r: {
    eventId: string;
    d: string;
    kind: number;
    createdAt: number;
    runId: string;
    relay: string;
    ok: boolean;
    message: string;
  }): void;
  markLive(d: string, contentHash: string, tagsJson: string, eventId: string, at: number, address: string): void;
  markDeleted(d: string, at: number): void;
  /** The item's last_changed (the `at` of its latest markLive or markDeleted), live or not. */
  lastChanged(d: string): number | undefined;
  runs(): { runId: string; relay: string; ok: number; failed: number }[];

  cursor(name: CursorName): number | undefined;
  setCursor(name: CursorName, value: number): void;

  /**
   * Records a source event. Keeps the newer `created_at` (ties: the lower id, as NIP-01 replaceable
   * events); an older event returns "older" and writes nothing. The same event again refreshes
   * `last_seen`, class and skip reason. A newer version, or the same event seen again after it
   * vanished, makes the source active; a deleted source stays deleted until a newer version arrives.
   */
  upsertSource(ev: NostrEvent, cls: SourceClass, skipReason: string | null, seenAt: number): "new" | "updated" | "same" | "older";
  setSourceStatus(address: string, status: SourceStatus, at: number): void;
  source(address: string): SourceRow | undefined;
  /** The source whose stored (newest) version has this event id. Indexed. */
  sourceByEventId(eventId: string): SourceRow | undefined;
  /** Sources ordered by address. `eligibleOnly` keeps rows with no skip reason. Loads every match into memory. */
  sources(filter?: { status?: SourceStatus; class?: SourceClass; eligibleOnly?: boolean }): SourceRow[];
  /** Marks sources as seen without rewriting them; a vanished one seen again becomes active. */
  touchSources(addresses: string[], seenAt: number): void;
  /** The address of every source matching the filter, sorted. Unlike `sources`, it does not load the events. */
  sourceAddresses(filter?: { status?: SourceStatus; class?: SourceClass }): string[];
  /** How many sources there are per class, status and skip reason (null when eligible), for the status overview. Reads no events. */
  sourceTally(): { class: SourceClass; status: SourceStatus; skipReason: string | null; count: number }[];
  /** Runs `fn` in one SQLite transaction: all of its writes commit together, or none do if it throws. Nests. */
  transaction<T>(fn: () => T): T;

  profile(pubkey: string): { content: Record<string, unknown>; createdAt: number; fetchedAt: number } | undefined;
  putProfile(pubkey: string, content: Record<string, unknown>, createdAt: number, fetchedAt: number): void;
  /** `pubkey` is null when the check ran and the identifier did not verify. */
  nip05(identifier: string): { pubkey: string | null; checkedAt: number } | undefined;
  putNip05(identifier: string, pubkey: string | null, checkedAt: number): void;
  media(url: string): { status: "pass" | "fail"; httpStatus: number; contentType: string; checkedAt: number } | undefined;
  putMedia(url: string, status: "pass" | "fail", httpStatus: number, contentType: string, checkedAt: number): void;
  /** Urls last checked strictly before `olderThan`, oldest first, at most `limit`. */
  mediaDue(olderThan: number, limit: number): string[];
  close(): void;
}

const ITEM_KIND = 39999;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  d TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('live', 'deleted')),
  content_hash TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  latest_event_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_changed INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT NOT NULL,
  d TEXT NOT NULL,
  kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  relay TEXT NOT NULL,
  ok INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (event_id, relay)
);
CREATE INDEX IF NOT EXISTS events_d ON events (d);
CREATE TABLE IF NOT EXISTS cursors (
  name TEXT PRIMARY KEY CHECK (name IN ('videos', 'deletions', 'last_sweep')),
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  address TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('native', 'vine', 'user-submitted')),
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted', 'vanished')),
  skip_reason TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_event_id ON sources (event_id);
CREATE TABLE IF NOT EXISTS profiles (
  pubkey TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nip05 (
  identifier TEXT PRIMARY KEY,
  pubkey TEXT,
  checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  url TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail')),
  http_status INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_checked_at ON media (checked_at, url);
`;

interface SourceDbRow {
  address: string;
  eventId: string;
  createdAt: number;
  json: string;
  class: SourceClass;
  status: SourceStatus;
  skipReason: string | null;
  lastSeen: number;
}

const SOURCE_COLUMNS = `address, event_id AS eventId, created_at AS createdAt, json, class, status,
  skip_reason AS skipReason, last_seen AS lastSeen`;

function toSourceRow({ json, ...rest }: SourceDbRow): SourceRow {
  return { ...rest, event: JSON.parse(json) as NostrEvent };
}

/** The address of a replaceable source event: `<pubkey>:<d>`. */
function addressOf(ev: NostrEvent): string {
  const d = ev.tags.find((t) => t[0] === "d")?.[1] ?? "";
  return `${ev.pubkey}:${d}`;
}

/**
 * Opens (creating if needed) the state at `path`; ":memory:" is allowed.
 * For a file path the parent directory is created and WAL is enabled.
 * Timestamps are unix seconds.
 */
export function openState(path: string): State {
  const inMemory = path === ":memory:";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    if (!inMemory) db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
  } catch (err) {
    db.close();
    throw err;
  }

  const selectLive = db.prepare(
    `SELECT d, content_hash AS contentHash, tags_json AS tagsJson, latest_event_id AS latestEventId, address
       FROM items WHERE status = 'live' ORDER BY d`,
  );
  const selectCounts = db.prepare(
    "SELECT COALESCE(SUM(status = 'live'), 0) AS live, COALESCE(SUM(status = 'deleted'), 0) AS deleted FROM items",
  );
  const selectDeleted = db.prepare("SELECT d FROM items WHERE status = 'deleted' ORDER BY d");
  const selectVersions = db.prepare(
    `SELECT event_id AS eventId FROM events
      WHERE d = ? AND kind = ${ITEM_KIND}
      GROUP BY event_id ORDER BY MIN(created_at), event_id`,
  );
  const selectAccepted = db.prepare(
    "SELECT 1 FROM events WHERE event_id = ? AND relay = ? AND ok = 1",
  );
  const selectAcceptedAnywhere = db.prepare("SELECT 1 FROM events WHERE event_id = ? AND ok = 1 LIMIT 1");
  const upsertEvent = db.prepare(
    `INSERT INTO events (event_id, d, kind, created_at, run_id, relay, ok, message)
     VALUES (@eventId, @d, @kind, @createdAt, @runId, @relay, @ok, @message)
     ON CONFLICT (event_id, relay) DO UPDATE SET
       ok = excluded.ok, message = excluded.message, run_id = excluded.run_id`,
  );
  const upsertLive = db.prepare(
    `INSERT INTO items (d, address, status, content_hash, tags_json, latest_event_id, first_seen, last_changed)
     VALUES (@d, @address, 'live', @contentHash, @tagsJson, @eventId, @at, @at)
     ON CONFLICT (d) DO UPDATE SET
       address = excluded.address,
       status = 'live',
       content_hash = excluded.content_hash,
       tags_json = excluded.tags_json,
       latest_event_id = excluded.latest_event_id,
       last_changed = excluded.last_changed`,
  );
  const updateDeleted = db.prepare(
    "UPDATE items SET status = 'deleted', last_changed = ? WHERE d = ?",
  );
  const selectLastChanged = db.prepare("SELECT last_changed AS lastChanged FROM items WHERE d = ?");
  const selectRuns = db.prepare(
    `SELECT run_id AS runId, relay, SUM(ok = 1) AS ok, SUM(ok = 0) AS failed
       FROM events GROUP BY run_id, relay ORDER BY run_id, relay`,
  );

  const selectSourceTally = db.prepare(
    `SELECT class, status, skip_reason AS skipReason, COUNT(*) AS count
       FROM sources GROUP BY class, status, skip_reason ORDER BY class, status, skip_reason`,
  );

  const selectCursor = db.prepare("SELECT value FROM cursors WHERE name = ?");
  const upsertCursor = db.prepare(
    "INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
  );

  const selectSourceHead = db.prepare(
    "SELECT event_id AS eventId, created_at AS createdAt, status FROM sources WHERE address = ?",
  );
  const insertSource = db.prepare(
    `INSERT INTO sources (address, event_id, created_at, json, class, status, skip_reason, first_seen, last_seen)
     VALUES (@address, @eventId, @createdAt, @json, @class, 'active', @skipReason, @seenAt, @seenAt)`,
  );
  const replaceSource = db.prepare(
    `UPDATE sources SET event_id = @eventId, created_at = @createdAt, json = @json, class = @class,
       status = 'active', skip_reason = @skipReason, last_seen = @seenAt
     WHERE address = @address`,
  );
  const refreshSource = db.prepare(
    `UPDATE sources SET class = @class, skip_reason = @skipReason, last_seen = @seenAt,
       status = CASE WHEN status = 'vanished' THEN 'active' ELSE status END
     WHERE address = @address`,
  );
  const updateSourceStatus = db.prepare("UPDATE sources SET status = ? WHERE address = ?");
  const selectSource = db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE address = ?`);
  const selectSourceByEventId = db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE event_id = ?`);
  const touchSource = db.prepare(
    `UPDATE sources SET last_seen = ?, status = CASE WHEN status = 'vanished' THEN 'active' ELSE status END
     WHERE address = ?`,
  );

  const selectProfile = db.prepare(
    "SELECT json, created_at AS createdAt, fetched_at AS fetchedAt FROM profiles WHERE pubkey = ?",
  );
  const upsertProfile = db.prepare(
    `INSERT INTO profiles (pubkey, json, created_at, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (pubkey) DO UPDATE SET json = excluded.json, created_at = excluded.created_at, fetched_at = excluded.fetched_at`,
  );
  const selectNip05 = db.prepare("SELECT pubkey, checked_at AS checkedAt FROM nip05 WHERE identifier = ?");
  const upsertNip05 = db.prepare(
    `INSERT INTO nip05 (identifier, pubkey, checked_at) VALUES (?, ?, ?)
     ON CONFLICT (identifier) DO UPDATE SET pubkey = excluded.pubkey, checked_at = excluded.checked_at`,
  );
  const selectMedia = db.prepare(
    "SELECT status, http_status AS httpStatus, content_type AS contentType, checked_at AS checkedAt FROM media WHERE url = ?",
  );
  const upsertMedia = db.prepare(
    `INSERT INTO media (url, status, http_status, content_type, checked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (url) DO UPDATE SET status = excluded.status, http_status = excluded.http_status,
       content_type = excluded.content_type, checked_at = excluded.checked_at`,
  );
  const selectMediaDue = db.prepare(
    "SELECT url FROM media WHERE checked_at < ? ORDER BY checked_at, url LIMIT ?",
  );

  const upsertSourceTx = db.transaction(
    (ev: NostrEvent, cls: SourceClass, skipReason: string | null, seenAt: number) => {
      const address = addressOf(ev);
      const args = { address, eventId: ev.id, createdAt: ev.created_at, json: JSON.stringify(ev), class: cls, skipReason, seenAt };
      const head = selectSourceHead.get(address) as { eventId: string; createdAt: number } | undefined;
      if (!head) {
        insertSource.run(args);
        return "new" as const;
      }
      if (head.eventId === ev.id) {
        refreshSource.run(args);
        return "same" as const;
      }
      const incomingWins = ev.created_at > head.createdAt || (ev.created_at === head.createdAt && ev.id < head.eventId);
      if (!incomingWins) return "older" as const;
      replaceSource.run(args);
      return "updated" as const;
    },
  );
  const touchSourcesTx = db.transaction((addresses: string[], seenAt: number) => {
    for (const address of addresses) touchSource.run(seenAt, address);
  });

  return {
    liveItems() {
      const items = new Map<string, LiveItem>();
      for (const row of selectLive.all() as LiveItem[]) items.set(row.d, row);
      return items;
    },
    counts() {
      return selectCounts.get() as { live: number; deleted: number };
    },
    deletedItems() {
      return (selectDeleted.all() as { d: string }[]).map((row) => row.d);
    },
    versionsOf(d) {
      return (selectVersions.all(d) as { eventId: string }[]).map((row) => row.eventId);
    },
    acceptedOn(eventId, relay) {
      return selectAccepted.get(eventId, relay) !== undefined;
    },
    acceptedAnywhere(eventId) {
      return selectAcceptedAnywhere.get(eventId) !== undefined;
    },
    recordResult(r) {
      upsertEvent.run({ ...r, ok: r.ok ? 1 : 0 });
    },
    markLive(d, contentHash, tagsJson, eventId, at, address) {
      upsertLive.run({ d, contentHash, tagsJson, eventId, at, address });
    },
    markDeleted(d, at) {
      updateDeleted.run(at, d);
    },
    lastChanged(d) {
      return (selectLastChanged.get(d) as { lastChanged: number } | undefined)?.lastChanged;
    },
    runs() {
      return selectRuns.all() as { runId: string; relay: string; ok: number; failed: number }[];
    },

    cursor(name) {
      return (selectCursor.get(name) as { value: number } | undefined)?.value;
    },
    setCursor(name, value) {
      upsertCursor.run(name, value);
    },

    upsertSource(ev, cls, skipReason, seenAt) {
      return upsertSourceTx(ev, cls, skipReason, seenAt);
    },
    setSourceStatus(address, status, _at) {
      updateSourceStatus.run(status, address);
    },
    source(address) {
      const row = selectSource.get(address) as SourceDbRow | undefined;
      return row ? toSourceRow(row) : undefined;
    },
    sourceByEventId(eventId) {
      const row = selectSourceByEventId.get(eventId) as SourceDbRow | undefined;
      return row ? toSourceRow(row) : undefined;
    },
    sources(filter = {}) {
      const where: string[] = [];
      const params: string[] = [];
      if (filter.status) {
        where.push("status = ?");
        params.push(filter.status);
      }
      if (filter.class) {
        where.push("class = ?");
        params.push(filter.class);
      }
      if (filter.eligibleOnly) where.push("skip_reason IS NULL");
      const sql = `SELECT ${SOURCE_COLUMNS} FROM sources${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY address`;
      return (db.prepare(sql).all(...params) as SourceDbRow[]).map(toSourceRow);
    },
    touchSources(addresses, seenAt) {
      touchSourcesTx(addresses, seenAt);
    },
    sourceAddresses(filter = {}) {
      const where: string[] = [];
      const params: string[] = [];
      if (filter.status) {
        where.push("status = ?");
        params.push(filter.status);
      }
      if (filter.class) {
        where.push("class = ?");
        params.push(filter.class);
      }
      const sql = `SELECT address FROM sources${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY address`;
      return (db.prepare(sql).all(...params) as { address: string }[]).map((row) => row.address);
    },
    sourceTally() {
      return selectSourceTally.all() as { class: SourceClass; status: SourceStatus; skipReason: string | null; count: number }[];
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    profile(pubkey) {
      const row = selectProfile.get(pubkey) as { json: string; createdAt: number; fetchedAt: number } | undefined;
      return row && { content: JSON.parse(row.json) as Record<string, unknown>, createdAt: row.createdAt, fetchedAt: row.fetchedAt };
    },
    putProfile(pubkey, content, createdAt, fetchedAt) {
      upsertProfile.run(pubkey, JSON.stringify(content), createdAt, fetchedAt);
    },
    nip05(identifier) {
      return selectNip05.get(identifier) as { pubkey: string | null; checkedAt: number } | undefined;
    },
    putNip05(identifier, pubkey, checkedAt) {
      upsertNip05.run(identifier, pubkey, checkedAt);
    },
    media(url) {
      return selectMedia.get(url) as
        | { status: "pass" | "fail"; httpStatus: number; contentType: string; checkedAt: number }
        | undefined;
    },
    putMedia(url, status, httpStatus, contentType, checkedAt) {
      upsertMedia.run(url, status, httpStatus, contentType, checkedAt);
    },
    mediaDue(olderThan, limit) {
      return (selectMediaDue.all(olderThan, limit) as { url: string }[]).map((row) => row.url);
    },
    close() {
      db.close();
    },
  };
}
