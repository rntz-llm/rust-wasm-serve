// End-to-end test in headless Chromium: loads the page from serve.py, compiles
// examples with rustc.wasm, and interacts with them through the terminal.
// Usage: node test/browser-test.mjs [url]   (needs `playwright`; without a url it
// serves web/ locally with serve.py, which needs scripts/fetch-assets.sh)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require(path.join(process.execPath, "../../lib/node_modules/playwright")));
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let url = process.argv[2];
let server = null;
if (!url) {
  const port = 8000 + Math.floor(Math.random() * 1000);
  server = spawn("python3", [path.join(root, "serve.py"), String(port)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500));
  url = `http://localhost:${port}/`;
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

const termText = () => page.evaluate(() => document.querySelector(".xterm-rows").innerText);
async function waitForTerm(re, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (re.test(await termText())) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${re}; terminal:\n${await termText()}`);
}
async function loadExample(name) {
  await page.selectOption("#example", name);
}
async function type(text) {
  await page.click("#terminal");
  await page.keyboard.type(text);
}

let failed = false;
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n${e.message}`);
  }
}

try {
  await page.goto(url);
  await check("toolchain loads", async () => {
    // On static hosts, coi.js reloads the page once to become isolated.
    await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30000 }).catch(() => {});
    if (!(await page.evaluate(() => crossOriginIsolated))) throw new Error("not cross-origin isolated");
    await waitForTerm(/Ready in/);
  });

  await check("hello + interactive stdin", async () => {
    await loadExample("Hello, stdin");
    await page.click("#run");
    await waitForTerm(/What's your name\?/);
    await type("Ferris\n");
    await waitForTerm(/Nice to meet you, Ferris!/);
    if (/Linking using/.test(await termText())) throw new Error("linker debug output not filtered");
    await type("hello\n");
    await waitForTerm(/1: olleh/);
    await page.keyboard.press("Control+D");
    await waitForTerm(/Read 1 lines\. Bye!/);
    await waitForTerm(/process exited with code 0/);
  });

  await check("threads + sleep", async () => {
    await loadExample("Threads");
    await page.click("#run");
    await waitForTerm(/total primes below 1,000,000: 78498/);
    await waitForTerm(/process exited with code 0/);
  });

  await check("compile error is reported", async () => {
    await page.evaluate(() => app.setSource('fn main() { let x: u32 = "nope"; }'));
    await page.click("#run");
    await waitForTerm(/mismatched types/);
    await waitForTerm(/rustc failed/);
  });

  await check("panic exits non-zero", async () => {
    await page.evaluate(() => app.setSource('fn main() { let v: Vec<i32> = vec![]; println!("{}", v[3]); }'));
    await page.click("#run");
    await waitForTerm(/index out of bounds/);
    await waitForTerm(/process exited with code [1-9]/);
  });

  await check("Ctrl-C kills a blocked program", async () => {
    await loadExample("Calculator REPL");
    await page.selectOption("#opt", "2");
    await page.click("#run");
    await waitForTerm(/calc/);
    await type("(1 + 2) * 3 ^ 2\n");
    await waitForTerm(/\n27\n/);
    await page.keyboard.press("Control+C");
    await waitForTerm(/process exited with code 130/);
  });

  await check("raw mode keys", async () => {
    await page.selectOption("#opt", "0");
    await loadExample("Raw keys (enable raw mode)");
    await page.click("#run");
    await waitForTerm(/w\/a\/s\/d to move/);
    await type("ddq");
    await waitForTerm(/bye!/);
    await waitForTerm(/process exited with code 0/);
  });
} finally {
  await page.screenshot({ path: path.join(root, "test/screenshot.png") });
  await browser.close();
  server?.kill();
}
process.exit(failed ? 1 : 0);
