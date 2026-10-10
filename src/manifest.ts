import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

/**
 * The parts of a config that decide where a run's events go and what they mean: the list, the
 * signer, the templates the items point to, the relays and the scope of what is built. `build`
 * writes this block into `manifest.json` as `config`, and `sign` and `publish` refuse a run
 * whose block differs from the config they were started with. So a rehearsal run is never
 * signed or published with the real config, nor a real run with the rehearsal one.
 */
export interface ConfigIdentity {
  headerCoordinate: string;
  curatorPubkey: string;
  /** The template event ids by template name. */
  templateIds: Record<string, string>;
  relays: Record<string, string>;
  /** `scope` as the config spells it. */
  scope: Record<string, unknown>;
}

/** The parts of a config the identity is made from. */
export type IdentitySource = Pick<Config, "headerCoordinate" | "curatorPubkey" | "templateIds" | "relays" | "scope">;

const FIELDS = ["headerCoordinate", "curatorPubkey", "templateIds", "relays", "scope"] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** An object's entries sorted by key, so the order a config lists them in never counts as a difference. */
function sortedKeys<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as T;
}

export function configIdentity(cfg: IdentitySource): ConfigIdentity {
  return {
    headerCoordinate: cfg.headerCoordinate,
    curatorPubkey: cfg.curatorPubkey,
    templateIds: sortedKeys(cfg.templateIds),
    relays: sortedKeys(cfg.relays),
    scope: sortedKeys(cfg.scope),
  };
}

/** One field as compared and shown: JSON text, with an object's keys in name order. */
function shown(value: unknown): string {
  return JSON.stringify(isObject(value) ? sortedKeys(value) : value) ?? "nothing";
}

/**
 * Refuses unless `<runDir>/manifest.json` exists, is JSON and records a `config` block equal,
 * field by field, to `cfg`'s identity. A run with no manifest, or one written before the
 * manifest held a config block, is refused too: nothing then says which config built it.
 * The message names the first field that differs and both values.
 */
export function checkRunConfig(cfg: IdentitySource, runDir: string): void {
  const path = join(runDir, "manifest.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${path} not found, so nothing says which config built this run; build it again with npm run build`);
    }
    throw err;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON; build the run again with npm run build`);
  }
  const recorded = isObject(manifest) ? manifest.config : undefined;
  if (!isObject(recorded)) {
    throw new Error(
      `${path} records no config, so nothing says which config built this run; build it again with npm run build`,
    );
  }
  const current = configIdentity(cfg);
  for (const field of FIELDS) {
    const was = shown(recorded[field]);
    const now = shown(current[field]);
    if (was !== now) {
      throw new Error(
        `${runDir} was built with another config: ${field} is ${was} in ${path}, but ${now} in the config ` +
          "now loaded; check DIVINEBOT_CONFIG, or build a new run with this config",
      );
    }
  }
}

/**
 * The relay names a run was built for: the keys of `config.relays` in `<runDir>/manifest.json`.
 * Undefined when the manifest cannot be read or records no relays, so the caller can fall back
 * to its own. Reads only; `checkRunConfig` is what refuses a run.
 */
export function manifestRelays(runDir: string): string[] | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
    const relays = isObject(manifest) && isObject(manifest.config) ? manifest.config.relays : undefined;
    const names = isObject(relays) ? Object.keys(relays) : [];
    return names.length > 0 ? names : undefined;
  } catch {
    return undefined;
  }
}
