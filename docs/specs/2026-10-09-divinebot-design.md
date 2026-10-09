# divinebot: Divine Videos DList curator bot (design)

Status: design approved section by section by Avi, 2026-10-09. This document is for his review before the implementation plan.
Repo: `aburra16/divinebot` (public, MIT). Local checkout: `~/Documents/Tapestry/divine-videos`.
Model: `aburra16/mise-en-place`, the BTC Map food and drink importer, whose proven modules this repo copies.

## 1. Purpose

Fill the live DList `Divine Videos` with one kind 39999 item per Divine video, signed by a dedicated curator account, and keep the list current as Divine changes: new videos added, edited videos updated, deleted or vanished videos removed. The first consumer is brainstorm.world.

This is developer tooling: command-line scripts plus a scheduled job. It has no user-facing interface of its own.

### Success criteria

- Every eligible native Divine video has exactly one current item on `wss://dcosl.brainstorm.world` and `wss://search.brainstorm.world`, signed by the curator.
- New and edited videos, author deletions, vanished videos and dead media are reflected within one daily run.
- An item is republished only when its content changes, so reactions to unchanged items stay attached.
- Every event id ever published is recorded, so a deletion can name every version.
- No secret appears in the repo, a log, a shell history line or a command-line argument.
- Each run leaves a `report.md` that says what it did and why anything was skipped.
- The same code runs on Avi's Mac now and on a server later, with only the scheduler changing.

## 2. Fixed facts

All values below live in `config.json` and are checked at run time. None is hardcoded in code.

| Fact | Value | How verified |
|---|---|---|
| Header coordinate | `39998:b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450:divine-videos` | Read back from dcosl 2026-10-09; event `59d847a44d53017b3d5734702b94b45712ac000cc83f1ef9d7a0f33a7aa52ee8`, signature valid, tags equal `header/divine-videos.header.json` with template ids filled in |
| Header `required` | `title`, `video`, in that order | Same read |
| URL template "Divine video" | event `97d7f683f8cfea346e389042430e1795fc6ddae25ee9dff298c95867d707b7ee`, `https://divine.video/video/{id}` bound to `divine-id` | Same read |
| URL template "Divine profile" | event `f07980288c1036e748bf80070b07cc2780a295b3ee15dd8b306dfea87abafd20`, `https://divine.video/profile/{npub}` bound to `creator-npub` | Same read |
| Curator pubkey | `6b279fb268a564ef74f35533f58a165fd4846b9c5595ac0bfc38cab37fda559d` (`npub1dvnelvng54jw7a8n25eltzsktl2gg6uu2k26czlu8r9txl762kwsx52h55`) | Avi; key file checked to derive this pubkey |
| Source relay | `wss://relay.divine.video` (Funnelcake, ClickHouse-backed, no AUTH, `max_limit` 5000, 10 filters per REQ, 512 KB message cap) | NIP-11 and live reads |
| Video kind | 34236 only. Kinds 21 and 22 are empty; the 247 kind 34235 events come from other apps. | NIP-45 COUNT |
| Native video `d` | the video file's sha256, also `imeta x` | 50 of 50 sampled |
| Classic Vine markers | `["l","vine-archive","archive.divine.video"]`, `["platform","vine"]`, `d` = Vine id, `created_at` backdated to 2013–2016 | Live sample of 5,000 |
| Scale (2026-10-09) | about 2.27M kind 34236 events: about 2.22M classic Vines, about 51k native, about 280 new native a day | COUNT and Divine `/api/stats` |
| Native event size | about 22 KB average (ProofMode and device attestation tags) | Live sample |
| Media | `https://media.divine.video/<sha256>`; `<sha256>.mp4` returns the same bytes typed `video/mp4` | HEAD requests |
| Divine watch page | `https://divine.video/video/<d>` opens native videos and classic Vines; the sha256 does not open a Vine | Browser check |
| `nak` against the source relay | `nak req` hangs on this relay; plain WebSocket clients work | Live |
| dcosl | strfry 1.0.4, stores kinds 9998, 9999, 39998, 39999, 7 (and accepts kind 5), honours only `e` on deletions, `max_message_length` 131072 | NIP-11; Mise en Place history |

## 3. Decisions

### Settled by Avi (2026-10-09)

