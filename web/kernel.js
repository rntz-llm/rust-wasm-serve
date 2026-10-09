// A small WASI (preview1 + wasi-threads) "kernel".
//
// Every wasm thread runs in its own worker (see worker.js). Its WASI imports post
// {name, args} here and block on Atomics.wait until we store the result. The
// kernel owns the filesystem and file descriptors and reads/writes the program's
// shared linear memory directly. A syscall that has to wait (reading an empty
// stdin, sleeping) just returns a Promise; its worker stays blocked meanwhile.

import { Dir, File, VFS } from "./vfs.js";

export const E = {
  SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31,
  NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, PERM: 63, SPIPE: 70,
};
const FT = { UNKNOWN: 0, CHAR: 2, DIR: 3, REG: 4 };
const O = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const FDFLAG_APPEND = 1;
const ALL_RIGHTS = 0x1fffffffn;
// wasi-libc's isatty() wants a character device without seek/tell rights.
const TTY_RIGHTS = ALL_RIGHTS & ~(0x4n | 0x20n);

const enc = new TextEncoder();
const dec = new TextDecoder();

// Reads the limits of a module's imported memory from its binary.
export function importedMemoryType(bytes) {
  let p = 8;
  const leb = () => {
    let r = 0, shift = 0, b;
    do {
      b = bytes[p++];
      r += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return r;
  };
  const skipName = () => { const n = leb(); p += n; };
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = leb();
    const end = p + size;
    if (id === 2) {
      const count = leb();
      for (let i = 0; i < count; i++) {
        skipName();
        skipName();
        const kind = bytes[p++];
        if (kind === 0) leb();
        else if (kind === 1) { p++; const f = leb(); leb(); if (f & 1) leb(); }
        else if (kind === 3) { p += 2; }
        else if (kind === 4) { p++; leb(); }
        else if (kind === 2) {
          const flags = leb();
          const initial = leb();
          const maximum = flags & 1 ? leb() : undefined;
          return { initial, maximum, shared: (flags & 2) !== 0 };
        }
      }
      return null;
    }
    p = end;
  }
  return null;
}

export async function loadProgram(bytes) {
  const memoryType = importedMemoryType(bytes);
  if (!memoryType || !memoryType.shared) {
    throw new Error("program must import a shared memory (build for wasm32-wasip1-threads)");
  }
  return { module: await WebAssembly.compile(bytes), memoryType };
}

// Terminal-ish byte stream used for stdin. `cooked` input arrives via push().
export class InputStream {
  constructor() {
    this.chunks = [];
    this.eof = false;
    this.waiters = [];
  }
  push(bytes) {
    if (typeof bytes === "string") bytes = enc.encode(bytes);
    if (bytes.length) this.chunks.push(bytes);
    this.wake();
  }
  close() {
    this.eof = true;
    this.wake();
  }
  wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  ready() {
    return this.chunks.length > 0 || this.eof;
  }
  wait() {
    return this.ready() ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }
  read(max) {
    const out = [];
    let n = 0;
    while (this.chunks.length && n < max) {
      const c = this.chunks[0];
      const take = Math.min(c.length, max - n);
      out.push(c.subarray(0, take));
      n += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    const r = new Uint8Array(n);
    let o = 0;
    for (const c of out) { r.set(c, o); o += c.length; }
    return r;
  }
}

class Process {
  constructor(kernel, pid, program, opts) {
    this.kernel = kernel;
    this.pid = pid;
    this.program = program;
    this.args = opts.args;
    this.env = Object.entries(opts.env || {}).map(([k, v]) => `${k}=${v}`);
    const t = program.memoryType;
    this.memory = new WebAssembly.Memory({ initial: t.initial, maximum: t.maximum ?? 65536, shared: true });
    this.fds = new Map([
      [0, { kind: "stdin", stream: opts.stdin }],
      [1, { kind: "out", write: opts.stdout }],
      [2, { kind: "out", write: opts.stderr }],
      [3, { kind: "dir", node: kernel.vfs.root, preopen: "/" }],
    ]);
    this.threads = new Map();
    this.nextTid = 1;
    this.done = false;
    this.exited = new Promise((r) => (this.resolveExit = r));
  }

