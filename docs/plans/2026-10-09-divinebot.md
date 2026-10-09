# divinebot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI pipeline that keeps the live `divine-videos` DList filled with one kind 39999 item per eligible native Divine video, signed by the divinebot curator, on dcosl and the search relay, with daily incremental sync, deletions, media checks and guarded automatic runs.

**Architecture:** Read steps (`sync`, `sweep`, `media`, `profiles`) fill SQLite state from Divine's relay, media host and `.well-known` endpoints. `build` (pure apart from one header read) turns state into `out/<run>/unsigned.jsonl` and `report.md`. `sign` (the only step that loads the key besides `profile:publish`) writes `signed.jsonl`; `publish` sends it and records every event id per relay; `verify` reads back. `run` chains them, stopping after `build` unless `--auto` and every guard passes.

**Tech Stack:** Node 22+ (ESM), TypeScript via `tsx`, `vitest`, `nostr-tools@2.25.2`, `better-sqlite3`, `ws`, `nak serve` for integration tests.

**Spec:** `docs/specs/2026-10-09-divinebot-design.md`. Model code: `~/Documents/Tapestry/mise-en-place` (`src/`, `tests/`), referred to below as **mise**.

## Global Constraints

- **Header coordinate:** `39998:b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450:divine-videos`. Only in `config.json`.
- **Curator pubkey:** `6b279fb268a564ef74f35533f58a165fd4846b9c5595ac0bfc38cab37fda559d`. Only in `config.json`; used only to check the loaded key and to build deletion `a` tags.
- **Template ids:** `divine-video` = `97d7f683f8cfea346e389042430e1795fc6ddae25ee9dff298c95867d707b7ee`, `divine-profile` = `f07980288c1036e748bf80070b07cc2780a295b3ee15dd8b306dfea87abafd20`. Only in `config.json`.
- **Relays:** targets `dcosl` = `wss://dcosl.brainstorm.world`, `search` = `wss://search.brainstorm.world` (reads send `search: "include:spam"`); source `wss://relay.divine.video`; media `https://media.divine.video`.
- **Kinds signed:** 39999 items and 5 deletions by `sign`; 0 only by `profile:publish`. Never 39998 or 9999.
- **Source kind:** 34236 only.
- **Item `d`:** `divine-<pubkey>-<divine d>`. **Item tags:** the order in spec § 5; exactly one `z`; empty values omitted.
- **Key file:** `~/.config/divine-videos/curator.key`, override `DIVINEBOT_KEY_FILE`; mode must deny group and others. Passphrase file for `--auto` with an `ncryptsec`: `DIVINEBOT_PASSPHRASE_FILE`, same mode rule. The key or passphrase never appears in output, errors or arguments.
- **Config path:** `config.json`, override `DIVINEBOT_CONFIG`.
- **Politeness:** source pages ≤ 5000 events, ≥ 1000 ms apart, one connection at a time; media ≤ 5 requests/s; NIP-05 5 s timeout, no redirects followed, body ≤ 64 KB.
- **Guard defaults:** new+changed ≤ 2000; deletions ≤ max(25, 2% of live items); vanished ≤ 5% of live items; media failures > 20% of checks in a run stops the run and records none as failed.
- **Copy:** user-facing messages in plain sentences; no em dashes.

## Review Focus

1. **A 1.1 GB first harvest.** A native event averages 22 KB; holding the harvest in memory or storing events whole would exhaust memory or bloat state. Expect page-by-page streaming into SQLite and stored events slimmed of `proofmode`, `device_attestation`, `c2pa_manifest_id` tags. Test in Task 4 and Task 5.
2. **The source drops the connection mid-harvest or mid-sync.** Expect no cursor movement until a window is fully read, and the next run to fill the gap. Test in Task 6.
3. **Hostile or odd NIP-05 servers** (redirects, huge bodies, slow answers, wrong case in names). Expect a failed verification, never a hang or a crash. Test in Task 8.
4. **Messy creator text:** whitespace-only titles, multi-line captions, fancy Unicode names, very long Vine-style titles. Expect titles trimmed to their first non-empty line, Unicode kept verbatim, nothing empty written. Test in Task 9.
5. **A media outage** (Fastly 5xx or timeouts for every check). Expect nothing recorded as failed and no deletions. Test in Task 7 and Task 11.

---

