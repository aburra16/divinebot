// npm run rehearsal:seed [-- ws://127.0.0.1:10547]
// Copies Avi's header and both URL templates from dcosl to the rehearsal's local relay.
// Reads the public relay named in config.json; writes only to a loopback ws:// URL.
import { loadConfig } from "../src/config.js";
import { DEFAULT_REHEARSAL_TARGET, loopbackTarget, rehearsalSeed } from "../src/commands/rehearsal-seed.js";

const [arg, ...extra] = process.argv.slice(2);
try {
  if (extra.length > 0) throw new Error("usage: npm run rehearsal:seed [-- <ws://127.0.0.1:port>]");
  const target = loopbackTarget(arg ?? DEFAULT_REHEARSAL_TARGET);
  // The production config on purpose: it names the real header relay. DIVINEBOT_CONFIG is ignored.
  const results = await rehearsalSeed(loadConfig("config.json"), target);
  const refused = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${target}: ${r.eventId} ${r.ok ? "accepted" : "refused"}${r.message === "" ? "" : ` (${r.message})`}`);
  if (refused.length > 0) throw new Error(`${target} refused ${refused.length} of ${results.length} events`);
} catch (err) {
  console.error(`rehearsal:seed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