  u8() { return new Uint8Array(this.memory.buffer); }
  dv() { return new DataView(this.memory.buffer); }
  str(ptr, len) { return dec.decode(this.u8().slice(ptr, ptr + len)); }

  newFd(entry) {
    let fd = 4;
    while (this.fds.has(fd)) fd++;
    this.fds.set(fd, entry);
    return fd;
  }

  startThread(tid, startArg) {
    const worker = this.kernel.createWorker();
    const ctl = new Int32Array(new SharedArrayBuffer(8));
    this.threads.set(tid, worker);
    worker.onmessage = (msg) => this.onMessage(msg, ctl);
    worker.postMessage({ module: this.program.module, memory: this.memory, ctl: ctl.buffer, tid, startArg });
  }

  async onMessage(msg, ctl) {
    if (this.done) return;
    if (msg.type === "syscall") {
      let r;
      try {
        r = this.kernel.syscall(this, msg.name, msg.args);
        if (r instanceof Promise) r = await r;
      } catch (e) {
        console.error(`syscall ${msg.name} failed`, e);
        r = E.IO;
      }
      if (this.done) return;
      Atomics.store(ctl, 1, r | 0);
      Atomics.store(ctl, 0, 1);
      Atomics.notify(ctl, 0);
    } else if (msg.type === "done") {
      if (msg.tid === 0) this.exit(0);
      else {
        this.threads.get(msg.tid)?.terminate();
        this.threads.delete(msg.tid);
      }
    } else if (msg.type === "trap") {
      this.fds.get(2).write(enc.encode(`\nwasm trap in thread ${msg.tid}: ${msg.message}\n`));
      this.exit(134);
    }
  }

  exit(code) {
    if (this.done) return;
    this.done = true;
    for (const w of this.threads.values()) w.terminate();
    this.threads.clear();
    this.resolveExit(code);
  }
}

export class Kernel {
  // createWorker() must return an object with postMessage(msg), terminate(),
  // and a settable onmessage(msg) receiving the message data.
  constructor(createWorker) {
    this.createWorker = createWorker;
    this.vfs = new VFS();
    this.nextPid = 1;
  }

  // Runs `program` (from loadProgram) and returns {exited: Promise<code>, kill()}.
  spawn(program, opts) {
    const proc = new Process(this, this.nextPid++, program, {
      stdin: new InputStream(),
      stdout: () => {},
      stderr: () => {},
      ...opts,
    });
    if (!opts.stdin) proc.fds.get(0).stream.close();
    proc.startThread(0, 0);
    return { pid: proc.pid, exited: proc.exited, kill: (code = 130) => proc.exit(code) };
  }

  syscall(proc, name, args) {
    const f = this.calls[name];
    if (!f) {
      console.warn(`unimplemented syscall ${name}`);
      return E.NOSYS;
    }
    return f.call(this, proc, ...args);
  }