### Task 1: Scaffold, config and fixtures

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts` (copy mise's `tsconfig.json` and `vitest.config.ts` unchanged)
- Create: `config.json`, `config.rehearsal.example.json`, `src/config.ts`
- Create: `tests/fixtures/native.jsonl`, `tests/fixtures/vine.jsonl`, `tests/fixtures/deletions.jsonl` (copy from `/private/tmp/claude-501/-Users-avinashburra-Documents-Tapestry/59ab446f-31c9-481a-a3c1-efba2e8075f9/scratchpad/divine/`: `samples-34236.jsonl`, the first 50 lines of `page-vine-6000req.jsonl`, `samples-5.jsonl`)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `interface Config` with exactly these fields, and `loadConfig(path?: string): Config`, `relayUrl(cfg, name): string`, `readSearch(cfg, name): string | undefined` (same contracts as mise's).

```ts
interface Config {
  headerCoordinate: string; curatorPubkey: string;
  templateIds: { "divine-video": string; "divine-profile": string };
  relays: Record<string, string>; headerRelay: string; relayReadSearch?: Record<string, string>;
  source: { relay: string; pageSize: number; pageDelayMs: number; harvestSince: number; overlapSeconds: number; readTimeoutMs: number };
  media: { base: string; requestsPerSecond: number; recheckDays: number; timeoutMs: number };
  profiles: { batchSize: number; refreshDays: number; nip05TtlDays: number; nip05TimeoutMs: number };
  profileRelays: string[];
  scope: { includeVines: boolean };
  publish: { eventsPerSecond: number; okTimeoutMs: number };
  guards: { maxNewOrChanged: number; maxDeletionsFloor: number; maxDeletionsFraction: number; maxVanishedFraction: number; maxMediaFailureFraction: number };
  pilotSize: number;
  paths: { out: string; state: string };
}
```

`config.json` values: the Global Constraints above, plus `source` `{ pageSize: 5000, pageDelayMs: 1000, harvestSince: 1735689600, overlapSeconds: 3600, readTimeoutMs: 30000 }`, `media` `{ requestsPerSecond: 5, recheckDays: 30, timeoutMs: 10000 }`, `profiles` `{ batchSize: 500, refreshDays: 7, nip05TtlDays: 7, nip05TimeoutMs: 5000 }`, `profileRelays` `["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://purplepag.es"]`, `scope.includeVines: false`, `publish` `{ eventsPerSecond: 5, okTimeoutMs: 10000 }`, the guard defaults, `pilotSize: 150`, `paths` `{ out: "out", state: "state/state.sqlite" }`.

`package.json`: `"type": "module"`, `"engines": { "node": ">=22" }`, deps `nostr-tools` `2.25.2`, `better-sqlite3`, `ws`; dev deps as mise plus `@types/ws`; scripts `sync`, `sweep`, `media`, `profiles`, `build`, `sign`, `publish`, `verify`, `rebroadcast`, `profile:publish`, `run`, `status` (each `tsx src/cli.ts <name>`), `test`, `typecheck`.

- [ ] **Step 1: Write failing tests** in `tests/config.test.ts`: `loadConfig()` reads `config.json` and returns `templateIds["divine-video"] === "97d7f683…b7ee"` (full id); a config missing `guards.maxNewOrChanged` throws an error naming the file and `guards.maxNewOrChanged`; a `templateIds` value that is not 64 hex throws; `source.relay` that is not `ws(s)://` throws; `DIVINEBOT_CONFIG` overrides the path.
- [ ] **Step 2: Run** `npx vitest run tests/config.test.ts`. Expected: FAIL (no `src/config.ts`).
- [ ] **Step 3: Implement** `src/config.ts` following mise's validator style (every field checked; errors name file and field).
- [ ] **Step 4: Run** `npm install && npx vitest run tests/config.test.ts && npx tsc --noEmit`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat: scaffold, config and Divine fixtures`.

### Task 2: Shared modules copied from mise

**Files:**
- Create (copy from mise, then adapt as listed): `src/key.ts`, `src/relay.ts`, `src/markdown.ts` (only `table`, `codeSpan`, `bullets`), `src/deletion.ts`, `src/diff.ts`, `src/manifest.ts`, `src/args.ts`, `tests/stub-relay.ts`, `tests/run-manifest.ts`, `tests/integration/nak.ts`
- Test: copy and adapt `tests/key.test.ts` (mise `tests/sign.test.ts` key cases), `tests/relay.test.ts`, `tests/diff.test.ts`, `tests/args.test.ts` (from mise `tests/cli.test.ts` arg cases)

**Adaptations:**
- `key.ts`: env var `DIVINEBOT_KEY_FILE`, default `~/.config/divine-videos/curator.key`; add `loadPassphraseFile(path: string): string` that applies the same mode check and never echoes content.
- `manifest.ts`: `configIdentity` covers `headerCoordinate`, `curatorPubkey`, `templateIds`, `relays`, `scope`.
- `args.ts`: options `--pilot [N]`, `--relays a,b`, `--auto`, `--first-run`; drop `--filter`, `--port`, `--allow-deletions`.
- `nak.ts`: temp dir prefix `divinebot-nak-`.

**Interfaces:**
- Produces (unchanged from mise unless noted): `loadKey(path, expectedPubkey, askPassphrase): Promise<Uint8Array>`, `defaultKeyPath()`, `promptPassphrase()`, `loadPassphraseFile(path): string`; `connectRelay`, `query`, `queryPaged`, `queryAll`, `publishEvent`, `withSearch`, `newer`; `deletionFor(d, versionIds, curatorPubkey): Unsigned`; `contentHash(tags)`, `diffItems`, `changedFields`, `summarizeChanges`; `configIdentity`, `checkRunConfig`, `manifestRelays`; `parseArgs(argv): CliArgs` with `{ positional, pilot?, relays?, auto?: true, firstRun?: true }`; `startStubRelay`; `startNak(port)`; `type Tags = string[][]` and `tagValue(tags, name)` exported from `src/tags.ts` (move them out of mise's `item.ts`).

- [ ] **Step 1: Copy the files and tests**, apply the adaptations, and add to `tests/key.test.ts`: `loadPassphraseFile` refuses a mode 644 file with an error that does not contain the file's content.
- [ ] **Step 2: Run** `npx vitest run tests/key.test.ts tests/relay.test.ts tests/diff.test.ts tests/args.test.ts`. Expected: the new passphrase test FAILS, copied tests pass once imports are fixed.
- [ ] **Step 3: Implement** `loadPassphraseFile`.
- [ ] **Step 4: Run** the same command plus `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: key, relay, diff, deletion and manifest modules from mise-en-place`.

### Task 3: State

**Files:**
- Create: `src/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Consumes: `Tags` (Task 2).
- Produces: `openState(path: string): State` (`":memory:"` allowed; WAL for files). `State` keeps mise's ledger methods with the same contracts: `liveItems(): Map<string, LiveItem>`, `counts()`, `deletedItems()`, `versionsOf(d)`, `acceptedOn`, `acceptedAnywhere`, `recordResult`, `markLive(d, contentHash, tagsJson, eventId, at)`, `markDeleted(d, at)`, `lastChanged(d)`, `runs()`, `close()`. `LiveItem` gains `address: string`; `markLive` gains a final `address` parameter. New:

