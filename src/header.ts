import type { AbstractRelay } from "nostr-tools/abstract-relay";
import type { NostrEvent } from "nostr-tools/core";
import type { Config } from "./config.js";
import { connectRelay, newer, query, withSearch } from "./relay.js";

const HEADER_KIND = 39998;
/** The fields every item this tool builds carries, in the order the header must list them. */
const REQUIRED_FIELDS = ["title", "video"];
const DEFAULT_TIMEOUT_MS = 10_000;

/** Splits `<kind>:<pubkey>:<d>`; the `d` part may itself contain colons. */
function parseCoordinate(coordinate: string): { kind: number; pubkey: string; d: string } {
  const first = coordinate.indexOf(":");
  const second = coordinate.indexOf(":", first + 1);
  const kind = Number(coordinate.slice(0, first));
  if (first < 0 || second < 0 || !Number.isInteger(kind)) {
    throw new Error(`not an address coordinate: ${coordinate}`);
  }
  return { kind, pubkey: coordinate.slice(first + 1, second), d: coordinate.slice(second + 1) };
}

/**
 * Reads the header at `coordinate` from one relay: the newest matching event, or null when
 * the relay has none. Throws if the relay cannot be reached or does not answer within
 * `timeoutMs`, so a slow relay is never mistaken for a missing header. `search` is the NIP-50
 * string a relay that refuses a plain REQ needs (see `relayReadSearch`).
 */
export async function fetchHeader(
  relayUrl: string,
  coordinate: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  search?: string,
): Promise<NostrEvent | null> {
  const { kind, pubkey, d } = parseCoordinate(coordinate);
  let relay: AbstractRelay | undefined;
  try {
    relay = await connectRelay(relayUrl, timeoutMs);
    const filter = withSearch({ kinds: [kind], authors: [pubkey], "#d": [d] }, search);
    const found = await query(relay, filter, timeoutMs);
    return found.reduce<NostrEvent | null>((best, ev) => newer(ev, best), null);
  } catch (err) {
    throw new Error(`cannot read the header: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    relay?.close();
  }
}

/**
 * Throws unless `ev` is the header at `cfg.headerCoordinate` (kind 39998, same author and `d`),
 * its `required` fields are exactly `title` then `video`, and its `link` tags bind the
 * `divine-video` template's `id` to `divine-id` and the `divine-profile` template's `npub` to
 * `creator-npub`: the shape the items and profiles are built for.
 */
export function checkHeader(ev: NostrEvent | null, cfg: Config): asserts ev is NostrEvent {
  const coordinate = cfg.headerCoordinate;
  const { pubkey, d } = parseCoordinate(coordinate);
  if (ev === null) throw new Error(`header ${coordinate} not found`);
  if (ev.kind !== HEADER_KIND) {
    throw new Error(`header ${coordinate}: kind is ${ev.kind}, expected ${HEADER_KIND}`);
  }
  if (ev.pubkey !== pubkey) {
    throw new Error(`header ${coordinate}: author is ${ev.pubkey}, expected ${pubkey}`);
  }
  const evD = ev.tags.find((t) => t[0] === "d")?.[1];
  if (evD !== d) throw new Error(`header ${coordinate}: d is "${evD ?? ""}", expected "${d}"`);

  const required = ev.tags.filter((t) => t[0] === "required" && t[1] !== undefined).map((t) => t[1]!);
  if (required.join(",") !== REQUIRED_FIELDS.join(",")) {
    throw new Error(
      `header ${coordinate}: required fields are [${required.join(", ")}], ` +
        `expected [${REQUIRED_FIELDS.join(", ")}]; the item shape must be revisited before building`,
    );
  }

  const checkLink = (templateField: string, itemField: string, templateId: string): void => {
    const link = ev.tags.find((t) => t[0] === "link" && t[4] === itemField);
    if (link === undefined) {
      throw new Error(`header ${coordinate}: no link binds ${templateField} to ${itemField}`);
    }
    if (link[3] !== templateField) {
      throw new Error(`header ${coordinate}: link for ${itemField} binds ${link[3] ?? ""}, expected ${templateField}`);
    }
    if (link[1] !== templateId) {
      throw new Error(
        `header ${coordinate}: link for ${itemField} points to template ${link[1] ?? ""}, expected ${templateId}`,
      );
    }
  };
  checkLink("id", "divine-id", cfg.templateIds["divine-video"]);
  checkLink("npub", "creator-npub", cfg.templateIds["divine-profile"]);
}
