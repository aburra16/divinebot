// Inlines the header, the URL templates and the example items into the signing page and the team review page,
// so each is one self-contained file built from the same JSON.
// Run: node header/build-page.mjs
import { readFileSync, writeFileSync } from "node:fs";
const root = new URL("../", import.meta.url);
const read = (f) => readFileSync(new URL(f, root), "utf8");
const header = JSON.stringify(JSON.parse(read("header/divine-videos.header.json")), null, 2);
const examples = JSON.stringify(JSON.parse(read("header/example-items.json")));
const templates = JSON.stringify(JSON.parse(read("header/url-templates.json")), null, 2);
for (const [from, to] of [["header/sign-header.template.html", "header/sign-header.html"], ["docs/header-review.template.html", "docs/header-review.html"]]) {
  const page = read(from).replace("/*HEADER*/", () => header).replace("/*EXAMPLES*/", () => examples).replace("/*TEMPLATES*/", () => templates);
  if (/\/\*(HEADER|EXAMPLES|TEMPLATES)\*\//.test(page)) throw new Error(`placeholder left in ${to}`);
  writeFileSync(new URL(to, root), page);
  console.log("wrote " + to);
}
