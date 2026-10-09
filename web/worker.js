// Runs one thread of a wasm32-wasip1-threads program. All WASI imports are
// forwarded to the kernel (kernel.js) as blocking calls: post the request, then
// Atomics.wait until the kernel writes the result into `ctl`.

let post;
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  post = (m) => self.postMessage(m);
  self.onmessage = (e) => run(e.data);
} else {
  const { parentPort } = await import("node:worker_threads");
  post = (m) => parentPort.postMessage(m);
  parentPort.on("message", run);
}

function run({ module, memory, ctl: ctlBuf, tid, startArg }) {
  const ctl = new Int32Array(ctlBuf);
  const imports = { env: { memory } };
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== "function") continue;
    const name = `${imp.module}.${imp.name}`;
    (imports[imp.module] ??= {})[imp.name] = (...args) => {
      Atomics.store(ctl, 0, 0);
      post({ type: "syscall", tid, name, args });
      Atomics.wait(ctl, 0, 0);
      return Atomics.load(ctl, 1);
    };
  }
  try {
    const instance = new WebAssembly.Instance(module, imports);
    if (tid === 0) instance.exports._start();
    else instance.exports.wasi_thread_start(tid, startArg);
    post({ type: "done", tid });
  } catch (e) {
    post({ type: "trap", tid, message: String((e && e.stack) || e) });
  }
}
