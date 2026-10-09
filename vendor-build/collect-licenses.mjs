// Writes ../web/vendor/codemirror-LICENSES.txt with the licence of every
// production dependency bundled into codemirror.js.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dirs = execSync("npm ls --omit=dev --all --parseable", { encoding: "utf8" })
  .split("\n")
  .filter((d) => d.includes("node_modules"));
const out = [];
for (const dir of [...new Set(dirs)].sort()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const file = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  const text = file ? fs.readFileSync(path.join(dir, file), "utf8").trim() : `License: ${pkg.license}`;
  out.push(`${pkg.name}@${pkg.version}\n${"-".repeat(40)}\n${text}\n`);
}
fs.writeFileSync("../web/vendor/codemirror-LICENSES.txt", out.join("\n"));
console.log(`wrote licences for ${out.length} packages`);
