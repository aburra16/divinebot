/** A markdown table. `|` inside a cell is escaped so it cannot break the row. */
export function table(head: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) =>
    `| ${cells.map((c) => String(c).replaceAll("|", "\\|")).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

/**
 * `text` as a markdown code span, so a name with `*`, `_` or backticks shows literally.
 * Backslash escapes do not work inside a code span, so the fence is one backtick longer than
 * the longest run inside, and padded with a space where CommonMark would otherwise eat a
 * character of the text. Line breaks become spaces, as a code span would render them anyway,
 * so a name can never start a new line of the list.
 */
export function codeSpan(text: string): string {
  const flat = text.replace(/\r\n|\r|\n/g, " ");
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const spaced = flat.startsWith(" ") && flat.endsWith(" ") && flat.trim() !== "";
  const pad = flat.startsWith("`") || flat.endsWith("`") || spaced ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** A bullet list, or `none` for an empty one. */
export function bullets(lines: string[]): string {
  return lines.length === 0 ? "none" : lines.map((l) => `- ${l}`).join("\n");
}