- **Scope now:** native Divine videos. The header covers classic Vines too, and the bot is built to include them later behind a config switch, once dcosl capacity is confirmed.
- **Signer:** the dedicated curator key for items, deletions and the curator profile. Avi's key signed the header and the two templates; this tool never signs either.
- **Relays:** publish to dcosl and the search relay. The header and both templates are copied to the search relay byte for byte.
- **Skip:** videos with a content warning, videos whose event carries `expiration`, and videos whose media fails a check.
- **Deletions:** mirror Divine's author deletions with NIP-09 kind 5.
- **Item shape:** exactly the reviewed header (§ 5).
- **Code structure:** a new repo that copies Mise en Place's proven modules; no shared package until a third importer exists.
- **Where it runs:** Avi's Mac first, on a launchd schedule; possibly a server from next week. The design keeps that a deployment change.
- **Console:** not in v1. `report.md` and `status` cover it.

### Defaults taken here

- Node 22+ and TypeScript run via `tsx`, `vitest`, `nostr-tools` 2.25 (keys, NIP-19, NIP-49, signing, signature checks), `better-sqlite3`, `ws` for the source client.
- First harvest window: `since` 2025-01-01 (UTC). Every native video falls after it.
- Cursor overlap: one hour.
- Media checks: 5 requests per second; rolling recheck about every 30 days per item.
- Profile refresh: on first sight of a creator and weekly for all; NIP-05 results cached 7 days.

## 4. Scope rules

A kind 34236 event is **eligible** when all of these hold, checked in this order; the first failure is recorded as the skip reason:

1. Its signature verifies.
2. It is native: it carries no `l` tag `vine-archive` and no `l` tag `user-submitted`, and no `["platform","vine"]`.
3. It has an `imeta` tag whose `x` is 64 lowercase hex characters and whose `m` is `video/mp4`.
4. It has a title: `title`, else the first non-empty line of `summary`.
5. It carries no `content-warning` tag and no `l` tag in the `content-warning` namespace (`L content-warning`).
6. It carries no `expiration` tag.
7. Its video `.mp4` and its thumbnail pass the media check (§ 6.4).

The classification for classic Vines is kept in code so `config.scope.includeVines: true` can switch them on later.

## 5. Item shape

Kind 39999, empty content, tags in this order. A field with no value is omitted, never written empty.

| Tag | Source | Rule |
|---|---|---|
| `d` | event | `divine-<pubkey>-<d>` |
| `z` | config | the header coordinate; exactly one |
| `title` | `title`, else first line of `summary` | trimmed |
| `video` | `imeta x` | `https://media.divine.video/<x>.mp4` |
| `thumbnail` | `imeta image` | only if `https://` |
| `creator` | kind 0 `display_name`, else `name` | trimmed; classic Vines use the `author` tag |
| `creator-npub` | event `pubkey` | NIP-19 npub |
| `creator-nip05` | kind 0 `nip05` | only after a live lookup returns the event's pubkey; `_@<u>.divine.video` is written `<u>@divine.video` when the root lookup for `<u>` also returns that pubkey; any other verified identifier verbatim |
| `divine-id` | event `d` | verbatim |
| `sha256` | `imeta x` | verbatim |
| `published` | `published_at`, else `created_at` | UTC date, `YYYY-MM-DD` |
| `description` | `summary` | trimmed; omitted when equal to the title |
| `duration` | `imeta duration`, else `duration` tag | verbatim |
| `dimensions` | `imeta dim` | verbatim |
| `platform` | constant | `divine` (`vine` for classic Vines, later) |
| `vine-creator-id`, `vine-loops`, `vine-likes` | `vine_user_id`, `loops`, `likes` | classic Vines only, later |
| `language` | `l` tag in namespace `ISO-639-1` | verbatim |
| `verification` | `verification` tag | verbatim |
| `a` | event | `34236:<pubkey>:<d>` |
| `p` | event `pubkey` | hex |
| `t` × n | constant and `t` tags | `divine` first, then the event's hashtags lowercased; duplicates removed, order kept |
| `alt` | derived | `Divine video: <title> by <creator>`, or `Divine video: <title>` without a creator |

`header/example-items.json` holds two items in this shape built from live events; the build's unit tests must reproduce them exactly, apart from fields that depend on live profile and NIP-05 reads, which the tests supply as fixtures.

## 6. Architecture

```
relay.divine.video ──sync/sweep──▶ state: source events, cursors
media.divine.video ──media──────▶ state: media checks
relay.divine.video, .well-known ──profiles──▶ state: profiles, NIP-05
                              │
                    build (pure apart from one header read)
                              │
          out/<run>/unsigned.jsonl  +  out/<run>/report.md
                              │
                    sign  (only step that loads the key)
                              │
                    out/<run>/signed.jsonl
                              │
                    publish ──▶ dcosl + search relay
                              │
                    state: every event id, per-relay result
```

### 6.1 Units

New for Divine:

