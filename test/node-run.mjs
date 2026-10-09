// Runs the browser kernel under Node: compiles a Rust file with rustc.wasm, then
// runs the result. Usage: node test/node-run.mjs <file.rs> [stdin text]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { InputStream, Kernel, loadProgram } from "../web/kernel.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "web/worker.js");

function createWorker() {
  const w = new Worker(workerPath);
  const handle = { postMessage: (m) => w.postMessage(m), terminate: () => w.terminate(), onmessage: null };
  w.on("message", (m) => handle.onmessage(m));
  w.on("error", (e) => console.error("worker error", e));
  return handle;
}

const kernel = new Kernel(createWorker);
let t = performance.now();
kernel.vfs.extractTar(zlib.gunzipSync(fs.readFileSync(path.join(root, "web/assets/sysroot.tar.gz"))), "/sysroot");
const rustc = await loadProgram(zlib.gunzipSync(fs.readFileSync(path.join(root, "web/assets/rustc.wasm.gz"))));
console.error(`[setup ${(performance.now() - t).toFixed(0)}ms]`);

const [file, input] = process.argv.slice(2);
kernel.vfs.writeFile("/work/main.rs", fs.readFileSync(file));
kernel.vfs.mkdirp("/tmp");
const out = (b) => process.stdout.write(b);
const err = (b) => process.stderr.write(b);

t = performance.now();
const code = await kernel.spawn(rustc, {
  args: ["rustc", "/work/main.rs", "--sysroot", "/sysroot", "--target", "wasm32-wasip1-threads", "-o", "/work/main.wasm"],
  env: { TMPDIR: "/tmp" },
  stdout: out,
  stderr: err,
}).exited;
console.error(`[rustc exit ${code}, ${(performance.now() - t).toFixed(0)}ms]`);
if (code !== 0) process.exit(code);

const program = await loadProgram(kernel.vfs.readFile("/work/main.wasm"));
const stdin = new InputStream();
const proc = kernel.spawn(program, { args: ["main"], env: {}, stdin, stdout: out, stderr: err });
if (input !== undefined) {
  setTimeout(() => stdin.push(input), 200);
  setTimeout(() => stdin.close(), 400);
} else stdin.close();
console.error(`[program exit ${await proc.exited}]`);
process.exit(0);
