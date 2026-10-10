import type { NostrEvent } from "nostr-tools/core";
import type { ChangeSummary } from "./diff.js";
import type { GuardResult } from "./guards.js";
import { bullets, codeSpan, table } from "./markdown.js";
import type { Tags } from "./tags.js";

/** A live item the run deletes, and why. */
export interface ReportDeletion {
  d: string;
  /** The title from the live item's stored tags, when it has one. */
  title?: string;
  reason: string;
  eventIds: number;
}

export interface ReportInput {
  runId: string;
  header: NostrEvent;
  firstRun: boolean;
  /** Set for a pilot build: the size asked for and how many new videos it chose from. */
  pilot: { size: number; candidates: number } | null;
  /** Native sources in state by status, and how many of the active ones are eligible. */
  sources: { active: number; eligible: number; deleted: number; vanished: number };
  counts: { created: number; changed: number; unchanged: number; deletions: number; keptPending: number };
  skipped: Record<string, number>;
  changes: ChangeSummary;
  /** Title of each changed item by `d`, for the examples. */
  titles: ReadonlyMap<string, string>;
  deletions: ReportDeletion[];
  guards: GuardResult[];
  /** The items this run would hold: built items for a full build, the picks for a pilot. */
  built: ReadonlyMap<string, Tags>;
}

const SAMPLE_SIZE = 20;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function label(d: string, title: string | undefined): string {
  return `${codeSpan(d)}: ${title ? codeSpan(title) : "(no title recorded)"}`;
}

function changedSection(r: ReportInput): string {
  const total = r.counts.changed;
  if (total === 0) return "none";
  return [
    `${plural(total, "changed item")}. Per tag, how many of them differ from the live item (added, removed or modified):`,
    "",
    table(["tag", "changed items"], r.changes.counts.map(({ field, items }) => [field, items])),
    "",
    "Examples, in order of d:",
    "",
    bullets(r.changes.examples.map(({ d, fields }) => `${label(d, r.titles.get(d))} (${fields.join(", ")})`)),
  ].join("\n");
}

function guardSection(guards: GuardResult[]): string {
  const breached = guards.filter((g) => !g.passed).length;
  const verdict =
    breached === 0
      ? "Every guard passes."
      : `${plural(breached, "guard")} breached. An automatic run stops here for review.`;
  const shown = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));
  return [
    verdict,
    "",
    table(
      ["guard", "limit", "actual", "result", "detail"],
      guards.map((g) => [g.guard, shown(g.limit), shown(g.actual), g.passed ? "pass" : "BREACH", g.message]),
    ),
  ].join("\n");
}

/** The first `n` items by `d`, each as a JSON array with one tag per line. */
function samples(items: ReadonlyMap<string, Tags>, n = SAMPLE_SIZE): string {
  const chosen = [...items].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, n);
  if (chosen.length === 0) return "no items";
  return chosen
    .map(([, tags]) => ["```json", "[", tags.map((t) => `  ${JSON.stringify(t)}`).join(",\n"), "]", "```"].join("\n"))
    .join("\n\n");
}

/** `report.md` for a build: what a human reads before signing the run. */
export function renderReport(r: ReportInput): string {
  const { counts } = r;
  const events = counts.created + counts.changed + counts.deletions;
  const skipped = Object.entries(r.skipped).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    `# Build ${r.runId}`,
    "",
    `- Header: ${codeSpan(r.header.id)}`,
    `- Pilot: ${r.pilot === null ? "no" : `${r.pilot.size} asked for, chosen from ${plural(r.pilot.candidates, "new video")}`}`,
    `- First run: ${r.firstRun ? "yes" : "no"}`,
    `- Deletions: ${r.pilot === null ? "looked for" : "not looked for (pilot build)"}`,
    "",
    "## Sources",
    "",
    table(
      ["native sources", "count"],
      [
        ["active", r.sources.active],
        ["active and eligible", r.sources.eligible],
        ["deleted by their author", r.sources.deleted],
        ["vanished", r.sources.vanished],
      ],
    ),
    "",
    "## Events",
    "",
    table(
      ["class", "count"],
      [
        ["created", counts.created],
        ["changed", counts.changed],
        ["unchanged", counts.unchanged],
        ["deletions", counts.deletions],
      ],
    ),
    "",
    `\`unsigned.jsonl\` holds ${plural(events, "event")}: created and changed items, then deletions. ` +
      "Unchanged items are not republished.",
    "",
    counts.keptPending === 0
      ? "No live item is waiting for a media check."
      : counts.keptPending === 1
        ? "1 live item is kept as it is while its media checks are pending."
        : `${counts.keptPending} live items are kept as they are while their media checks are pending.`,
    "",
    "## Skipped",
    "",
    "Active native videos not built this run, by reason. `media-failed`: a stored media check failed. " +
      "`media-pending`: a new video whose media checks have not passed yet.",
    "",
    skipped.length === 0 ? "none" : table(["reason", "videos"], skipped),
    "",
    "## Changed fields",
    "",
    changedSection(r),
    "",
    "## Deletions",
    "",
    r.pilot !== null
      ? "not looked for (pilot build)"
      : bullets(
          r.deletions.map(
            ({ d, title, reason, eventIds }) => `${label(d, title)} (${reason}; ${plural(eventIds, "event id")})`,
          ),
        ),
    "",
    "## Guards",
    "",
    guardSection(r.guards),
    "",
    `## Sample items (first ${SAMPLE_SIZE} by d)`,
    "",
    samples(r.built),
    "",
  ].join("\n");
}
