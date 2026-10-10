import { createHash } from "node:crypto";
import { tagValue, type Tags } from "./tags.js";

/** What the diff reads of a live item recorded in state: its change hash and stored tags. */
export interface LiveItem {
  contentHash: string;
  tagsJson: string;
}

/**
 * The change hash of an item: sha256 hex of its tags as JSON. `created_at` is not part of
 * the tags, so re-signing the same item never looks like a change.
 */
export function contentHash(tags: Tags): string {
  return createHash("sha256").update(JSON.stringify(tags)).digest("hex");
}

export interface Diff {
  /** Built items with no live item of the same `d`, sorted by `d`. */
  created: Tags[];
  /** Built items whose hash differs from the live item's, sorted by `d`. */
  changed: Tags[];
  unchanged: number;
  /** `d` values that are live but were not built, sorted. Always empty without `detectGone`. */
  gone: string[];
}

/**
 * Compares built items (keyed by `d`) with the live items in state. Only a build that saw
 * every video may call a live item gone, so a pilot build passes `detectGone: false`. A `held`
 * d (its record is still in the fetch but could not be read) is never gone.
 */
export function diffItems(
  built: Map<string, Tags>,
  live: Map<string, LiveItem>,
  opts: { detectGone: boolean; held?: ReadonlySet<string> },
): Diff {
  const diff: Diff = { created: [], changed: [], unchanged: 0, gone: [] };
  for (const d of [...built.keys()].sort()) {
    const tags = built.get(d)!;
    const current = live.get(d);
    if (current === undefined) diff.created.push(tags);
    else if (current.contentHash !== contentHash(tags)) diff.changed.push(tags);
    else diff.unchanged++;
  }
  if (opts.detectGone) {
    diff.gone = [...live.keys()].filter((d) => !built.has(d) && !opts.held?.has(d)).sort();
  }
  return diff;
}

/** The tags stored for an item (state's `tagsJson`), or none if the text is not a list of string tags. */
export function parseTags(json: string): Tags {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string[] => Array.isArray(t) && t.every((v) => typeof v === "string"));
  } catch {
    return [];
  }
}

/**
 * The tag names whose tags differ between `before` and `after`, sorted. The tags of one name
 * are compared as a group, in order, so a value added, removed or modified all count as
 * differing. This is the one definition of "changed field" the console and `build` share.
 */
export function changedFields(before: Tags, after: Tags): string[] {
  const byName = (tags: Tags): Map<string, string> => {
    const groups = new Map<string, Tags>();
    for (const tag of tags) {
      const name = tag[0] ?? "";
      groups.set(name, [...(groups.get(name) ?? []), tag]);
    }
    return new Map([...groups].map(([name, group]) => [name, JSON.stringify(group)]));
  };
  const was = byName(before);
  const now = byName(after);
  return [...new Set([...was.keys(), ...now.keys()])].filter((name) => was.get(name) !== now.get(name)).sort();
}

/** A changed item for the report: its `d`, its new name if it has one, and the tag names that differ. */
export interface ChangedItem {
  d: string;
  name?: string;
  fields: string[];
}

export interface ChangeSummary {
  /**
   * Per tag name, the number of changed items where that tag differs from the live item's:
   * most items first, ties by name. A change in how items are built shows up here as one tag with a huge count.
   */
  counts: { field: string; items: number }[];
  /** The first `examples` changed items, in the order given (`diffItems` gives them by `d`). */
  examples: ChangedItem[];
}

/**
 * Compares each changed item with the live item of the same `d` through `changedFields`, the
 * same function the console uses. A live item whose stored tags cannot be read counts as
 * having none, so every tag of the new item differs.
 */
export function summarizeChanges(
  changed: readonly Tags[],
  live: ReadonlyMap<string, LiveItem>,
  examples = 10,
): ChangeSummary {
  const counts = new Map<string, number>();
  const shown: ChangedItem[] = [];
  for (const tags of changed) {
    const d = tagValue(tags, "d") ?? "";
    const fields = changedFields(parseTags(live.get(d)?.tagsJson ?? "[]"), tags);
    for (const field of fields) counts.set(field, (counts.get(field) ?? 0) + 1);
    if (shown.length < examples) {
      const name = tagValue(tags, "name");
      shown.push(name === undefined ? { d, fields } : { d, name, fields });
    }
  }
  return {
    counts: [...counts]
      .map(([field, items]) => ({ field, items }))
      .sort((a, b) => b.items - a.items || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)),
    examples: shown,
  };
}
