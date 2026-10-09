# rust-wasm-serve

A web page that compiles Rust **in the browser**: `rustc` itself, plus LLVM and
lld, runs as WebAssembly. It compiles the code in the editor to a wasm program,
then runs that program in the browser with an interactive terminal.

Nothing runs server-side; the server only hosts static files.

**Try it: <https://rntz-llm.github.io/rust-wasm-serve/>**

To run it locally:

```
./scripts/fetch-assets.sh   # download rustc.wasm + sysroot into web/assets (~56 MB)
python3 serve.py            # http://localhost:8000
```

Pushes to `main` deploy `web/` to GitHub Pages via `.github/workflows/pages.yml`,
which runs `fetch-assets.sh` in CI so the binaries never enter git. Pages can't
set COOP/COEP headers, so the deployed site relies on the service-worker fallback
(`coi.js`); the first visit reloads once.

## Feasibility

It works, and it's reasonably fast. Measured in headless Chromium on a 4-core
container:

- **Toolchain load:** about 1 s once the 56 MB of assets are cached (31 MB is
  rustc, 25 MB is the sysroot).
- **Compiling a small program:** about 1–3 s at `opt-level=0`.

The hard part was getting rustc compiled to wasm at all: LLVM and lld have to
be built for `wasm32-wasip1-threads`, and rustc has to be patched to link
in-process because WASI can't spawn processes. That work already exists. This
project uses the prebuilt binaries from
[oligamiq/rust_wasm](https://github.com/oligamiq/rust_wasm) (release v3.0.0,
rustc 1.83-dev). With those, the remaining work is a WASI runtime for the
browser that supports threads.

Constraints:

- **Cross-origin isolation is required.** rustc uses threads, so it needs
  `SharedArrayBuffer` and shared wasm memory, which browsers only enable when
  the page is sent with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. `serve.py` sends these headers.
  On static hosts that can't set headers (e.g. GitHub Pages), `coi.js`
  registers a service worker (`coi-sw.js`) that adds them and reloads once.
  That needs HTTPS or localhost.
- **Wasm exception handling is required.** rustc is the `panic=unwind` build,
  so it exits cleanly on compile errors. Current Chrome, Firefox and Safari all
  support this.
- **Single files and `std` only.** There's no cargo and no crates.io.
- **Threaded target.** Programs are built for `wasm32-wasip1-threads`, so
  `std::thread` works.

## Interacting with programs

The terminal is [xterm.js](https://xtermjs.org/) with a small Unix-style line
discipline (`web/tty.js`):

- **Cooked mode (default):**
  - Typed text is echoed and editable with Backspace and Ctrl-U.
  - Enter sends the line to the program's stdin.
  - Ctrl-D sends EOF.
  - Ctrl-C kills the program.
- **Raw input** (toolbar checkbox): each keystroke is delivered to stdin
  immediately with no echo, so programs can read single keys. Combined with
  ANSI escape sequences this is enough for simple full-screen TUIs; see the
  "Raw keys" example.

A program reading an empty stdin blocks, just as it would on a real tty.
`std::io::IsTerminal` reports stdin and stdout as terminals, and `COLUMNS`,
`LINES` and `TERM` are set.

## How it works

```
 main thread                                   workers (one per wasm thread)
┌──────────────────────────────┐   postMessage  ┌──────────────────────────────┐
│ kernel.js                    │◄───────────────│ worker.js                    │
│  - in-memory VFS (vfs.js)    │  {syscall,args}│  instance of rustc.wasm or   │
│  - fd tables, WASI syscalls  │                │  the user's program          │
│  - wasi thread-spawn         │  Atomics.notify│  every WASI import blocks in │
│  - stdin/stdout ↔ tty.js     │───────────────►│  Atomics.wait for the result │
└──────────────────────────────┘                └──────────────────────────────┘
            ▲  reads/writes the program's shared WebAssembly.Memory directly
```

- **One worker per wasm thread.** Each thread of a program (rustc or the user's
  program) runs in its own worker. All of a process's workers share one
  `WebAssembly.Memory`.
- **Syscalls are blocking calls into the kernel.** A WASI import in a worker
  posts the syscall name and arguments to the kernel on the main thread, then
  blocks on `Atomics.wait`. The kernel works directly on the shared memory:
  reading iovecs and paths, writing results. Then it stores the return value
  and calls `Atomics.notify`.
- **Waiting syscalls hold the worker.** A syscall that must wait, like
  `fd_read` on an empty stdin or `poll_oneoff` for `sleep`, returns a Promise,
  and its worker stays blocked until it resolves. That's what makes stdin
  interactive.
- **Threads.** `thread-spawn` starts another worker with the same module and
  memory and calls `wasi_thread_start`. `proc_exit` terminates all of the
  process's workers.
- **Filesystem.** At startup the sysroot tarball is unpacked into the VFS at
  `/sysroot`. Then `rustc /work/main.rs --target wasm32-wasip1-threads` writes
  `/work/main.wasm`, which is loaded and spawned the same way.

| File | Purpose |
| --- | --- |
| `web/kernel.js` | WASI preview1 + wasi-threads implementation, process/thread management |
| `web/worker.js` | Hosts one wasm thread; forwards imports to the kernel |
| `web/vfs.js` | In-memory filesystem and tar extraction |
| `web/tty.js` | Line discipline between xterm.js and stdin |
| `web/app.js`, `web/index.html` | UI: editor, toolbar, terminal |
| `vendor-build/` | Builds `web/vendor/codemirror.js` (CodeMirror 6 + Rust mode): `npm ci && npm run build` |
| `web/coi.js`, `web/coi-sw.js` | Service-worker fallback for cross-origin isolation |
| `serve.py` | Static server that sends COOP/COEP headers |
| `scripts/fetch-assets.sh` | Downloads and repacks rustc.wasm and the sysroot |

## Tests

```
node test/node-run.mjs test/threads.rs $'some\ninput\n'   # kernel under Node, no browser
node test/browser-test.mjs                                # end-to-end in headless Chromium (Playwright)
```

The browser test covers:

- loading the toolchain
- interactive stdin
- threads and sleep
- compile errors
- panics
- Ctrl-C
- raw-mode input

## Provenance and licences

- `rustc.wasm` and the `wasm32-wasip1-threads` sysroot are downloaded from
  [oligamiq/rust_wasm](https://github.com/oligamiq/rust_wasm) releases. They
  are built from oligamiq's rustc fork, `compile_rustc_for_wasm` branches.
  - They are third-party binaries.
  - To build your own instead, follow that repo's workflows and point
    `scripts/fetch-assets.sh` at the results.
- `libwasi-emulated-mman.a` comes from
  [wasi-sdk 24](https://github.com/WebAssembly/wasi-sdk). The threads sysroot's
  `std` links against it, but the release doesn't ship it.
- `web/vendor/` contains xterm.js 5.5.0 and its fit addon (MIT, see
  `web/vendor/xterm-LICENSE`), and a bundle of [CodeMirror 6](https://codemirror.net/)
  with its Rust language mode and One Dark theme (MIT; licences of all bundled
  packages are in `web/vendor/codemirror-LICENSES.txt`).
- Prior art: [bjorn3/browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim)
  and [oligamiq/rubrc](https://github.com/oligamiq/rubrc). rubrc is a much more
  complete environment, with cargo and rust-analyzer.
