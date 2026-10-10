import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { manifestRelays } from "./manifest.js";
import type { State } from "./state.js";

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

/** The event ids of `signed.jsonl`, one per line, and nothing else read from the line. */
function signedIds(runDir: string): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(join(runDir, "signed.jsonl"), "utf8");
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop(); // the newline that ends the last line
  return lines.map((line, i) => {
    let id: unknown;
    try {
      id = (JSON.parse(line) as { id?: unknown } | null)?.id;
    } catch {
      // Not JSON: reported below with the other lines that carry no id.
    }
    if (typeof id !== "string" || id === "") {
      throw new Error(`signed.jsonl line ${i + 1} is not a nostr event with an id`);
    }
    return id;
  });
}

interface Unpublished {
  /** What is not yet published, as short phrases; none when the run is complete or has nothing to publish. */
  missing: string[];
  /** The relays that lack some of a signed run's events, for the publish command that finishes it. */
  shortRelays: string[];
}

function unpublishedOf(cfg: Config, state: State, runDir: string): Unpublished {
  const ids = signedIds(runDir);
  if (ids === undefined) {
    try {
      // A run that holds no events (a rebuild that found nothing to do) can never be signed.
      return { missing: statSync(join(runDir, "unsigned.jsonl")).size > 0 ? ["not signed"] : [], shortRelays: [] };
    } catch (err) {
      if (isMissing(err)) return { missing: [], shortRelays: [] };
      throw err;
    }
  }
  const result: Unpublished = { missing: [], shortRelays: [] };
  for (const relay of manifestRelays(runDir) ?? Object.keys(cfg.relays)) {
    const short = ids.filter((id) => !state.acceptedOn(id, relay)).length;
    if (short === 0) continue;
    result.missing.push(`not published to ${relay}: ${short} of ${ids.length} events missing`);
    result.shortRelays.push(relay);
  }
  return result;
}

/**
 * One warning line for each earlier run in `<paths.out>` that was built but is not fully
 * published, in run id order: it has `unsigned.jsonl` but no `signed.jsonl` (not signed), or a
 * `signed.jsonl` whose events some relay it was built for has not accepted, per state. The
 * relays are those in the run's manifest, else the configured ones. A run some relay lacks
 * events of ends with the `publish --relays` command that sends just those. A dir without a
 * `manifest.json` is not a run and is ignored, and the scan reads `signed.jsonl` ids only.
 * Whatever cannot be read, a run dir or `out/` itself, is reported as a warning: the scan only
 * advises, so it never throws.
 */
export function earlierRunWarnings(cfg: Config, state: State): string[] {
  let names: string[];
  try {
    names = readdirSync(cfg.paths.out, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    return isMissing(err) ? [] : [`warning: could not scan ${cfg.paths.out} for earlier runs: ${reason(err)}`];
  }
  const warnings: string[] = [];
  for (const name of names) {
    const runDir = join(cfg.paths.out, name);
    try {
      if (!manifestExists(runDir)) continue;
      const { missing, shortRelays } = unpublishedOf(cfg, state, runDir);
      if (missing.length === 0) continue;
      const remedy = shortRelays.length > 0 ? `; finish it with: npm run publish -- ${name} --relays ${shortRelays.join(",")}` : "";
      warnings.push(`warning: earlier run ${name} is not fully published: ${missing.join("; ")}${remedy}`);
    } catch (err) {
      warnings.push(`warning: could not check earlier run ${name}: ${reason(err)}`);
    }
  }
  return warnings;
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Throws on anything but a missing file, such as EACCES: the caller reports it. */
function manifestExists(runDir: string): boolean {
  return statSync(join(runDir, "manifest.json"), { throwIfNoEntry: false })?.isFile() ?? false;
}