- **`source/divine-relay.ts`:** the WebSocket client for the source relay. `REQ` with `limit` 5000, paging back with `until` = oldest `created_at` seen (inclusive) and deduplicating by id; at least one second between pages; one connection at a time; backs off on `CLOSED` or rate-limit notices. Verifies every event's signature and drops failures with a recorded reason.
- **`source/classify.ts`:** native, classic Vine or user-submitted archive; the scope rules in § 4 except media.
- **`source/sync.ts`:** the incremental read. Reads kind 34236 since `cursor.videos - 3600`, and kind 5 with `#k: ["34236"]` since `cursor.deletions - 3600`. Stores the newest version per address. Applies a deletion only when its author equals the video's author and it names the video by `e` id or by `a` coordinate. Advances each cursor to the newest `created_at` it saw.
- **`source/sweep.ts`:** the weekly full read of the native window. An address in state that is active but absent from the sweep is marked `vanished`.
- **`media.ts`:** HEAD checks. Pass means 200 with `content-type` `video/mp4` for the video and `image/*` for the thumbnail. 401, 403, 404, 410 and a wrong type are failures with the status recorded. Timeouts and 5xx are inconclusive and retried next run, never treated as failures.
- **`profiles.ts`:** kind 0 reads from the source relay in batches of up to 500 authors, newest per author; NIP-05 lookups over HTTPS with a 5 second timeout and the 7 day cache.
- **`item.ts`:** builds the § 5 tags from a source event plus profile and NIP-05 results. Pure and deterministic.

Copied from Mise en Place, adapted where noted:

- **`key.ts`:** loads `nsec` or `ncryptsec` from `~/.config/divine-videos/curator.key` (override `DIVINEBOT_KEY_FILE`); refuses a file readable by group or others; checks the derived pubkey against `config.curatorPubkey`; never prints the key or the passphrase.
- **`header.ts`:** reads the header live and stops unless `required` is exactly `title`, `video` and the two `link` tags name the template ids in config.
- **`diff.ts`:** new, changed, unchanged or gone, by a hash of the tags excluding `created_at`.
- **`deletion.ts`:** a kind 5 with `["e", <id>]` for every version in state, `["a", "39999:<curator>:<d>"]` and `["k", "39999"]`.
- **`sign.ts`, `publish.ts`, `verify.ts`, `manifest.ts`, `earlier-runs.ts`, `relay.ts`:** as in Mise en Place, including resumable publishing, deletions last, run manifests bound to the config, and `include:spam` on search-relay reads.
- **`state.ts`:** SQLite, schema in § 6.3.

### 6.2 Item lifecycle

An item is **gone**, and gets a kind 5, when its source video is:

- deleted by its author (an accepted kind 5);
- vanished (missing from a sweep);
- no longer eligible (it gained a content warning or an `expiration` tag, or its title or media fields disappeared);
- failing a media recheck.

An item is **changed** when its built tags differ from the last published version: the creator edited the video, changed their profile name, or their handle stopped resolving. Changed items get a new version at the same `d`.

### 6.3 State (`state/state.sqlite`)

- `cursors(name, value)`: `videos`, `deletions`, `last_sweep`.
- `sources(address, event_id, created_at, json, class, status, skip_reason, first_seen, last_seen)`: `address` is `<pubkey>:<d>`; `status` is `active`, `deleted`, `vanished` or `skipped`.
- `profiles(pubkey, json, fetched_at)` and `nip05(identifier, pubkey, ok, checked_at)`.
- `media(url, status, content_type, checked_at)`.
- `items(d, address, status, content_hash, tags_json, latest_event_id, first_seen, last_changed)`.
- `events(event_id, d, kind, created_at, run_id, relay, ok, message)`.

### 6.4 Media checks

Run before an item is first built and again on a rolling basis so each listed item is rechecked about every 30 days (about 1,700 requests a day at 51k items). A failure blocks a new item and deletes a listed one, subject to the guards in § 7.3.

## 7. Workflows

### 7.1 Commands

| Command | Does | Network | Key |
|---|---|---|---|
| `npm run sync` | Incremental read; the first run does the full native harvest | source relay | no |
| `npm run sweep` | Weekly full read; marks vanished videos | source relay | no |
| `npm run media` | Pending checks plus the rolling rechecks | media host | no |
| `npm run profiles` | Profile and NIP-05 refresh | source relay, `.well-known` | no |
| `npm run build -- [--pilot N]` | Header check, then `unsigned.jsonl` and `report.md` | dcosl (header) | no |
| `npm run sign -- <run>` | `signed.jsonl` | none | yes |
| `npm run publish -- <run> [--relays dcosl,search]` | Publish and record; 5 events/s per relay, relays in parallel | relays | no |
| `npm run verify` | Read back from both relays; list missing and extra | relays | no |
| `npm run rebroadcast` | Copy the header and both templates to the search relay unchanged | relays | no |
| `npm run profile:publish` | Sign and publish the curator's kind 0 from `profile.json` (`bot: true`) to the profile relays in config | profile relays | yes |
| `npm run run -- [--auto]` | sync, media, build, then (auto only) sign, publish, verify | all | auto only |
| `npm run status` | Counts, last run, runs waiting for review | none | no |