  calls = {
    "wasi.thread-spawn"(p, startArg) {
      const tid = p.nextTid++;
      p.startThread(tid, startArg);
      return tid;
    },

    "wasi_snapshot_preview1.proc_exit"(p, code) {
      p.exit(code);
      return new Promise(() => {});
    },
    "wasi_snapshot_preview1.sched_yield"() { return E.SUCCESS; },
    "wasi_snapshot_preview1.proc_raise"() { return E.NOSYS; },

    "wasi_snapshot_preview1.args_sizes_get"(p, argc, size) {
      return writeSizes(p, p.args, argc, size);
    },
    "wasi_snapshot_preview1.args_get"(p, argv, buf) {
      return writeStrings(p, p.args, argv, buf);
    },
    "wasi_snapshot_preview1.environ_sizes_get"(p, count, size) {
      return writeSizes(p, p.env, count, size);
    },
    "wasi_snapshot_preview1.environ_get"(p, environ, buf) {
      return writeStrings(p, p.env, environ, buf);
    },

    "wasi_snapshot_preview1.clock_res_get"(p, id, out) {
      p.dv().setBigUint64(out, 1000n, true);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.clock_time_get"(p, id, precision, out) {
      p.dv().setBigUint64(out, now(id), true);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.random_get"(p, buf, len) {
      const tmp = new Uint8Array(len);
      for (let i = 0; i < len; i += 65536) crypto.getRandomValues(tmp.subarray(i, i + 65536));
      p.u8().set(tmp, buf);
      return E.SUCCESS;
    },

    "wasi_snapshot_preview1.fd_close"(p, fd) {
      if (!p.fds.has(fd)) return E.BADF;
      p.fds.delete(fd);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_fdstat_get"(p, fd, out) {
      const f = p.fds.get(fd);
      if (!f) return E.BADF;
      const dv = p.dv();
      dv.setUint8(out, fileType(f));
      dv.setUint16(out + 2, f.append ? FDFLAG_APPEND : 0, true);
      const rights = fileType(f) === FT.CHAR ? TTY_RIGHTS : ALL_RIGHTS;
      dv.setBigUint64(out + 8, rights, true);
      dv.setBigUint64(out + 16, rights, true);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_fdstat_set_flags"(p, fd, flags) {
      const f = p.fds.get(fd);
      if (!f) return E.BADF;
      f.append = (flags & FDFLAG_APPEND) !== 0;
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_prestat_get"(p, fd, out) {
      const f = p.fds.get(fd);
      if (!f || !f.preopen) return E.BADF;
      const dv = p.dv();
      dv.setUint8(out, 0);
      dv.setUint32(out + 4, enc.encode(f.preopen).length, true);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_prestat_dir_name"(p, fd, buf, len) {
      const f = p.fds.get(fd);
      if (!f || !f.preopen) return E.BADF;
      p.u8().set(enc.encode(f.preopen).subarray(0, len), buf);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_filestat_get"(p, fd, out) {
      const f = p.fds.get(fd);
      if (!f) return E.BADF;
      writeFilestat(p, out, f.node, fileType(f));
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_filestat_set_size"(p, fd, size) {
      const f = p.fds.get(fd);
      if (!f || f.kind !== "file") return E.BADF;
      f.node.truncate(Number(size));
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_filestat_set_times"() { return E.SUCCESS; },
    "wasi_snapshot_preview1.fd_sync"() { return E.SUCCESS; },
    "wasi_snapshot_preview1.fd_datasync"() { return E.SUCCESS; },
    "wasi_snapshot_preview1.fd_advise"() { return E.SUCCESS; },
    "wasi_snapshot_preview1.fd_allocate"(p, fd, offset, len) {
      const f = p.fds.get(fd);
      if (!f || f.kind !== "file") return E.BADF;
      const end = Number(offset + len);
      if (end > f.node.size) f.node.truncate(end);
      return E.SUCCESS;
    },

    "wasi_snapshot_preview1.fd_read"(p, fd, iovs, iovsLen, nread) {
      const f = p.fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind === "stdin") {
        return f.stream.wait().then(() => {
          if (p.done) return E.BADF;
          const bytes = f.stream.read(iovTotal(p, iovs, iovsLen));
          scatter(p, iovs, iovsLen, bytes);
          p.dv().setUint32(nread, bytes.length, true);
          return E.SUCCESS;
        });
      }
      if (f.kind === "dir") return E.ISDIR;
      if (f.kind !== "file") return E.BADF;
      const n = readFile(p, f.node, f.pos, iovs, iovsLen);
      f.pos += n;
      p.dv().setUint32(nread, n, true);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_pread"(p, fd, iovs, iovsLen, offset, nread) {
      const f = p.fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== "file") return f.kind === "dir" ? E.ISDIR : E.SPIPE;
      p.dv().setUint32(nread, readFile(p, f.node, Number(offset), iovs, iovsLen), true);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_write"(p, fd, iovs, iovsLen, nwritten) {
      const f = p.fds.get(fd);
      if (!f) return E.BADF;
      const bytes = gather(p, iovs, iovsLen);
      if (f.kind === "out") f.write(bytes);
      else if (f.kind === "file") {
        if (f.append) f.pos = f.node.size;
        f.node.write(f.pos, bytes);
        f.pos += bytes.length;
      } else return E.BADF;
      p.dv().setUint32(nwritten, bytes.length, true);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_pwrite"(p, fd, iovs, iovsLen, offset, nwritten) {
      const f = p.fds.get(fd);
      if (!f || f.kind !== "file") return E.BADF;
      const bytes = gather(p, iovs, iovsLen);
      f.node.write(Number(offset), bytes);
      p.dv().setUint32(nwritten, bytes.length, true);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_seek"(p, fd, offset, whence, out) {
      const f = p.fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== "file") return E.SPIPE;
      const base = whence === 0 ? 0 : whence === 1 ? f.pos : f.node.size;
      const pos = base + Number(offset);
      if (pos < 0) return E.INVAL;
      f.pos = pos;
      p.dv().setBigUint64(out, BigInt(pos), true);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_tell"(p, fd, out) {
      const f = p.fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== "file") return E.SPIPE;
      p.dv().setBigUint64(out, BigInt(f.pos), true);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_renumber"(p, from, to) {
      const f = p.fds.get(from);
      if (!f || !p.fds.has(to)) return E.BADF;
      p.fds.set(to, f);
      p.fds.delete(from);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.fd_readdir"(p, fd, buf, bufLen, cookie, bufused) {
      const f = p.fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== "dir") return E.NOTDIR;
      const entries = [[".", f.node], ["..", f.node.parent], ...f.node.children];
      const out = [];
      for (let i = Number(cookie); i < entries.length; i++) {
        const [name, node] = entries[i];
        const nameBytes = enc.encode(name);
        const ent = new Uint8Array(24 + nameBytes.length);
        const dv = new DataView(ent.buffer);
        dv.setBigUint64(0, BigInt(i + 1), true);
        dv.setBigUint64(8, node.ino, true);
        dv.setUint32(16, nameBytes.length, true);
        dv.setUint8(20, node instanceof Dir ? FT.DIR : FT.REG);
        ent.set(nameBytes, 24);
        out.push(ent);
        if (out.reduce((n, e) => n + e.length, 0) >= bufLen) break;
      }
      const all = concat(out).subarray(0, bufLen);
      p.u8().set(all, buf);
      p.dv().setUint32(bufused, all.length, true);
      return E.SUCCESS;
    },

    "wasi_snapshot_preview1.path_open"(p, dirfd, dirflags, path, pathLen, oflags, rightsBase, rightsInh, fdflags, out) {
      const r = resolve(this, p, dirfd, path, pathLen);
      if (typeof r === "number") return r;
      let node = r.node;
      if (node) {
        if ((oflags & O.CREAT) && (oflags & O.EXCL)) return E.EXIST;
        if ((oflags & O.DIRECTORY) && !(node instanceof Dir)) return E.NOTDIR;
        if ((oflags & O.TRUNC) && node instanceof File) node.truncate(0);
      } else {
        if (!(oflags & O.CREAT)) return E.NOENT;
        if (oflags & O.DIRECTORY) return E.INVAL;
        node = new File();
        r.parent.add(r.name, node);
      }
      const entry = node instanceof Dir
        ? { kind: "dir", node }
        : { kind: "file", node, pos: 0, append: (fdflags & FDFLAG_APPEND) !== 0 };
      p.dv().setUint32(out, p.newFd(entry), true);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.path_filestat_get"(p, dirfd, flags, path, pathLen, out) {
      const r = resolve(this, p, dirfd, path, pathLen);
      if (typeof r === "number") return r;
      if (!r.node) return E.NOENT;
      writeFilestat(p, out, r.node, r.node instanceof Dir ? FT.DIR : FT.REG);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.path_filestat_set_times"() { return E.SUCCESS; },
    "wasi_snapshot_preview1.path_create_directory"(p, dirfd, path, pathLen) {
      const r = resolve(this, p, dirfd, path, pathLen);
      if (typeof r === "number") return r;
      if (r.node) return E.EXIST;
      r.parent.add(r.name, new Dir());
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.path_remove_directory"(p, dirfd, path, pathLen) {
      const r = resolve(this, p, dirfd, path, pathLen);
      if (typeof r === "number") return r;
      if (!r.node) return E.NOENT;
      if (!(r.node instanceof Dir)) return E.NOTDIR;
      if (r.node.children.size) return E.NOTEMPTY;
      r.node.parent.remove(lastName(p, path, pathLen));
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.path_unlink_file"(p, dirfd, path, pathLen) {
      const r = resolve(this, p, dirfd, path, pathLen, true);
      if (typeof r === "number") return r;
      if (!r.node) return E.NOENT;
      if (r.node instanceof Dir) return E.ISDIR;
      r.parent.remove(r.name);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.path_rename"(p, fd, path, pathLen, newFd, newPath, newPathLen) {
      const from = resolve(this, p, fd, path, pathLen, true);
      if (typeof from === "number") return from;
      if (!from.node) return E.NOENT;
      const to = resolve(this, p, newFd, newPath, newPathLen, true);
      if (typeof to === "number") return to;
      if (to.node instanceof Dir && to.node.children.size) return E.NOTEMPTY;
      from.parent.remove(from.name);
      to.parent.add(to.name, from.node);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.path_link"(p, oldFd, flags, oldPath, oldLen, newFd, newPath, newLen) {
      const from = resolve(this, p, oldFd, oldPath, oldLen);
      if (typeof from === "number") return from;
      if (!from.node) return E.NOENT;
      const to = resolve(this, p, newFd, newPath, newLen, true);
      if (typeof to === "number") return to;
      if (to.node) return E.EXIST;
      to.parent.add(to.name, from.node);
      return E.SUCCESS;
    },
    "wasi_snapshot_preview1.path_readlink"() { return E.INVAL; },
    "wasi_snapshot_preview1.path_symlink"() { return E.NOSYS; },

    "wasi_snapshot_preview1.poll_oneoff"(p, inPtr, outPtr, nsubs, neventsPtr) {
      return pollOneoff(p, inPtr, outPtr, nsubs, neventsPtr);
    },
  };
}

