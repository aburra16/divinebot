# divinebot

divinebot fills a nostr DList called "Divine Videos" with the native videos posted on Divine (divine.video). Each video becomes one kind 39999 item under the list's header, signed by the divinebot curator account. It keeps the list current: new videos are added, edited videos are updated, and videos that their author deleted, that vanished from Divine, or whose media no longer plays are removed. It is developer tooling: a command-line pipeline (sync, build, sign, publish, verify) and a scheduled daily run. It has no interface of its own; each run leaves a `report.md` and `npm run status` shows the state.

## Attribution

- The videos belong to their creators. The list points at Divine's media and Divine's pages and copies public event metadata only (title, caption, creator name, dates and similar). It copies no video or image.
- This project is not affiliated with Divine.
- The bot reads Divine's public relay (`wss://relay.divine.video`) within the limits that relay publishes, politely: pages of at most 5,000 events, at least one second apart, one connection at a time, and at most 5 media checks per second. It never uses Divine's REST API.
- Classic Vines (the restored Vine archive) are out of scope for now. They stay behind the `scope.includeVines` switch in `config.json`, which is off.
- The code is MIT; see `LICENSE`. Fetched data, state and built output (`data/`, `state/`, `out/`) are not committed.

## The list

- Header coordinate: `39998:b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450:divine-videos`. The header event is `59d847a44d53017b3d5734702b94b45712ac000cc83f1ef9d7a0f33a7aa52ee8`.
- URL templates: "Divine video" `97d7f683f8cfea346e389042430e1795fc6ddae25ee9dff298c95867d707b7ee` and "Divine profile" `f07980288c1036e748bf80070b07cc2780a295b3ee15dd8b306dfea87abafd20`. `header/published.json` records them.
- Avi's key signed the header and both templates, using `header/sign-header.html`. This tool never signs a header or a template.
- Curator: `npub1dvnelvng54jw7a8n25eltzsktl2gg6uu2k26czlu8r9txl762kwsx52h55` (hex `6b279fb268a564ef74f35533f58a165fd4846b9c5595ac0bfc38cab37fda559d`). It signs the items, the deletions and its own profile (kind 0), and nothing else.
- Target relays: `wss://dcosl.brainstorm.world` and `wss://search.brainstorm.world`. Source relay: `wss://relay.divine.video`. Media: `https://media.divine.video`.

These values live in `config.json`.

## Requirements

Node 22 or later. Install the exact versions in `package-lock.json`:

```bash
npm ci
```

