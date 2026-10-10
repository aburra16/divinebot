export interface PilotCandidate {
  d: string;
  pubkey: string;
  /** The item's `published` date, `YYYY-MM-DD`; its first 7 characters are the month. */
  published: string;
}

/** Videos one creator may have in a pilot. */
const PER_CREATOR = 2;

const byD = (a: PilotCandidate, b: PilotCandidate) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0);

/**
 * A deterministic pilot of at most `n` items, as `d` values. Candidates are grouped by
 * `published` month, each month in `d` order; the months, in order, take turns giving their next
 * candidate whose creator has fewer than two picks so far, until `n` are taken or none are left.
 * The result does not depend on the order of `candidates`.
 */
export function selectPilot(candidates: PilotCandidate[], n: number): string[] {
  const months = new Map<string, PilotCandidate[]>();
  for (const c of [...candidates].sort(byD)) {
    const month = c.published.slice(0, 7);
    const list = months.get(month);
    if (list === undefined) months.set(month, [c]);
    else list.push(c);
  }
  const queues = [...months.keys()].sort().map((m) => ({ list: months.get(m)!, next: 0 }));

  const picked: string[] = [];
  const seen = new Set<string>();
  const perCreator = new Map<string, number>();
  const limit = Math.max(0, n);
  let active = queues;
  while (picked.length < limit && active.length > 0) {
    for (const q of active) {
      if (picked.length >= limit) break;
      while (q.next < q.list.length) {
        const c = q.list[q.next++]!;
        const count = perCreator.get(c.pubkey) ?? 0;
        if (count >= PER_CREATOR || seen.has(c.d)) continue;
        perCreator.set(c.pubkey, count + 1);
        seen.add(c.d);
        picked.push(c.d);
        break;
      }
    }
    active = active.filter((q) => q.next < q.list.length);
  }
  return picked;
}