function now(clockId) {
  if (clockId === 0) return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  return BigInt(Math.round(performance.now() * 1e6));
}

function fileType(f) {
  if (f.kind === "stdin" || f.kind === "out") return FT.CHAR;
  if (f.kind === "dir") return FT.DIR;
  return FT.REG;
}

function writeFilestat(p, out, node, type) {
  const dv = p.dv();
  dv.setBigUint64(out, 0n, true);
  dv.setBigUint64(out + 8, node ? node.ino : 0n, true);
  dv.setUint8(out + 16, type);
  dv.setBigUint64(out + 24, 1n, true);
  dv.setBigUint64(out + 32, BigInt(node instanceof File ? node.size : 0), true);
  const t = node ? node.mtime : 0n;
  dv.setBigUint64(out + 40, t, true);
  dv.setBigUint64(out + 48, t, true);
  dv.setBigUint64(out + 56, t, true);
}

function writeSizes(p, strs, countPtr, sizePtr) {
  const dv = p.dv();
  dv.setUint32(countPtr, strs.length, true);
  dv.setUint32(sizePtr, strs.reduce((n, s) => n + enc.encode(s).length + 1, 0), true);
  return E.SUCCESS;
}

function writeStrings(p, strs, ptrs, buf) {
  const dv = p.dv();
  const u8 = p.u8();
  for (const [i, s] of strs.entries()) {
    dv.setUint32(ptrs + 4 * i, buf, true);
    const b = enc.encode(s);
    u8.set(b, buf);
    u8[buf + b.length] = 0;
    buf += b.length + 1;
  }
  return E.SUCCESS;
}

