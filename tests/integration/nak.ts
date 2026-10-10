import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;

/** True when something on loopback accepts a TCP connection on `port`. */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts an in-memory `nak serve` relay on loopback `port` and resolves once the port accepts
 * connections. Refuses a port that is already taken, so a test never talks to a stale relay
 * left over from another run. `stop()` kills the relay and waits for it to exit.
 *
 * nak logs every connection and event. The log goes to a file, never a pipe: a pipe nobody
 * drains (the test process blocked in spawnSync, say) fills up and freezes the relay.
 */
export async function startNak(port: number): Promise<{ url: string; stop(): Promise<void> }> {
  if (await portOpen(port)) throw new Error(`port ${port} is already in use; stop whatever holds it`);

  const logDir = mkdtempSync(join(tmpdir(), "divinebot-nak-"));
  const logPath = join(logDir, "nak.log");
  const log = openSync(logPath, "w");
  const child = spawn("nak", ["serve", "--port", String(port), "--hostname", HOST], {
    stdio: ["ignore", log, log],
  });
  closeSync(log); // the child holds its own copy
  const logText = () => readFileSync(logPath, "utf8").trim();

  let spawnError: Error | undefined;
  child.once("error", (err) => {
    spawnError = err;
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const running = () => child.exitCode === null && child.signalCode === null && spawnError === undefined;

  const stop = async (): Promise<void> => {
    if (running()) {
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(killer);
    }
    rmSync(logDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await portOpen(port))) {
    if (spawnError !== undefined) {
      await stop();
      throw new Error(`cannot start nak (is it on PATH?): ${spawnError.message}`);
    }
    if (!running()) {
      const why = logText();
      await stop();
      throw new Error(`nak serve exited before listening on ${port}: ${why}`);
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`nak serve did not listen on ${port} within ${START_TIMEOUT_MS / 1000} s`);
    }
    await pause(50);
  }
  return { url: `ws://${HOST}:${port}`, stop };
}
