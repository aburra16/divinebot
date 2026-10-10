import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as nip19 from "nostr-tools/nip19";
import { givenOptions, parseArgs, type CliArgs } from "./args.js";
import { build, runDirFor } from "./commands/build.js";
import { profilePublish } from "./commands/profile-publish.js";
import { publish, type RelayPublishResult } from "./commands/publish.js";
import { rebroadcast } from "./commands/rebroadcast.js";
import { buildSummary, publishSummary, runPipeline, shortRelays, syncSummary } from "./commands/run.js";
import { sign } from "./commands/sign.js";
import { status } from "./commands/status.js";
import { verify, verifySummary, type RelayVerifyResult } from "./commands/verify.js";
import { loadConfig, type Config } from "./config.js";
import { earlierRunWarnings } from "./earlier-runs.js";
import { withLock } from "./lock.js";
import { runMediaChecks } from "./media.js";
import { refreshProfiles } from "./profiles.js";
import { sweep } from "./source/sweep.js";
import { sync } from "./source/sync.js";
import { openState, type State } from "./state.js";

/** A command returns the exit code it wants, or nothing for 0. */
type Command = (args: CliArgs) => Promise<number | void>;

/** Refuses any option outside `allowed`. */
function allowOptions(name: string, args: CliArgs, allowed: string[] = []): void {
  const refused = givenOptions(args).filter((o) => !allowed.includes(o));
  if (refused.length > 0) throw new Error(`${name} does not take ${refused.join(", ")}`);
}

/** Refuses positional arguments and any option outside `allowed`. */
function only(name: string, args: CliArgs, allowed: string[] = []): void {
  if (args.positional.length > 0) throw new Error(`${name} takes no arguments, got ${args.positional.join(" ")}`);
  allowOptions(name, args, allowed);
}

/** `--pilot` alone means the configured pilot size. */
const pilotSize = (cfg: Config, args: CliArgs): number | undefined => (args.pilot === "default" ? cfg.pilotSize : args.pilot);

/** The one run a command works on: a run id (a name under `paths.out`), or a path to the run dir. */
function runDirArg(name: string, cfg: Config, args: CliArgs): string {
  const [run, ...extra] = args.positional;
  if (run === undefined || extra.length > 0) throw new Error(`usage: npm run ${name} -- <runId or run dir>`);
  return /[\\/]/.test(run) ? resolve(run) : runDirFor(cfg, run);
}

/** Opens state, runs `fn` on it and closes it however `fn` ends. */
async function withState<T>(cfg: Config, fn: (state: State) => Promise<T> | T): Promise<T> {
  const state = openState(cfg.paths.state);
  try {
    return await fn(state);
  } finally {
    state.close();
  }
}

/**
 * `withState` under the lock `run` holds, so no command works on state or run dirs while another
 * does (spec 7.3: runs never overlap). `run` takes the lock itself, and the lock is not
 * re-entrant, so it uses `withState`.
 */
const withStateLocked = <T>(cfg: Config, fn: (state: State) => Promise<T> | T): Promise<T> =>
  withLock(`${cfg.paths.state}.lock`, () => withState(cfg, fn));