function iovTotal(p, iovs, n) {
  const dv = p.dv();
  let total = 0;
  for (let i = 0; i < n; i++) total += dv.getUint32(iovs + 8 * i + 4, true);
  return total;
}

function gather(p, iovs, n) {
  const dv = p.dv();
  const u8 = p.u8();
  const parts = [];
  for (let i = 0; i < n; i++) {
    const ptr = dv.getUint32(iovs + 8 * i, true);
    const len = dv.getUint32(iovs + 8 * i + 4, true);
    parts.push(u8.slice(ptr, ptr + len));
  }
  return concat(parts);
}

function scatter(p, iovs, n, bytes) {
  const dv = p.dv();
  const u8 = p.u8();
  let off = 0;
  for (let i = 0; i < n && off < bytes.length; i++) {
    const ptr = dv.getUint32(iovs + 8 * i, true);
    const len = dv.getUint32(iovs + 8 * i + 4, true);
    const chunk = bytes.subarray(off, off + len);
    u8.set(chunk, ptr);
    off += chunk.length;
  }
}

function readFile(p, node, pos, iovs, n) {
  const want = iovTotal(p, iovs, n);
  const bytes = node.contents().subarray(pos, pos + want);
  scatter(p, iovs, n, bytes);
  return bytes.length;
}