A pilot build never emits deletions. `--pilot N` picks N eligible videos deterministically, spread across creators (at most two per creator) and across months.

### 7.2 Review gates

- **Manual (default):** `run` stops after `build`. Avi reads `report.md`, then runs `sign` and `publish`. The pilot and the first native import always go this way.
- **Automatic (`run --auto`):** continues to sign, publish and verify only when every guard in § 7.3 passes. Otherwise it writes the report, writes `out/<run>/NEEDS_REVIEW`, and exits with status 2. On the Mac, the launchd wrapper turns a non-zero exit into a notification. A server uses its own alerting.

### 7.3 Guards for automatic runs (config, with these defaults)

| Guard | Default |
|---|---|
| New plus changed items per run | ≤ 2,000 |
| Deletions per run | ≤ max(25, 2% of listed items) |
| Vanished in one sweep | ≤ 5% of listed items |
| Media-check failures among checks this run | > 20% means a probable media outage: record nothing as failed, stop |
| Source returns no events for a window that held events in state | probable relay trouble: stop |

Also: a lock file so runs never overlap, and the Mise en Place checks that a run is signed and published with the config it was built with and that earlier runs were fully published.

### 7.4 Rollout

1. **Rehearsal:** real reads from the source relay; publishing only to a local `nak serve` with a throwaway key and `config.rehearsal.json`. Nothing reaches dcosl or the search relay.
2. **Curator profile:** Avi approves the name and about text; `profile:publish`. The about text says the account is automated, lists Divine videos and does not review them.
3. **`rebroadcast`** the header and templates to the search relay.
4. **Pilot:** 150 native videos; Avi reviews `report.md`; sign, publish, verify; Avi checks them on Brainstorm.
5. **First native import:** manual gate.
6. **Daily sync:** launchd runs `run --auto` daily; `sweep` weekly. Moving to a server later changes only the scheduler and the key file path.

Throughput: the first native import is about 51k items, roughly 3 hours per relay at 5 events per second, both relays in parallel.

## 8. Key handling

- The key lives at `~/.config/divine-videos/curator.key`, mode 600, in a mode 700 folder, written by Avi (done 2026-10-09). `DIVINEBOT_KEY_FILE` overrides the path.
- Only `sign`, `profile:publish` and `run --auto` load it. A passphrase for an `ncryptsec` is read from the TTY only; `run --auto` refuses an `ncryptsec` unless `DIVINEBOT_PASSPHRASE_FILE` names a mode 600 file.
- Rehearsal uses a throwaway key and `config.rehearsal.json`.
- `.gitignore` covers `node_modules/`, `data/`, `out/`, `state/`, `*.key` and `config.rehearsal.json`.

## 9. Testing

- **Unit:** the § 5 builder against fixtures taken from live events (native, classic Vine, no title, content warning, `expiration`, non-MP4, missing `imeta`, user-submitted archive, forged signature), and `header/example-items.json` reproduced exactly; the NIP-05 rule; the deletion-author rule; the change hash; every guard; paging across a shared `created_at` boundary; the pilot selection.
- **Copied modules** keep their Mise en Place tests, adapted to this config.
- **Integration:** a stub source relay that honours `limit`, `until`, `since`, `#k` and kind 5; a stub media server; `nak serve` as the target; a throwaway key. Scenarios: first harvest, an edit, an author deletion, a deletion by another key (ignored), a vanished video in a sweep, dead media, a run over each guard (must stop with status 2), and a resumed publish.

## 10. Attribution, terms and licence

- **Code:** MIT.
- **Data:** items point at Divine's media and pages and copy public event metadata; no media is copied. The README states that videos belong to their creators and that the list is not affiliated with Divine.
- **Divine's terms** (§ 6(D)) forbid scraping their service or API. The bot reads Divine's public relay at its published limits and politely, and never uses the REST API. Avi has seen this and owns the judgement.
- **Classic Vines:** no licence is stated for the archive; they stay out of scope for now.
- **Not committed:** fetched data, state and built output stay gitignored.

## 11. Outside this tool

- Registering the coordinate in Brainstorm-UI `dictionary.config.json` without `search: true` (Vinney).
- Brainstorm's 500-item read cap and its "also listed by" matching on the first required field (now `title`), raised with Vinney.
- Confirming dcosl capacity before classic Vines.
- Moving the scheduled job to a server.
- A console, if the reports turn out not to be enough.