/** Commands by script name, as in package.json. */
const commands = new Map<string, Command>([
  [
    "sync",
    async (args) => {
      only("sync", args);
      const cfg = loadConfig();
      console.log(syncSummary(await withStateLocked(cfg, (state) => sync(cfg, state))));
    },
  ],
  [
    "sweep",
    async (args) => {
      only("sweep", args);
      const cfg = loadConfig();
      const r = await withStateLocked(cfg, (state) => sweep(cfg, state));
      console.log(`saw ${r.seen} videos, ${r.vanished.length} newly vanished`);
    },
  ],
  [
    "media",
    async (args) => {
      only("media", args);
      const cfg = loadConfig();
      const r = await withStateLocked(cfg, (state) => runMediaChecks(cfg, state));
      console.log(`checked ${r.checked}, passed ${r.passed}, failed ${r.failed}, inconclusive ${r.inconclusive}`);
      if (r.outage) console.log("so many checks failed that the host looks down, so no failure was recorded");
    },
  ],
  [
    "profiles",
    async (args) => {
      only("profiles", args);
      const cfg = loadConfig();
      const r = await withStateLocked(cfg, (state) => refreshProfiles(cfg, state));
      console.log(`read ${r.fetched} profiles, verified ${r.verified} handles`);
    },
  ],
  [
    "build",
    async (args) => {
      only("build", args, ["--pilot", "--first-run"]);
      const cfg = loadConfig();
      const r = await withStateLocked(cfg, (state) => {
        for (const warning of earlierRunWarnings(cfg, state)) console.warn(warning);
        return build(cfg, state, { pilot: pilotSize(cfg, args), firstRun: args.firstRun });
      });
      for (const line of buildSummary(r)) console.log(line);
      console.log(`review ${r.runDir}/report.md before signing`);
    },
  ],
  [
    "sign",
    async (args) => {
      allowOptions("sign", args);
      const cfg = loadConfig();
      const runDir = runDirArg("sign", cfg, args);
      const r = await withLock(`${cfg.paths.state}.lock`, () => sign(cfg, runDir));
      console.log(`signed ${r.signed} events into ${runDir}/signed.jsonl`);
      console.log(`signer npub ${nip19.npubEncode(r.pubkey)}`);
    },
  ],
  [
    "publish",
    async (args) => {
      allowOptions("publish", args, ["--relays"]);
      const cfg = loadConfig();
      const runDir = runDirArg("publish", cfg, args);
      const results: Record<string, RelayPublishResult> = await withStateLocked(cfg, (state) =>
        publish(cfg, state, runDir, args.relays),
      );
      for (const line of publishSummary(results)) console.log(line);
      const short = shortRelays(results);
      if (short.length > 0) {
        throw new Error(`not every event was accepted on ${short.join(", ")}; run publish again to retry the rest`);
      }
    },
  ],
  [
    "verify",
    async (args) => {
      only("verify", args);
      const cfg = loadConfig();
      const results: Record<string, RelayVerifyResult> = await withStateLocked(cfg, (state) => verify(cfg, state));
      const { lines, warnings, failed } = verifySummary(results);
      for (const line of lines) console.log(line);
      for (const warning of warnings) console.warn(`warning: ${warning}`);
      if (failed.length > 0) throw new Error(`relays and state do not match on ${failed.join(", ")}`);
    },
  ],
  [
    "rebroadcast",
    async (args) => {
      allowOptions("rebroadcast", args);
      const [relay, ...extra] = args.positional;
      if (extra.length > 0) throw new Error("usage: npm run rebroadcast -- [relayName]");
      const name = relay ?? "search";
      const results = await rebroadcast(loadConfig(), name);
      const refused = results.filter((r) => !r.ok);
      for (const r of results) {
        console.log(`${name}: ${r.eventId} ${r.ok ? "accepted" : "refused"}${r.message === "" ? "" : ` (${r.message})`}`);
      }
      if (refused.length > 0) throw new Error(`${name} refused ${refused.length} of ${results.length} events`);
    },
  ],
  [
    "profile:publish",
    async (args) => {
      only("profile:publish", args);
      // profile.json sits in the repo root, one level above src/, wherever the command is run from.
      const r = await profilePublish(loadConfig(), resolve(import.meta.dirname, "..", "profile.json"));
      const refused: string[] = [];
      for (const [url, result] of Object.entries(r.results)) {
        console.log(`${url}: ${result.ok ? "accepted" : "refused"}${result.message === "" ? "" : ` (${result.message})`}`);
        if (!result.ok) refused.push(url);
      }
      console.log(`profile event ${r.eventId}`);
      if (refused.length > 0) throw new Error(`the profile was not accepted on ${refused.join(", ")}; run profile:publish again`);
    },
  ],
  [
    "run",
    async (args) => {
      only("run", args, ["--auto", "--pilot", "--first-run"]);
      const cfg = loadConfig();
      const outcome = await withState(cfg, (state) =>
        runPipeline(cfg, state, { auto: args.auto === true, pilot: pilotSize(cfg, args), firstRun: args.firstRun }),
      );
      return outcome.exitCode;
    },
  ],
  [
    "status",
    async (args) => {
      only("status", args);
      const cfg = loadConfig();
      console.log((await withState(cfg, (state) => status(cfg, state))).trimEnd());
    },
  ],
]);

const USAGE = `usage: npm run <${[...commands.keys()].join("|")}> -- [options]`;

/** Runs one command for `argv` and returns the process exit code: 0, 1 for an error, 2 for a bad command or a run that needs review. */
export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : commands.get(name);
  if (command === undefined) {
    console.error(name === undefined ? "no command given" : `unknown command: ${name}`);
    console.error(USAGE);
    return 2;
  }
  try {
    return (await command(parseArgs(rest))) ?? 0;
  } catch (err) {
    console.error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Only when run as a script: tests import `main` without starting a command.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
