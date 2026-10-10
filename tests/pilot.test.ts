import { describe, expect, it } from "vitest";
import { selectPilot } from "../src/pilot.js";

type Candidate = { d: string; pubkey: string; published: string };

const pk = (i: number) => i.toString(16).padStart(64, "0");

describe("selectPilot", () => {
  it("takes at most two videos from one creator", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({ d: `d${i}`, pubkey: pk(1), published: "2026-01-0" + (i % 9 + 1) }));
    const picked = selectPilot(candidates, 5);
    expect(picked).toHaveLength(2);
  });

  it("gives the same picks for the same candidates, in any input order", () => {
    const candidates: Candidate[] = Array.from({ length: 40 }, (_, i) => ({
      d: `divine-${pk(i % 13)}-${i}`,
      pubkey: pk(i % 13),
      published: `2026-0${(i % 4) + 1}-15`,
    }));
    const first = selectPilot(candidates, 12);
    expect(selectPilot(candidates, 12)).toEqual(first);
    expect(selectPilot([...candidates].reverse(), 12)).toEqual(first);
    expect(first).toHaveLength(12);
  });

  it("spreads 150 picks from 300 candidates over every month", () => {
    const months = ["2025-03", "2025-06", "2025-09", "2025-12", "2026-03", "2026-06"];
    // 150 creators with two videos each; months skewed so most videos sit in the first month.
    const candidates: Candidate[] = Array.from({ length: 300 }, (_, i) => ({
      d: `d${String(i).padStart(3, "0")}`,
      pubkey: pk(Math.floor(i / 2)),
      published: `${i < 250 ? months[0] : months[1 + (i % 5)]}-01`,
    }));
    const picked = selectPilot(candidates, 150);
    expect(picked).toHaveLength(150);
    const byD = new Map(candidates.map((c) => [c.d, c]));
    const pickedMonths = new Set(picked.map((d) => byD.get(d)!.published.slice(0, 7)));
    expect([...pickedMonths].sort()).toEqual(months);

    const perCreator = new Map<string, number>();
    for (const d of picked) {
      const p = byD.get(d)!.pubkey;
      perCreator.set(p, (perCreator.get(p) ?? 0) + 1);
    }
    expect(Math.max(...perCreator.values())).toBeLessThanOrEqual(2);
    expect(new Set(picked).size).toBe(150);
  });

  it("returns every allowed candidate when asked for more than there are", () => {
    const candidates = [
      { d: "b", pubkey: pk(1), published: "2026-01-01" },
      { d: "a", pubkey: pk(2), published: "2026-02-01" },
    ];
    expect([...selectPilot(candidates, 10)].sort()).toEqual(["a", "b"]);
    expect(selectPilot(candidates, 0)).toEqual([]);
  });
});
