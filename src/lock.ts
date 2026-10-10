import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** A lock older than this is taken to belong to a run that died without cleaning up. */
const STALE_MS = 6 * 3_600_000;

export interface LockOptions {
  /** Milliseconds since the epoch. Defaults to the wall clock. */
  now?: () => number;
  /** Takes the warning about a stale lock. Defaults to a line on stderr. */
  warn?: (message: string) => void;
}

const isCode = (err: unknown, code: string): boolean => (err as NodeJS.ErrnoException).code === code;

/** Creates `path` only if it does not exist (O_EXCL) and writes the pid and the ISO time into it. */
function create(path: string, now: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if (isCode(err, "EEXIST")) return false;
    throw err;
  }
  try {
    writeSync(fd, `${process.pid}\n${new Date(now).toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Who holds the lock and since when, from its content; the file's own mtime if the content is unreadable. */
function holder(path: string): { pid: string; since: number } {
  let pid = "an unknown process";
  let since: number | undefined;
  try {
    const [first, second] = readFileSync(path, "utf8").split("\n");
    if (first !== undefined && /^\d+$/.test(first)) pid = first;
    const parsed = Date.parse(second ?? "");
    if (Number.isFinite(parsed)) since = parsed;
  } catch {
    // Read below from the mtime.
  }
  if (since === undefined) {
    try {
      since = statSync(path).mtimeMs;
    } catch {
      since = 0; // gone between the two calls: the next create will succeed
    }
  }
  return { pid, since };
}

/**
 * Runs `fn` holding the lock file at `path`. The file is created exclusively (a second holder
 * fails at once), holds the pid and the ISO time, and is removed when `fn` ends, however it
 * ends. A lock more than 6 hours old is stale: it is warned about and replaced. Moving it
 * aside first means that of two runs finding the same stale lock, only one replaces it.
 */
export async function withLock<T>(path: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  mkdirSync(dirname(path), { recursive: true });

  if (!create(path, now())) {
    const { pid, since } = holder(path);
    const age = now() - since;
    if (age <= STALE_MS) {
      throw new Error(
        `another run holds the lock ${path} (process ${pid}, since ${new Date(since).toISOString()}); ` +
          "wait for it to finish, or delete the file if no run is going",
      );
    }
    warn(`the lock ${path} is older than 6 hours (process ${pid}, since ${new Date(since).toISOString()}); treating it as stale and replacing it`);
    const aside = `${path}.stale-${process.pid}`;
    try {
      renameSync(path, aside);
      rmSync(aside, { force: true });
    } catch (err) {
      if (!isCode(err, "ENOENT")) throw err;
    }
    if (!create(path, now())) {
      throw new Error(`another run took the lock ${path} while it was being replaced; try again`);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