```ts
type SourceClass = "native" | "vine" | "user-submitted";
type SourceStatus = "active" | "deleted" | "vanished";
interface SourceRow { address: string; eventId: string; createdAt: number; event: NostrEvent; class: SourceClass; status: SourceStatus; skipReason: string | null; lastSeen: number }
cursor(name: "videos" | "deletions" | "last_sweep"): number | undefined
setCursor(name, value: number): void
upsertSource(ev: NostrEvent, cls: SourceClass, skipReason: string | null, seenAt: number): "new" | "updated" | "same" | "older"
setSourceStatus(address: string, status: SourceStatus, at: number): void
source(address: string): SourceRow | undefined
sources(filter?: { status?: SourceStatus; class?: SourceClass; eligibleOnly?: boolean }): SourceRow[]
touchSources(addresses: string[], seenAt: number): void
profile(pubkey: string): { content: Record<string, unknown>; createdAt: number; fetchedAt: number } | undefined
putProfile(pubkey: string, content: Record<string, unknown>, createdAt: number, fetchedAt: number): void
nip05(identifier: string): { pubkey: string | null; checkedAt: number } | undefined
putNip05(identifier: string, pubkey: string | null, checkedAt: number): void
media(url: string): { status: "pass" | "fail"; httpStatus: number; contentType: string; checkedAt: number } | undefined
putMedia(url: string, status: "pass" | "fail", httpStatus: number, contentType: string, checkedAt: number): void
mediaDue(olderThan: number, limit: number): string[]
```

`address` is `<pubkey>:<d>`. `upsertSource` keeps the newer `created_at` (ties: lower id, as NIP-01 replaceable rules) and returns `"older"` without writing when the stored one is newer. `eligibleOnly` means `skipReason IS NULL`.

- [ ] **Step 1: Write failing tests:** upsert of a newer version returns `"updated"` and replaces the event; an older version returns `"older"` and changes nothing; equal `created_at` keeps the lower id; `sources({ status: "active", eligibleOnly: true })` excludes skipped rows; cursors round-trip; `mediaDue(now - 30*86400, 10)` returns only items checked before that time, oldest first; mise's ledger tests (copy `tests/state.test.ts` from mise) pass with the `address` parameter added.
- [ ] **Step 2: Run** `npx vitest run tests/state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema in spec § 6.3 and the methods; events are stored as JSON text.
- [ ] **Step 4: Run** `npx vitest run tests/state.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: state for sources, cursors, profiles, NIP-05 and media`.

### Task 4: Source relay client

**Files:**
- Create: `src/source/divine-relay.ts`
- Test: `tests/divine-relay.test.ts`

**Interfaces:**
- Consumes: `startStubRelay` (Task 2) in tests.
- Produces:

```ts
interface PageOptions { pageSize: number; pageDelayMs: number; readTimeoutMs: number; sleep?: (ms: number) => Promise<void> }
interface StreamResult { pages: number; events: number; rejected: number; stalledAt?: number }
streamEvents(url: string, filter: Filter, opts: PageOptions,
  onPage: (events: NostrEvent[]) => void | Promise<void>): Promise<StreamResult>