function concat(parts) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}

// Resolves a path relative to a directory fd. Returns an errno or a lookup result
// ({node} or {parent, name}). With `wantParent`, also fills in {parent, name}
// for an existing node.
function resolve(kernel, p, dirfd, ptr, len, wantParent = false) {
  const d = p.fds.get(dirfd);
  if (!d) return E.BADF;
  if (d.kind !== "dir") return E.NOTDIR;
  const path = p.str(ptr, len);
  const r = kernel.vfs.lookup(d.node, path);
  if (!r) return E.NOENT;
  if (wantParent && r.node) {
    const i = path.replace(/\/+$/, "").lastIndexOf("/");
    const parent = i < 0 ? d.node : kernel.vfs.lookup(d.node, path.slice(0, i)).node;
    return { node: r.node, parent, name: path.replace(/\/+$/, "").slice(i + 1) };
  }
  return r;
}

function lastName(p, ptr, len) {
  const path = p.str(ptr, len).replace(/\/+$/, "");
  return path.slice(path.lastIndexOf("/") + 1);
}

function pollOneoff(p, inPtr, outPtr, nsubs, neventsPtr) {
  const dv = p.dv();
  const subs = [];
  for (let i = 0; i < nsubs; i++) {
    const s = inPtr + 48 * i;
    const sub = { userdata: dv.getBigUint64(s, true), tag: dv.getUint8(s + 8) };
    if (sub.tag === 0) {
      const id = dv.getUint32(s + 16, true);
      const timeout = dv.getBigUint64(s + 24, true);
      const abs = (dv.getUint16(s + 40, true) & 1) !== 0;
      sub.deadline = abs ? timeout : now(id) + timeout;
      sub.clock = id;
    } else {
      sub.fd = dv.getUint32(s + 16, true);
    }
    subs.push(sub);
  }

  const ready = () =>
    subs.filter((s) => {
      if (s.tag === 0) return now(s.clock) >= s.deadline;
      const f = p.fds.get(s.fd);
      return !f || s.tag === 2 || f.kind !== "stdin" || f.stream.ready();
    });
  const finish = (events) => {
    const dv = p.dv();
    events.forEach((s, i) => {
      const e = outPtr + 32 * i;
      dv.setBigUint64(e, s.userdata, true);
      dv.setUint16(e + 8, s.tag !== 0 && !p.fds.has(s.fd) ? E.BADF : 0, true);
      dv.setUint8(e + 10, s.tag);
      if (s.tag !== 0) {
        const f = p.fds.get(s.fd);
        const n = f && f.kind === "stdin" ? f.stream.chunks.reduce((n, c) => n + c.length, 0) : 1;
        dv.setBigUint64(e + 16, BigInt(n), true);
        dv.setUint16(e + 24, f && f.kind === "stdin" && f.stream.eof ? 1 : 0, true);
      }
    });
    dv.setUint32(neventsPtr, events.length, true);
    return E.SUCCESS;
  };

  const now0 = ready();
  if (now0.length) return finish(now0);
  return new Promise((resolveP) => {
    const timers = [];
    const check = () => {
      const r = ready();
      if (!r.length || p.done) return;
      timers.forEach(clearTimeout);
      resolveP(finish(r));
    };
    for (const s of subs) {
      if (s.tag === 0) {
        const ms = Number(s.deadline - now(s.clock)) / 1e6;
        timers.push(setTimeout(check, Math.max(0, Math.ceil(ms))));
      } else {
        const f = p.fds.get(s.fd);
        if (f && f.kind === "stdin") f.stream.wait().then(check);
      }
    }
  });
}
