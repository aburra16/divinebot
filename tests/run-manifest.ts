import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { IdentitySource } from "../src/manifest.js";

/**
 * Writes `<runDir>/manifest.json` with the config block `build` records for `cfg`, then
 * `over` on top of it, so a test can stand in for a run built with another config.
 */
export function writeManifest(runDir: string, cfg: IdentitySource, over: Record<string, unknown> = {}): void {
  mkdirSync(runDir, { recursive: true });
  const config = {
    headerCoordinate: cfg.headerCoordinate,
    curatorPubkey: cfg.curatorPubkey,
    templateIds: cfg.templateIds,
    relays: cfg.relays,
    scope: cfg.scope,
    ...over,
  };
  writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify({ runId: basename(runDir), config }, null, 2)}\n`);
}