```

Pages back with `until` = oldest `created_at` seen (inclusive), deduplicates ids across pages, stops on the first page with nothing new (`stalledAt` set when that page was full, as mise's `queryPaged`). Each page is handed to `onPage` before the next is requested, and is not retained afterwards. Events failing `verifyEvent` are dropped and counted in `rejected`. Waits `pageDelayMs` between pages via `sleep`. A `CLOSED` or a socket error rejects the promise with a message naming the relay; it never resolves with partial results.

- [ ] **Step 1: Write failing tests** with a stub relay serving 12 events where 4 share one `created_at` across a page boundary at `pageSize: 5`: all 12 are delivered exactly once over the pages; `onPage` is called once per non-empty page; a fixture event with one changed tag (bad signature) is counted in `rejected` and never delivered; `sleep` is called with 1000 between pages; a stub that sends `CLOSED` makes `streamEvents` reject; a stub that drops the socket after the first page makes it reject after `onPage` ran once.
- [ ] **Step 2: Run** `npx vitest run tests/divine-relay.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** on `ws` directly (not nostr-tools' relay class), one `REQ` per page on one connection.
- [ ] **Step 4: Run** `npx vitest run tests/divine-relay.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: paging client for the Divine relay`.

### Task 5: Classification and eligibility

**Files:**
- Create: `src/source/classify.ts`
- Test: `tests/classify.test.ts`

**Interfaces:**
- Produces:

```ts
type SkipReason = "classic-vine" | "user-submitted" | "no-imeta" | "bad-sha256" | "not-mp4" | "no-title" | "content-warning" | "expiration";
classOf(ev: NostrEvent): SourceClass
imeta(ev: NostrEvent): Record<string, string> | undefined   // first imeta tag, "key value" entries
titleOf(ev: NostrEvent): string | undefined                  // title, else first non-empty summary line; trimmed
skipReason(ev: NostrEvent, scope: Config["scope"]): SkipReason | null   // spec § 4 rules 2–6, in order
slim(ev: NostrEvent): NostrEvent                              // drops proofmode, device_attestation, c2pa_manifest_id tags
```

Rule 2 yields `"classic-vine"` or `"user-submitted"` only when `scope.includeVines` is false. `slim` runs after the signature check (Task 4), so stored events are not re-verifiable; state records that they were verified on read.

- [ ] **Step 1: Write failing tests** over the fixtures: all 50 native fixtures classify `"native"`; all 50 Vine fixtures classify `"vine"` and skip as `"classic-vine"`; an event with `["l","user-submitted",…]` skips `"user-submitted"`; removing `imeta` gives `"no-imeta"`; `x` of 63 chars gives `"bad-sha256"`; `m video/webm` gives `"not-mp4"`; whitespace-only `title` and empty `summary` gives `"no-title"`; `title` empty with summary `"\n  first line \nsecond"` gives title `"first line"`; `["content-warning","nudity"]` gives `"content-warning"`; `["L","content-warning"],["l","nudity","content-warning"]` gives `"content-warning"`; `["expiration","1794237864"]` gives `"expiration"`; `slim` of the first native fixture is under 3 KB and keeps every other tag in order.
- [ ] **Step 2: Run** `npx vitest run tests/classify.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/source/classify.ts`.
- [ ] **Step 4: Run** `npx vitest run tests/classify.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: classify Divine events and apply the scope rules`.

### Task 6: Sync and sweep

**Files:**
- Create: `src/source/sync.ts`, `src/source/sweep.ts`
- Test: `tests/sync.test.ts`

**Interfaces:**
- Consumes: `streamEvents` (Task 4), `classOf`, `skipReason`, `slim` (Task 5), `State` (Task 3).
- Produces:

```ts
interface SyncResult { videos: { new: number; updated: number; same: number; older: number; rejected: number }; deletions: { applied: number; ignored: number }; firstHarvest: boolean }
sync(cfg: Config, state: State, opts?: { now?: () => number; stream?: typeof streamEvents }): Promise<SyncResult>
interface SweepResult { seen: number; vanished: string[] }
sweep(cfg: Config, state: State, opts?: { now?: () => number; stream?: typeof streamEvents }): Promise<SweepResult>
```

`sync` reads kind 34236 since `cursor("videos") - overlapSeconds` (or `source.harvestSince` when there is no cursor: `firstHarvest: true`), then kind 5 with `#k: ["34236"]` since `cursor("deletions") - overlapSeconds` (or `harvestSince`). Each page is classified, slimmed and upserted inside one SQLite transaction. A deletion is applied only when its `pubkey` equals the stored source's pubkey and it names the source by an `e` equal to the stored event id or an `a` equal to `34236:<pubkey>:<d>` (state keeps only the newest version; Divine's deletions carry both tags); it sets status `deleted`. Each cursor is set to the newest `created_at` read, **only after** its stream resolves. `sweep` streams the whole native window (`since: harvestSince`), touches every address seen, and marks `vanished` every active native source not seen; it sets `last_sweep` only on success.

