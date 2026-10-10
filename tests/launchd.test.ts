import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("scripts/launchd/run-divinebot.sh");
const PLIST = resolve("scripts/launchd/world.brainstorm.divinebot.plist.example");
const hasPlutil = spawnSync("which", ["plutil"]).status === 0;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "divinebot-launchd-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("run-divinebot.sh", () => {
  it("parses", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("when it cannot find or enter its repo, logs to ~/Library/Logs/divinebot.log, notifies and exits 1", () => {
    // Fed on stdin, the script has no path of its own, so it cannot find the repo two folders
    // above it; the same branch runs when macOS privacy keeps it out of a checkout under ~/Documents.
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    const notified = join(dir, "notified.txt");
    writeFileSync(join(bin, "osascript"), `#!/bin/bash\nprintf '%s\\n' "$@" > "${notified}"\n`, { mode: 0o755 });

    const res = spawnSync("bash", ["-c", `exec bash < "${SCRIPT}"`], {
      cwd: dir,
      encoding: "utf8",
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    });

    expect(res.status).toBe(1);
    const log = readFileSync(join(home, "Library", "Logs", "divinebot.log"), "utf8");
    expect(log).toMatch(/divinebot could not open its folder/);
    expect(log).toMatch(/Full Disk Access/);
    expect(readFileSync(notified, "utf8")).toMatch(/divinebot could not open its folder/);
    // Nothing was run and nothing was written where the repo would be.
    expect(existsSync(join(dir, "state"))).toBe(false);
  });
});

describe("the launchd plist example", () => {
  it.skipIf(!hasPlutil)("is a valid plist as shipped", () => {
    const res = spawnSync("plutil", ["-lint", PLIST], { encoding: "utf8" });
    expect(res.stdout + res.stderr).toMatch(/OK/);
    expect(res.status).toBe(0);
  });

  it.skipIf(!hasPlutil)("is still valid with the EnvironmentVariables block uncommented", () => {
    const text = readFileSync(PLIST, "utf8");
    const open = "<!-- EnvironmentVariables: remove this line and the closing line below to use it.";
    const close = "End of EnvironmentVariables. -->";
    expect(text).toContain(open);
    expect(text).toContain(close);
    const uncommented = text
      .split("\n")
      .filter((line) => line.trim() !== open && line.trim() !== close)
      .join("\n");
    expect(uncommented).toContain("<key>EnvironmentVariables</key>");
    const copy = join(dir, "uncommented.plist");
    writeFileSync(copy, uncommented);
    const res = spawnSync("plutil", ["-lint", copy], { encoding: "utf8" });
    expect(res.stdout + res.stderr).toMatch(/OK/);
    expect(res.status).toBe(0);
    const json = spawnSync("plutil", ["-convert", "json", "-o", "-", copy], { encoding: "utf8" });
    expect(JSON.parse(json.stdout).EnvironmentVariables).toHaveProperty("DIVINEBOT_KEY_FILE");
  });
});
