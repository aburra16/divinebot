import type { Config } from "../config.js";
import { connectRelay, publishEvent } from "../relay.js";
import { readHeaderAndTemplates } from "./rebroadcast.js";

/** Where the rehearsal's local `nak serve` listens unless told otherwise. */
export const DEFAULT_REHEARSAL_TARGET = "ws://127.0.0.1:10547";

/**
 * The target URL when it is a plain `ws://` URL on the loopback interface (127.0.0.1, [::1] or
 * localhost), otherwise a throw. The seed script publishes events, so it must never reach a
 * public relay, whatever it is given.
 */
export function loopbackTarget(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} is not a URL`);
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname);
  if (parsed.protocol !== "ws:" || !loopback || parsed.username !== "" || parsed.password !== "") {
    throw new Error(`refusing ${url}: the target must be a ws:// URL on 127.0.0.1, [::1] or localhost`);
  }
  return url;
}

/**
 * Reads the live header and both templates from the header relay in `cfg` (the production
 * config, so dcosl) and publishes them, unchanged and never re-signed, to the loopback relay at
 * `target`. The rehearsal's `build` needs the header on its own relay. Reads from the public
 * relay, writes only to the local one.
 */
export async function rehearsalSeed(
  cfg: Config,
  target: string,
): Promise<{ eventId: string; ok: boolean; message: string }[]> {
  const url = loopbackTarget(target);
  const events = await readHeaderAndTemplates(cfg);
  const relay = await connectRelay(url, cfg.publish.okTimeoutMs);
  try {
    const results: { eventId: string; ok: boolean; message: string }[] = [];
    for (const ev of events) {
      results.push({ eventId: ev.id, ...(await publishEvent(relay, ev, cfg.publish.okTimeoutMs)) });
    }
    return results;
  } finally {
    relay.close();
  }
}
