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
pbpaste > ~/.config/divine-videos/curator.key && chmod 600 ~/.config/divine-videos/curator.key
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
| `npm run sweep` | Full read that marks vanished videos | source relay | no |
| `npm run media` | Pending media checks plus the rolling rechecks | media host | no |
| `npm run profiles` | Creator profile and NIP-05 refresh | source relay, `.well-known` | no |
| `npm run build -- [--pilot N] [--first-run]` | Checks the header, then writes `unsigned.jsonl`, `manifest.json` and `report.md` into `out/<run>/` | dcosl (header) | no |
| `npm run sign -- <run>` | Writes `signed.jsonl` | none | yes |
| `npm run publish -- <run> [--relays dcosl,search]` | Publishes and records every event id | target relays | no |
| `npm run verify` | Reads both relays back and lists missing and extra items | target relays | no |
| `npm run rebroadcast` | Copies the header and both templates to the search relay unchanged | relays | no |
| `npm run profile:publish` | Signs and publishes the curator's profile from `profile.json` | profile relays | yes |
| `npm run run -- [--auto] [--pilot N] [--first-run]` | sync, sweep when due, profiles, media, build; with `--auto`, then sign, publish and verify | all | auto only |
| `npm run status` | Counts, cursors, the last run per relay, unfinished runs and runs marked NEEDS_REVIEW | none | no |

Notes:

- The weekly sweep happens inside `run`: it runs a sweep when the last one is more than seven days old, and never on the first harvest. No separate schedule is needed.
- A pilot build never emits deletions. `--pilot N` picks N eligible videos, spread across creators (at most two per creator) and across months. `--pilot` alone uses `pilotSize` from the config.
- `build` refuses a state with no items unless given `--first-run`. Use it for the very first import only (the pilot).
- A build skips videos with a content warning, videos whose event carries `expiration`, and videos whose media fails a check. The report counts every skip by reason.
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

When a guard breaches, `--auto` writes the report, writes `out/<run>/NEEDS_REVIEW` and exits with status 2. `NEEDS_REVIEW` is only a marker. It lists the reasons and nothing reads it back. Open `report.md`; if the change is real, sign and publish the run by hand:

```bash
npm run sign -- <run>
npm run publish -- <run>
npm run verify
```

An automatic run refuses `--pilot` and `--first-run`, which are for a person.

An automatic run that finds an unfinished earlier run still syncs, sweeps, refreshes profiles and checks media, but builds nothing and exits with status 2, so unfinished runs never pile up. `npm run status` lists the unfinished runs. To clear one, sign and publish it, or delete its folder under `out/` if you mean to abandon it.

### Recovery

- **A publish stopped partway.** Run it again: `npm run publish -- <run>`. Events a relay already accepted are not sent twice. To fill one relay only, name it: `npm run publish -- <run> --relays search`. `verify` then compares both relays with state.
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

Enable it only after the first native import is verified:

```bash
mkdir -p state/logs
sed "s#/Users/YOU#$HOME#g" scripts/launchd/world.brainstorm.divinebot.plist.example > ~/Library/LaunchAgents/world.brainstorm.divinebot.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/world.brainstorm.divinebot.plist
```

To test it once without waiting for 06:00: `launchctl kickstart gui/$(id -u)/world.brainstorm.divinebot`. To disable it: `launchctl bootout gui/$(id -u)/world.brainstorm.divinebot`.

An `ncryptsec` key needs `DIVINEBOT_PASSPHRASE_FILE` in the job's environment. An `nsec` key file with mode 600 needs nothing more.

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

3. Copy the example config, then set `curatorPubkey` in `config.rehearsal.json` to that public key, and set `source.harvestSince` to a unix time a few days back so only a small slice of Divine is read (three days is about 800 videos). The file is gitignored. Both target relays are the local relay, and `paths` sit under `state/rehearsal/`.

   ```bash
   cp config.rehearsal.example.json config.rehearsal.json
   ```

4. Copy Avi's header to the local relay. This reads the public header and writes only to the local relay. The templates are not needed for a build.

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

   The second `build` should write zero lines: no changes. Stop `nak serve` when done.

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