- [ ] **Step 1: Write failing tests** with an injected `stream` replaying fixtures: first sync stores 50 native and 0 Vine as eligible, sets `firstHarvest`, and sets both cursors; a second sync asks for `since` = cursor − 3600; a kind 5 by the video's author removes it (status `deleted`); a kind 5 naming the same `a` but signed by another pubkey is `ignored`; a stream that rejects after one page leaves both cursors unchanged and the next sync re-reads from the old cursor; a newer edit of a video replaces the stored event; sweep with 49 of 50 present marks exactly the missing one `vanished`; a sweep that rejects marks nothing vanished.
- [ ] **Step 2: Run** `npx vitest run tests/sync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `sync.ts` and `sweep.ts`.
- [ ] **Step 4: Run** `npx vitest run tests/sync.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: incremental sync, author deletions and weekly sweep`.

### Task 7: Media checks

**Files:**
- Create: `src/media.ts`
- Test: `tests/media.test.ts`

**Interfaces:**
- Consumes: `State` (Task 3), `imeta` (Task 5).
- Produces:

```ts
type MediaVerdict = { url: string; status: "pass" | "fail" | "inconclusive"; httpStatus: number; contentType: string };
videoUrl(sha256: string, base: string): string        // `${base}/${sha256}.mp4`
checkUrl(url: string, kind: "video" | "image", opts: { timeoutMs: number; fetch?: typeof fetch }): Promise<MediaVerdict>
interface MediaRunResult { checked: number; passed: number; failed: number; inconclusive: number; outage: boolean }
runMediaChecks(cfg: Config, state: State, opts?: { now?: () => number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<MediaRunResult>
```

`checkUrl` sends `HEAD`. Pass: 200 and content type `video/mp4` (video) or starting `image/` (image). Fail: 401, 403, 404, 410, or 200 with the wrong type. Inconclusive: timeout, network error, 5xx, anything else. `runMediaChecks` checks every eligible active source's video and thumbnail with no media row, then `mediaDue(now - recheckDays*86400, ceil(liveCount / recheckDays))`, at `requestsPerSecond`. Inconclusive results are not stored. When `failed / checked > guards.maxMediaFailureFraction` (with `checked >= 20`), it stores **no** failures from this run, sets `outage: true`, and still stores passes.

- [ ] **Step 1: Write failing tests** with an injected `fetch`: 200 `video/mp4` passes; 200 `text/html` fails; 401 fails; 503 and a thrown `AbortError` are inconclusive and leave no row; 25 checks where all fail set `outage` and store no `fail` rows; 25 checks with 2 failures store those 2; pacing calls `sleep` so that 5 requests per second is not exceeded; `videoUrl("ad9c…6553", "https://media.divine.video")` returns the `.mp4` URL from `header/example-items.json`.
- [ ] **Step 2: Run** `npx vitest run tests/media.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/media.ts` with `AbortSignal.timeout`.
- [ ] **Step 4: Run** `npx vitest run tests/media.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: media checks with outage protection`.

### Task 8: Profiles and NIP-05

**Files:**
- Create: `src/profiles.ts`
- Test: `tests/profiles.test.ts`

**Interfaces:**
- Consumes: `streamEvents` (Task 4), `State` (Task 3).
- Produces:

```ts
creatorName(content: Record<string, unknown> | undefined): string | undefined   // display_name, else name; trimmed; non-empty
lookupNip05(identifier: string, opts: { timeoutMs: number; fetch?: typeof fetch }): Promise<string | null>   // pubkey or null
verifiedNip05(pubkey: string, content: Record<string, unknown> | undefined, state: State, cfg: Config,
  opts?: { now?: () => number; fetch?: typeof fetch }): Promise<string | undefined>   // the value to write, or undefined
refreshProfiles(cfg: Config, state: State, opts?: { now?: () => number; stream?: typeof streamEvents; fetch?: typeof fetch }): Promise<{ fetched: number; verified: number }>
```

`lookupNip05("name@domain")` requests `https://domain/.well-known/nostr.json?name=name` with `redirect: "manual"`, the timeout, and reads at most 64 KB; it returns `names[name]` (exact key, lowercased local part per NIP-05) only if it is 64 hex, else null; any error returns null. `verifiedNip05` uses cached results younger than `nip05TtlDays`. For `_@<u>.divine.video` it returns `<u>@divine.video` when both `_@<u>.divine.video` and `<u>@divine.video` resolve to `pubkey`; otherwise the original identifier when it resolves to `pubkey`; otherwise undefined. `refreshProfiles` fetches kind 0 for creators of eligible active sources whose profile is missing or older than `refreshDays`, in batches of `batchSize` authors, keeping the newest per author.

- [ ] **Step 1: Write failing tests:** `creatorName({ display_name: "  ", name: "julia" })` is `"julia"`; `creatorName({ display_name: "𝖎𝖒𝖗𝖉𝖆𝖛𝖎𝖎𝖘 💀" })` keeps it verbatim; `verifiedNip05` with `_@imrdaviis.divine.video` and both lookups returning `03c49dd3…eb50` returns `"imrdaviis@divine.video"`; with only the subdomain lookup matching it returns `"_@imrdaviis.divine.video"`; a 301 response, a 1 MB body, a 6 s delay (fake timers), and a mismatched pubkey each give undefined; a cached result within 7 days makes no request; `refreshProfiles` sends author batches of at most 500.
- [ ] **Step 2: Run** `npx vitest run tests/profiles.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/profiles.ts`.
- [ ] **Step 4: Run** `npx vitest run tests/profiles.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: creator profiles and verified NIP-05 handles`.

### Task 9: Item builder

**Files:**
- Create: `src/item.ts`
- Test: `tests/item.test.ts`

**Interfaces:**
- Consumes: `imeta`, `titleOf`, `classOf` (Task 5), `videoUrl` (Task 7), `Tags` (Task 2).
- Produces:

```ts
interface ItemContext { headerCoordinate: string; mediaBase: string; creator?: string; nip05?: string }
itemD(ev: NostrEvent): string                     // `divine-${pubkey}-${d}`
buildItem(ev: NostrEvent, ctx: ItemContext): Tags // spec § 5, in order
```

`creator` for a native event is `ctx.creator`; for a Vine it is the event's `author` tag. Vine-only fields (`vine-creator-id`, `vine-loops`, `vine-likes`, `platform: vine`) appear only for class `"vine"`.

- [ ] **Step 1: Write failing tests:** for each item in `header/example-items.json`, building from its source fixture (native `ae26388c…`, Vine `8e0d6495…`) with `creator` and `nip05` taken from that item gives tags deep-equal to the item; a missing `thumbnail` and missing `published_at` fall back as the spec says (thumbnail omitted; `published` from `created_at`); `description` is omitted when equal to the title; `t` is `["divine", …hashtags lowercased, deduped]`; a 400-character title is kept whole; no tag has an empty value; `alt` without a creator is `Divine video: <title>`.
- [ ] **Step 2: Run** `npx vitest run tests/item.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/item.ts`.
- [ ] **Step 4: Run** `npx vitest run tests/item.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: build Divine Videos items in the reviewed shape`.

### Task 10: Header check and rebroadcast

**Files:**
- Create: `src/header.ts`, `src/commands/rebroadcast.ts`
- Test: `tests/header.test.ts`

**Interfaces:**
- Consumes: `connectRelay`, `query`, `publishEvent` (Task 2).
- Produces: `fetchHeader(relayUrl, coordinate, timeoutMs?, search?): Promise<NostrEvent | null>` (as mise); `checkHeader(ev, cfg): asserts ev is NostrEvent`, which throws unless kind 39998, author and `d` match the coordinate, `required` is exactly `["title", "video"]` in order, and the `link` tags name `cfg.templateIds["divine-video"]` bound `id`→`divine-id` and `cfg.templateIds["divine-profile"]` bound `npub`→`creator-npub`; `rebroadcast(cfg, toRelay = "search"): Promise<{ eventId: string; ok: boolean; message: string }[]>`, which reads the header and both templates (by id) from `headerRelay` and publishes each unchanged to `toRelay`, refusing when `toRelay === headerRelay`.

- [ ] **Step 1: Write failing tests** using the live header's tags (copy `header/divine-videos.header.json` with the two ids filled in as a fixture): it passes `checkHeader`; swapping the `required` order throws naming both orders; a different template id throws naming the field; `rebroadcast` against two stub relays sends three events byte-identical to the ones read.
- [ ] **Step 2: Run** `npx vitest run tests/header.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** `npx vitest run tests/header.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: header check and rebroadcast of header and templates`.

### Task 11: Build, guards and pilot

**Files:**
- Create: `src/commands/build.ts`, `src/guards.ts`, `src/pilot.ts`, `src/report.ts`
- Test: `tests/build.test.ts`, `tests/guards.test.ts`, `tests/pilot.test.ts`

**Interfaces:**
- Consumes: `State` (Task 3), `SyncResult` (Task 6), `MediaRunResult` (Task 7), `buildItem`, `itemD` (Task 9), `creatorName`, `verifiedNip05` (Task 8), `videoUrl` (Task 7), `fetchHeader`, `checkHeader` (Task 10), `diffItems`, `contentHash`, `deletionFor`, `configIdentity` (Task 2).
- Produces:

```ts
interface GuardInput { liveItems: number; newOrChanged: number; deletions: number; vanished: number; media: MediaRunResult | null; sourceEmpty: boolean }
interface GuardBreach { guard: string; limit: number; actual: number; message: string }
checkGuards(cfg: Config, input: GuardInput): GuardBreach[]
selectPilot(candidates: { d: string; pubkey: string; published: string }[], n: number): string[]   // d values
interface BuildOptions { pilot?: number; firstRun?: boolean; runId?: string; header?: NostrEvent; media?: MediaRunResult | null; sync?: SyncResult | null; vanished?: number; now?: () => number; fetch?: typeof fetch }
interface BuildResult { runDir: string; created: number; changed: number; unchanged: number; deletions: number; skipped: Record<string, number>; breaches: GuardBreach[] }
runDirFor(cfg: Config, runId: string): string
build(cfg: Config, state: State, opts?: BuildOptions): Promise<BuildResult>
```

`build` reads and checks the header (unless injected), takes eligible active native sources whose video and thumbnail media rows are `pass`, builds items, diffs against `liveItems()`, and writes `unsigned.jsonl` (new and changed first, then kind 5 deletions for every live item whose address is no longer eligible, active and media-passing), `manifest.json` (mise's shape plus `breaches`) and `report.md` (counts, skips by reason, changed fields summary, guard results, 20 sample items). A pilot build writes no deletions. Without `--first-run`, a state with no items refuses to build. `selectPilot` sorts candidates by `d`, takes at most 2 per pubkey, and spreads picks round-robin across `published` months, deterministic for the same input. `build` fills `GuardInput` from its own counts plus `opts.media`, `opts.vanished` (from `sweep`, 0 when none ran) and `opts.sync`. `checkGuards` applies spec § 7.3 with `sourceEmpty` meaning `opts.sync` read zero videos while state holds active sources with `created_at` within the 7 days before `cursor("videos")`.

- [ ] **Step 1: Write failing tests:** guards: 2,001 new trips `maxNewOrChanged`; with 1,000 live items 26 deletions trip and 25 do not (floor), with 5,000 live 101 trip and 100 do not (2%); 251 vanished of 5,000 trips; `media.outage` trips; `sourceEmpty` trips. Pilot: 10 candidates from one pubkey yield 2; output is identical across calls; a 150 pick from 300 candidates across 6 months includes every month. Build (in-memory state seeded from fixtures with media passes and an injected header): first build with `firstRun` creates one item per eligible source with no deletions; a second build with no changes writes zero lines; marking one source `deleted` produces one kind 5 whose `e` tags equal `versionsOf(d)`; a failed thumbnail media row excludes that item; a pilot build never writes deletions; `report.md` lists skip reasons with counts.
- [ ] **Step 2: Run** `npx vitest run tests/build.test.ts tests/guards.test.ts tests/pilot.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the four files; the report uses `markdown.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: build runs with guards, pilot selection and report`.

### Task 12: Sign, publish and verify

**Files:**
- Create (copy from mise, adapt): `src/commands/sign.ts`, `src/commands/publish.ts`, `src/commands/verify.ts`, `src/earlier-runs.ts`
- Test: copy and adapt mise `tests/sign.test.ts`, `tests/publish.test.ts`, `tests/verify.test.ts`

**Adaptations:** imports from this repo's modules; `sign` reads the key via Task 2's `loadKey` with `DIVINEBOT_KEY_FILE` and accepts `askPassphrase` from `loadPassphraseFile` when given; `SIGNABLE_KINDS` stays `{39999, 5}`; `publish` passes `address` to `markLive` (taken from the item's `a` tag, `34236:<pubkey>:<d>` → `<pubkey>:<d>`); `verify` reads with `#z` and `authors: [curatorPubkey]`.

**Interfaces:** as mise: `sign(cfg, runDir, opts): Promise<{ signed: number; pubkey: string }>`, `publish(cfg, state, runDir, relayNames?, opts): Promise<Record<string, RelayPublishResult>>`, `verify(cfg, state, opts): Promise<Record<string, RelayVerifyResult>>`, `verifySummary(results)`, `earlierRunWarnings(cfg, state): string[]`.

- [ ] **Step 1: Copy tests and add:** signing a run whose `unsigned.jsonl` contains a kind 0 or kind 39998 is refused; after publish, `liveItems().get(d).address` equals the source address.
- [ ] **Step 2: Run** `npx vitest run tests/sign.test.ts tests/publish.test.ts tests/verify.test.ts`. Expected: FAIL until adapted.
- [ ] **Step 3: Copy and adapt** the four modules.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: sign, publish and verify from mise-en-place`.

### Task 13: Curator profile

**Files:**
- Create: `src/commands/profile-publish.ts`, `profile.example.json`
- Test: `tests/profile-publish.test.ts`

**Interfaces:**
- Consumes: `loadKey` (Task 2), `publishEvent` (Task 2).
- Produces: `profilePublish(cfg, profilePath: string, opts?: { keyPath?: string; askPassphrase?: () => Promise<string>; now?: () => number; fetchCurrent?: (relays: string[], pubkey: string) => Promise<NostrEvent | null> }): Promise<{ eventId: string; results: Record<string, { ok: boolean; message: string }> }>`.

Reads `profile.json` (gitignored; `profile.example.json` committed with placeholder copy Avi edits), requires `name`, `about` and `bot: true`, merges onto the newest existing kind 0 for the curator from `profileRelays` (fields not in `profile.json` are kept), signs kind 0 with the curator key (checked against `curatorPubkey`), publishes to every `profileRelays` entry, and prints per-relay results. Add `profile.json` to `.gitignore`.

- [ ] **Step 1: Write failing tests** with stub relays and a throwaway key: missing `bot: true` is refused; an existing kind 0 with `picture` keeps `picture` after merge; the published event is kind 0 by the curator pubkey; a key that does not match `curatorPubkey` is refused before anything is sent.
- [ ] **Step 2: Run** `npx vitest run tests/profile-publish.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the command.
- [ ] **Step 4: Run** `npx vitest run tests/profile-publish.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: publish the curator profile`.

### Task 14: Run, status and the CLI

**Files:**
- Create: `src/commands/run.ts`, `src/commands/status.ts`, `src/lock.ts`, `src/cli.ts`
- Test: `tests/run.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
withLock<T>(path: string, fn: () => Promise<T>): Promise<T>     // O_EXCL lock file; stale after 6 h with a warning
interface RunOutcome { runDir: string | null; stoppedForReview: boolean; breaches: GuardBreach[]; exitCode: 0 | 2 }
runPipeline(cfg: Config, state: State, opts: { auto: boolean; pilot?: number; firstRun?: boolean; deps?: Partial<PipelineDeps> }): Promise<RunOutcome>
status(cfg: Config, state: State): string
```

`runPipeline` holds `<paths.state>.lock` and runs `sync` → (`sweep` when `last_sweep` is older than 7 days) → `profiles` → `media` → `build`, passing the sync result, the sweep's vanished count and the media result into `build`. Manual: stops after `build` with exit 0 and prints the run dir and next commands. Auto: refuses `pilot` and `firstRun`; if `breaches` is non-empty or `earlierRunWarnings` is non-empty, writes `<runDir>/NEEDS_REVIEW` (the breach messages) and returns exit 2; otherwise signs (key from `DIVINEBOT_KEY_FILE`, passphrase from `DIVINEBOT_PASSPHRASE_FILE` when the key is an `ncryptsec`, refusing a TTY prompt), publishes to every relay and verifies. `PipelineDeps` lets tests inject `sync`, `sweep`, `refreshProfiles`, `runMediaChecks`, `build`, `sign`, `publish`, `verify`. `status` prints live and deleted counts, eligible sources by class, skips by reason, cursors as UTC times, the last run per relay, and any run dir holding `NEEDS_REVIEW`. `cli.ts` wires every script in `package.json`, using mise's `only`/`allowOptions` pattern, and exits with `RunOutcome.exitCode`.

- [ ] **Step 1: Write failing tests:** manual run calls build and never sign; auto run with a breach writes `NEEDS_REVIEW`, never calls sign, returns 2; auto run with no breaches calls sign, publish and verify in order; a second concurrent `runPipeline` fails with a message about the lock; auto with `pilot` is refused; `cli` rejects `build --auto` and `sync extra-arg`.
- [ ] **Step 2: Run** `npx vitest run tests/run.test.ts tests/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the four files.
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: run pipeline with review gates, status and CLI`.

### Task 15: End-to-end integration

**Files:**
- Create: `tests/integration/stub-divine.ts`, `tests/integration/pipeline.test.ts`

**Interfaces:**
- Consumes: `startNak` (Task 2), `runPipeline` (Task 14), `startStubRelay` (Task 2).
- Produces: `startStubDivine(events: NostrEvent[]): Promise<{ url: string; add(ev: NostrEvent): void; remove(id: string): void; close(): Promise<void> }>` honouring `kinds`, `authors`, `#k`, `#d`, `since`, `until`, `limit`; and a local HTTP media stub whose responses per URL the test sets.

- [ ] **Step 1: Write the scenario test** against `nak serve` (target relays `dcosl` and `search` both pointing at it), the Divine stub and the media stub, with a throwaway curator key and a test config: (a) first run with `firstRun` then manual sign and publish puts one item per eligible fixture on nak, and `verify` reports nothing missing; (b) an edited video republishes one item; (c) an author kind 5 deletes its item on nak; (d) a kind 5 from another key changes nothing; (e) removing a video from the stub and forcing a sweep deletes its item; (f) a media 404 on recheck deletes its item; (g) 30 author deletions at once in an auto run stops with exit 2 and `NEEDS_REVIEW`; (h) killing publish after 3 events and rerunning publishes the rest without resending.
- [ ] **Step 2: Run** `npx vitest run tests/integration/pipeline.test.ts`. Expected: FAIL on the first unmet scenario, then fix the owning module (not the test).
- [ ] **Step 3: Run** `npx vitest run`. Expected: all PASS.
- [ ] **Step 4: Commit** `test: end-to-end pipeline against nak serve`.

### Task 16: Scheduling, README and rehearsal

**Files:**
- Create: `scripts/launchd/run-divinebot.sh`, `scripts/launchd/world.brainstorm.divinebot.plist.example`, `README.md`
- Modify: `config.rehearsal.example.json` (target relays both `ws://127.0.0.1:10547`)

**Content:**
- `run-divinebot.sh`: `cd` to the repo, run `npm run run -- --auto`, append output to `state/logs/<date>.log`, and on a non-zero exit show a macOS notification with `osascript -e 'display notification "<message>" with title "divinebot"'` naming the run dir. No secrets in the script.
- The plist example runs the script daily at 06:00 local, with `StandardOutPath`/`StandardErrorPath` under `state/logs/`.
- `README.md`: what it does; attribution (videos belong to their creators; not affiliated with Divine; data read from Divine's public relay at its published limits); the header coordinate and template ids; setup (`npm install`, key file, `profile.json`); the runbook (rehearsal, profile, rebroadcast, pilot, first import, enabling launchd, moving to a server: the same command under cron or systemd with `DIVINEBOT_KEY_FILE`); reading `report.md` and `NEEDS_REVIEW`; recovery (rerun publish, deleting a bad run's items).

- [ ] **Step 1: Write the files.**
- [ ] **Step 2: Rehearse** (operator step, no public relay): start `nak serve --port 10547`; generate a throwaway key into `state/rehearsal.key` (mode 600) and set its pubkey as `curatorPubkey` in `config.rehearsal.json`; run `DIVINEBOT_CONFIG=config.rehearsal.json DIVINEBOT_KEY_FILE=state/rehearsal.key npm run run -- --pilot 150 --first-run` (real reads from `relay.divine.video`), then `sign`, `publish`, `verify`. Expected: 150 items on the local relay, verify clean, a second `build` with no changes writes zero lines.
- [ ] **Step 3: Run** `bash -n scripts/launchd/run-divinebot.sh && plutil -lint scripts/launchd/world.brainstorm.divinebot.plist.example`. Expected: no errors.
- [ ] **Step 4: Commit** `docs: README, launchd wrapper and rehearsal config`.

After Task 16 the plan ends. Rollout steps 2–6 of spec § 7.4 (profile, rebroadcast, pilot, first import, enabling launchd) each happen only on Avi's explicit go.
