import { InputStream, Kernel, loadProgram } from "./kernel.js";
import { Tty } from "./tty.js";
import { examples } from "./examples.js";

const $ = (id) => document.getElementById(id);
const editor = $("editor");
const runBtn = $("run");
const stopBtn = $("stop");
const statusEl = $("status");
const optSel = $("opt");
const rawBox = $("raw");
const exampleSel = $("example");

const term = new Terminal({
  convertEol: true,
  cursorBlink: true,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  fontSize: 14,
  theme: { background: "#14161a", foreground: "#d8dee9", cursor: "#d8dee9" },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($("terminal"));
fit.fit();
new ResizeObserver(() => fit.fit()).observe($("terminal"));
const tty = new Tty(term);

const DIM = "\x1b[2m", BOLD = "\x1b[1m", RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
const say = (s) => term.write(s);
const setStatus = (s) => (statusEl.textContent = s);

// ---- Editor -----------------------------------------------------------------

const STORAGE_KEY = "rust-wasm-serve.source";
function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

for (const name of Object.keys(examples)) exampleSel.add(new Option(name, name));
editor.value = stored(STORAGE_KEY) ?? examples["Hello, stdin"];
exampleSel.value = "";
exampleSel.onchange = () => {
  if (!exampleSel.value) return;
  editor.value = examples[exampleSel.value];
  rawBox.checked = exampleSel.value.startsWith("Raw keys");
  tty.raw = rawBox.checked;
  store(STORAGE_KEY, editor.value);
  exampleSel.value = "";
  editor.focus();
};
editor.addEventListener("input", () => store(STORAGE_KEY, editor.value));
editor.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run();
  } else if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    document.execCommand("insertText", false, "    ");
  }
});
rawBox.onchange = () => {
  tty.raw = rawBox.checked;
  term.focus();
};

// ---- Toolchain loading ----------------------------------------------------------

async function fetchGunzip(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (did you run scripts/fetch-assets.sh?)`);
  const total = Number(res.headers.get("content-length")) || 0;
  let loaded = 0;
  const progress = new TransformStream({
    transform(chunk, ctl) {
      loaded += chunk.length;
      if (total) setStatus(`Downloading ${label}… ${Math.round((100 * loaded) / total)}%`);
      ctl.enqueue(chunk);
    },
  });
  const body = res.body.pipeThrough(progress).pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function createWorker() {
  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const handle = { postMessage: (m) => w.postMessage(m), terminate: () => w.terminate(), onmessage: null };
  w.onmessage = (e) => handle.onmessage(e.data);
  w.onerror = (e) => console.error("worker error", e);
  return handle;
}

const kernel = new Kernel(createWorker);
let rustc = null;

async function boot() {
  if (!self.crossOriginIsolated) {
    say(`${RED}This page is not cross-origin isolated${RESET}, so SharedArrayBuffer is unavailable.\r\n` +
      `Serve it with COOP/COEP headers (python3 serve.py), or over HTTPS so the\r\n` +
      `service worker in coi.js can add them.\r\n`);
    setStatus("Not cross-origin isolated");
    return;
  }
  say(`${BOLD}rustc → wasm, in your browser${RESET}\r\n`);
  say(`${DIM}Loading the Rust toolchain (rustc + LLVM + lld compiled to WebAssembly)…${RESET}\r\n`);
  const t0 = performance.now();
  try {
    const [sysroot, rustcBytes] = await Promise.all([
      fetchGunzip("assets/sysroot.tar.gz", "sysroot"),
      fetchGunzip("assets/rustc.wasm.gz", "rustc"),
    ]);
    setStatus("Compiling rustc.wasm…");
    kernel.vfs.extractTar(sysroot, "/sysroot");
    kernel.vfs.mkdirp("/tmp");
    kernel.vfs.mkdirp("/work");
    rustc = await loadProgram(rustcBytes);
  } catch (e) {
    say(`${RED}Failed to load toolchain:${RESET} ${e.message}\r\n`);
    setStatus("Failed to load toolchain");
    return;
  }
  say(`${DIM}Ready in ${((performance.now() - t0) / 1000).toFixed(1)}s. Press Run (Ctrl+Enter).${RESET}\r\n`);
  setStatus("Ready");
  runBtn.disabled = false;
}

// ---- Running ------------------------------------------------------------------

let current = null;

// rustc from rust_wasm prints a "Linking using ..." debug line; hide it.
function filterLinkerNoise(sink) {
  let pending = "";
  const dec = new TextDecoder();
  return (bytes) => {
    pending += dec.decode(bytes, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) if (!line.startsWith("Linking using")) sink(line + "\n");
  };
}

async function run() {
  if (!rustc || current) return;
  runBtn.disabled = true;
  stopBtn.disabled = false;
  const opt = optSel.value;
  const args = ["rustc", "/work/main.rs", "--edition", "2021", "--sysroot", "/sysroot",
    "--target", "wasm32-wasip1-threads", "--color", "always", "-C", `opt-level=${opt}`, "-o", "/work/main.wasm"];
  kernel.vfs.writeFile("/work/main.rs", editor.value);

  term.reset();
  say(`${DIM}$ rustc main.rs -C opt-level=${opt}${RESET}\r\n`);
  setStatus("Compiling…");
  let t0 = performance.now();
  const rustcProc = kernel.spawn(rustc, {
    args,
    env: { TMPDIR: "/tmp" },
    stdout: (b) => term.write(b),
    stderr: filterLinkerNoise((s) => term.write(s)),
  });
  current = rustcProc;
  const code = await rustcProc.exited;
  const compileTime = ((performance.now() - t0) / 1000).toFixed(1);
  if (code !== 0) {
    say(`${RED}rustc failed${RESET} ${DIM}(exit ${code}, ${compileTime}s)${RESET}\r\n`);
    return finish(`Compile failed (${compileTime}s)`);
  }

  let program;
  try {
    program = await loadProgram(kernel.vfs.readFile("/work/main.wasm"));
  } catch (e) {
    say(`${RED}${e.message}${RESET}\r\n`);
    return finish("Load failed");
  }
  say(`${DIM}compiled in ${compileTime}s${RESET}\r\n${DIM}$ ./main${RESET}\r\n`);
  setStatus(`Running (compiled in ${compileTime}s)`);
  const stdin = new InputStream();
  t0 = performance.now();
  const proc = kernel.spawn(program, {
    args: ["main"],
    env: { TERM: "xterm-256color", COLUMNS: String(term.cols), LINES: String(term.rows) },
    stdin,
    stdout: (b) => term.write(b),
    stderr: (b) => term.write(b),
  });
  current = proc;
  tty.attach(stdin, () => proc.kill(130));
  term.focus();
  const exit = await proc.exited;
  tty.attach(null, null);
  const runTime = ((performance.now() - t0) / 1000).toFixed(1);
  const color = exit === 0 ? GREEN : RED;
  say(`\r\n${color}[process exited with code ${exit}]${RESET} ${DIM}(ran ${runTime}s)${RESET}\r\n`);
  finish(`Exited with code ${exit}`);
}

function finish(status) {
  current = null;
  runBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus(status);
}

function stop() {
  if (!current) return;
  tty.attach(null, null);
  current.kill(130);
}

runBtn.onclick = run;
stopBtn.onclick = () => {
  say(`${DIM}^C${RESET}\r\n`);
  stop();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target !== editor) {
    e.preventDefault();
    run();
  }
});

boot();
