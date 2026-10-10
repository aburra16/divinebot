import type { Tags } from "./tags.js";

/** An event before signing; `sign` adds `created_at`, `pubkey`, `id` and `sig`. */
export type Unsigned = { kind: number; tags: Tags; content: string };

const ITEM_KIND = 39999;
const DELETION_KIND = 5;

/**
 * The NIP-09 deletion of item `d`: one `e` tag per distinct version id, in the order given,
 * then the item's `a` coordinate and `["k","39999"]`. The `e` tags are what count, because
 * dcosl's strfry honors only `e`, so every version ever published must be named.
 */
export function deletionFor(d: string, versionIds: string[], curatorPubkey: string): Unsigned {
  const ids = [...new Set(versionIds)];
  if (ids.length === 0) {
    throw new Error(`cannot delete ${d}: no event ids are recorded for it`);
  }
  return {
    kind: DELETION_KIND,
    tags: [
      ...ids.map((id) => ["e", id]),
      ["a", `${ITEM_KIND}:${curatorPubkey}:${d}`],
      ["k", String(ITEM_KIND)],
    ],
    content: "",
  };
}