`nak` (https://github.com/fiatjaf/nak) is needed for the tests, the rehearsal and the key check below. `nak req` hangs on Divine's relay, so the bot reads it with a plain WebSocket client instead.

## Setup

### Curator key

Avi writes the curator key himself, as an `nsec` or a NIP-49 `ncryptsec`. It never goes in the repo, on a command line, or in a chat. The tool reads it from `~/.config/divine-videos/curator.key`, or from the file named by `DIVINEBOT_KEY_FILE`. It refuses a file that group or others can read, and a key whose public key is not the curator's. Only `sign`, `profile:publish` and `run --auto` load the key.

```bash
mkdir -p ~/.config/divine-videos && chmod 700 ~/.config/divine-videos
(umask 077; pbpaste > ~/.config/divine-videos/curator.key) && chmod 600 ~/.config/divine-videos/curator.key
pbcopy < /dev/null
```

For an `nsec` only, check that the file holds the curator's key. This must print `6b279fb268a564ef74f35533f58a165fd4846b9c5595ac0bfc38cab37fda559d`, and never the key:

```bash
nak decode < ~/.config/divine-videos/curator.key | nak key public
```

Skip that check for an `ncryptsec`. `sign` covers it: it derives the public key from the decrypted key and refuses one that is not the curator's.

With an `ncryptsec`, `sign` asks for the passphrase at a terminal prompt and never takes it as an argument. An unattended `run --auto` cannot prompt, so it refuses an `ncryptsec` unless `DIVINEBOT_PASSPHRASE_FILE` names a passphrase file with mode 600.

### Other settings

- `DIVINEBOT_CONFIG` names the config file; the default is `config.json`.
- `profile.json` holds the curator's profile text. Copy `profile.example.json` to `profile.json`, review it, and change it only on purpose. It is gitignored. The profile says the account is automated, lists Divine videos and does not review them.

## Commands

Run them from the repo root. Each stage writes files the next one reads, so any stage can be inspected before the next begins.

| Command | Does | Network | Key |
|---|---|---|---|
| `npm run sync` | Incremental read of the source relay; the first run harvests every native video | source relay | no |
| `npm run sweep` | Full read that stores any video sync missed and marks vanished videos, after asking for each missing one by name | source relay | no |
| `npm run media` | Pending media checks plus the rolling rechecks | media host | no |
| `npm run profiles` | Creator profile and NIP-05 refresh | source relay, `.well-known` | no |
| `npm run build -- [--pilot N] [--first-run]` | Checks the header, then writes `unsigned.jsonl`, `manifest.json` and `report.md` into `out/<run>/` | dcosl (header) | no |
| `npm run sign -- <run>` | Writes `signed.jsonl` | none | yes |
| `npm run publish -- <run> [--relays dcosl,search]` | Publishes and records every event id | target relays | no |
| `npm run publish -- <run> --settle-refused` | Marks the run's refused events as settled, so the run counts as finished; sends nothing | none | no |
| `npm run verify` | Reads both relays back and lists missing and extra items | target relays | no |
| `npm run rebroadcast` | Copies the header and both templates to the search relay unchanged | relays | no |
| `npm run profile:publish` | Signs and publishes the curator's profile from `profile.json` | profile relays | yes |
| `npm run run -- [--auto] [--pilot N] [--first-run]` | sync, sweep when due, profiles, media, build; with `--auto`, then sign, publish and verify | all | auto only |
| `npm run status` | Counts, cursors, the last run per relay, unfinished runs and runs marked NEEDS_REVIEW | none | no |

Notes:

- The weekly sweep happens inside `run`: it runs a sweep when the last one is more than seven days old, and never on the first harvest. No separate schedule is needed.
- A pilot build never emits deletions. `--pilot N` picks N eligible videos, spread across creators (at most two per creator) and across months. `--pilot` alone uses `pilotSize` from the config.
- `build` refuses a state with no items unless given `--first-run`. Use it for the very first import only (the pilot).
- A build skips, and the report counts by reason: `content-warning` (the video carries a content warning), `expiration` (the event carries an `expiration` tag), `no-title` (no usable title, which the header requires), `media-failed` (a stored media check failed) and `media-pending` (a new video whose media checks have not passed yet).
- The rehearsal measured about 9% `no-title` among real native videos (73 of 810). That is roughly 4,600 videos at full scale, and whether to list them under a fallback title is a product decision for Avi before the first import.
- An item is republished only when its content changes, so reactions to unchanged items stay attached.

## Runbook

Each public step below happens only on Avi's explicit go.

1. **Rehearsal.** Real reads from Divine, publishing to a local relay with a throwaway key. Nothing reaches dcosl or the search relay. See Rehearsal below.
2. **Curator profile.** Avi approves the name and about text in `profile.json`, then:

   ```bash
   npm run profile:publish
   ```

3. **Rebroadcast** the header and templates to the search relay:

   ```bash
   npm run rebroadcast
   ```

4. **Pilot.** 150 native videos. Review `out/<run>/report.md`, then sign, publish and verify. Avi checks the items on Brainstorm.

   Be ready for how long this takes. `run --pilot 150 --first-run` still performs the whole first harvest (about 51,000 native videos, about 1.1 GB read from Divine's relay) and a media check for every eligible video, and only then picks the 150 and writes `report.md`. The rehearsal checked 1,444 media URLs for 810 videos, about two per eligible video. At 5 checks per second that is about 45,000 eligible videos times two, roughly 90,000 checks, so plan on about 5 hours, plus the harvest. The pilot's publish is quick; the cost is up front. The first import then reuses all of it and only publishes.

   An interrupted run is safe to start again. The harvest cursor moves only after a window is fully read, so a harvest that stopped partway re-reads from the start of the window and rewrites the same events without duplicates. Media passes are saved as each batch finishes and are not checked again; media failures are saved only when the run's checks finish, so an interrupted run checks those URLs again.

   ```bash
   npm run run -- --pilot 150 --first-run
   npm run sign -- <run>
   npm run publish -- <run>
   npm run verify
   ```

5. **First native import.** About 51,000 items, roughly 3 hours per relay at 5 events per second, with both relays in parallel. It always goes through the manual gate. Pass `--first-run` only if the state holds no items; after a pilot it does not.

   ```bash
   npm run run
   npm run sign -- <run>
   npm run publish -- <run>
   npm run verify
   ```

6. **Enable the daily run** (see Scheduling below).

### Reviewing a run

`run` without `--auto` stops after `build` and prints the run directory and the three commands that come next. Open `out/<run>/report.md`. It holds these sections:

- Sources: native videos in state, how many are eligible, deleted and vanished.
- Events: how many items are new, changed, unchanged and deleted.
- Skipped: videos left out, counted by reason.
- Changed fields: per tag, how many items differ from their live version, with examples.
- Deletions: each item to delete and why.
- Guards: each guard's limit, the actual value and pass or BREACH.
- Sample items: the first 20 items by `d`, tag by tag.

### NEEDS_REVIEW and automatic runs

`run --auto` signs, publishes and verifies only when every guard passes. The defaults are:

- New plus changed items per run: at most 2,000.
- Deletions per run: at most the larger of 25 and 2% of listed items.
- Videos vanished in one sweep: at most 5% of listed items.
- Media failures: more than 20% of the checks in a run looks like a media outage, so no failure is recorded and nothing is deleted for it.

When a guard breaches, `--auto` writes the report, writes `out/<run>/NEEDS_REVIEW` and exits with status 2. `NEEDS_REVIEW` is only a marker. It lists the reasons, and only `npm run status` and the launchd notification read it. Open `report.md`; if the change is real, sign and publish the run by hand:

```bash
npm run sign -- <run>
npm run publish -- <run>
npm run verify
```

An automatic run refuses `--pilot` and `--first-run`, which are for a person.

An automatic run that finds an unfinished earlier run still syncs, sweeps, refreshes profiles and checks media, but builds nothing and exits with status 2, so unfinished runs never pile up. `npm run status` lists the unfinished runs. To clear one, sign and publish it, or delete its folder under `out/` if you mean to abandon it. Delete its `NEEDS_REVIEW` file too once you have dealt with it (deleting the folder does that), so `status` and the notification stop pointing at it.

### Recovery

- **A publish stopped partway.** Run it again: `npm run publish -- <run>`. Events a relay already accepted are not sent twice. To fill one relay only, name it: `npm run publish -- <run> --relays search`. `verify` then compares both relays with state.
- **A relay refuses an event for good.** A refused event keeps its run unfinished, and an automatic run builds nothing while any run is unfinished. One case settles itself: a kind 5 deletion refused by a relay that never accepted any version of the item has nothing to delete there, so publish records it as settled, prints "deletion refused by <relay>; the relay never held the item" and does not count it as a failure. For any other refusal you have decided to accept, close the run without deleting its folder:

  ```bash
  npm run publish -- <run> --settle-refused
  ```

  It prints each event it settles (kind, event id, `d`, relay and the relay's message) and never sends anything. A settled event is not sent again, and `status` stops listing the run. An event still pending from a crash is not settled; publish the run again first.
- **A sweep failed or looked wrong.** A sweep refuses to mark anything when it read no videos at all while state holds some, or when more than `guards.maxVanishedFraction` (5%) of the active native videos would vanish; both point at an incomplete read from Divine rather than at creators. Before it marks a video vanished, it also asks the relay for that video by name. A refused sweep leaves state and the sweep date as they were, and inside `run` it is only a warning: the day's new videos are still built and published. Run it again later by hand, and check `npm run status` afterwards:

  ```bash
  npm run sweep
  ```

  Until a sweep succeeds, every daily run tries the full read again.
- **State and relays disagree.** Run `npm run verify` and read its missing and extra lists before building again.
- **A bad run was published.** Every event id ever published is recorded in `state/state.sqlite`, so a deletion can name every version of an item. The tool removes items when their videos stop being eligible: a build emits kind 5 deletions for them, within the deletion guard. There is no command that deletes a whole run at once. If a run must be undone, stop and decide with Avi before changing scope or state, because a mass deletion is public and cannot be taken back.
- **Back up `state/state.sqlite`.** It is the only record of what was published. After each publish:

  ```bash
  mkdir -p state/backups && sqlite3 state/state.sqlite ".backup state/backups/state-$(date +%Y-%m-%d).sqlite"
  ```

  `state/` is gitignored, so keep a copy outside the repo as well.
- **A run holds a lock** at `state/state.sqlite.lock` so two runs never overlap. A second command that meets a held lock stops and names the process and the time. A lock more than six hours old is taken to belong to a dead run, and it is replaced with a warning.

## Scheduling

On Avi's Mac, launchd runs `scripts/launchd/run-divinebot.sh` daily at 06:00 local time. The script runs `npm run run -- --auto`, appends the output to `state/logs/<date>.log`, and on a non-zero exit shows a macOS notification that names the run directory to look at. It holds no secrets: the key comes from the key file.

Enable it only after the first native import is verified, and only after this check by hand.

**Check that the search relay takes deletions from the curator.** Every removal is a kind 5 sent to both relays. If search.brainstorm.world refuses kind 5 from the curator, each deletion of an item it holds fails there, the run stays unfinished, and every automatic run after it builds nothing and exits with status 2 until someone settles it. The check publishes one kind 5 that names an item that does not exist, so it deletes nothing. It is a public write, so do it on Avi's go:

```bash
nak event --prompt-sec -k 5 -t k=39999 -t a=39999:6b279fb268a564ef74f35533f58a165fd4846b9c5595ac0bfc38cab37fda559d:divinebot-deletion-probe -c "" wss://search.brainstorm.world
```

Paste the `nsec` at the prompt (for an `ncryptsec`, run it with `NOSTR_SECRET_KEY="$(cat ~/.config/divine-videos/curator.key)"` in front instead of `--prompt-sec`, and nak asks for the passphrase). nak prints whether the relay accepted it. If it was refused, do not enable the daily run: ask the relay's operators to accept kind 5 from the curator first.

```bash
mkdir -p state/logs
sed "s#/Users/YOU#$HOME#g" scripts/launchd/world.brainstorm.divinebot.plist.example > ~/Library/LaunchAgents/world.brainstorm.divinebot.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/world.brainstorm.divinebot.plist
```

To test it once without waiting for 06:00: `launchctl kickstart gui/$(id -u)/world.brainstorm.divinebot`. To disable it: `launchctl bootout gui/$(id -u)/world.brainstorm.divinebot`.

An `ncryptsec` key needs `DIVINEBOT_PASSPHRASE_FILE` in the job's environment, and a key file anywhere but the default path needs `DIVINEBOT_KEY_FILE`. launchd does not read shell exports or expand `~`, so set them in the commented `EnvironmentVariables` block of the plist, with absolute paths. An `nsec` key file with mode 600 at the default path needs nothing more.

### Moving to a server

Only the scheduler and the key file path change. Check out the repo, run `npm ci`, put the key file on the server with mode 600 in a mode 700 folder, and run the same command from cron or a systemd timer:

```bash
cd /path/to/divine-videos && DIVINEBOT_KEY_FILE=/path/to/curator.key npm run run -- --auto
```

The server needs its own alerting on exit status 2 (and 1), in place of the macOS notification.

## Rehearsal

The rehearsal reads real Divine data and publishes only to a local relay. Never publish to a public relay from a rehearsal.

1. Start a local relay and leave it running:

   ```bash
   nak serve --port 10547 --hostname 127.0.0.1
   ```

2. Generate a throwaway key. The key file must hold an `nsec`:

   ```bash
   mkdir -p state/rehearsal && chmod 700 state/rehearsal
   (umask 077; nak key generate | nak encode nsec > state/rehearsal/rehearsal.key)
   nak decode < state/rehearsal/rehearsal.key | nak key public
   ```

3. Copy the example config, then set `curatorPubkey` in `config.rehearsal.json` to that public key, and set `source.harvestSince` to a unix time a few days back so only a small slice of Divine is read (three days is about 800 videos). On macOS, `date -v-3d +%s` prints it. The file is gitignored. Both target relays are the local relay, and `paths` sit under `state/rehearsal/`.

   ```bash
   cp config.rehearsal.example.json config.rehearsal.json
   ```

4. Seed the local relay with Avi's header and both URL templates. `build` checks the header on its own relay, so it fails without this. The helper reads them from dcosl with the production `config.json` (it ignores `DIVINEBOT_CONFIG`), publishes them unchanged to the local relay, and refuses any target that is not a `ws://` URL on 127.0.0.1, `[::1]` or localhost. It reads from dcosl and writes only to the local relay. The default target is `ws://127.0.0.1:10547`.

   ```bash
   npm run rehearsal:seed
   ```

5. Run everything with the rehearsal settings:

   ```bash
   export DIVINEBOT_CONFIG=config.rehearsal.json DIVINEBOT_KEY_FILE=state/rehearsal/rehearsal.key
   npm run run -- --pilot 150 --first-run
   npm run sign -- <run>
   npm run publish -- <run>
   npm run verify
   npm run build
   npm run status
   ```

   The pilot built only 150 items, so the second `build` writes the remaining eligible items (in the rehearsal, 568 created and 150 unchanged). Sign, publish and verify that run as well. The idempotence check is a further `build` after those are published: it must create nothing, change nothing and write zero lines to `unsigned.jsonl`. Stop `nak serve` when done.

## Tests

```bash
npm test
npm run typecheck
```

The integration tests use a stub source relay, a stub media server and `nak serve` as the target, with a throwaway key. They never touch a public relay.

## What this tool does not do

- It does not sign the header or the URL templates; Avi does.
- It does not register the list in Brainstorm's dictionary config. That is a change in Brainstorm-UI.
- It does not lift Brainstorm's read cap on list items.
- It does not list classic Vines yet. Dcosl capacity needs confirming first.
- It does not copy any video or image. Items link to Divine's media and pages.
