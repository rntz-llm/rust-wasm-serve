// In-memory filesystem used by the WASI kernel.

let nextIno = 1n;

export class File {
  constructor(data = new Uint8Array(0)) {
    this.ino = nextIno++;
    this.data = data;
    this.size = data.length;
    this.mtime = BigInt(Date.now()) * 1000000n;
  }

  // Bytes of the file, without spare capacity.
  contents() {
    return this.data.subarray(0, this.size);
  }

  truncate(size) {
    this.reserve(size);
    if (size > this.size) this.data.fill(0, this.size, size);
    this.size = size;
    this.touch();
  }

  write(pos, bytes) {
    const end = pos + bytes.length;
    this.reserve(end);
    if (pos > this.size) this.data.fill(0, this.size, pos);
    this.data.set(bytes, pos);
    if (end > this.size) this.size = end;
    this.touch();
  }

  reserve(n) {
    if (n <= this.data.length) return;
    const grown = new Uint8Array(Math.max(n, this.data.length * 2, 4096));
    grown.set(this.data.subarray(0, this.size));
    this.data = grown;
  }

  touch() {
    this.mtime = BigInt(Date.now()) * 1000000n;
  }
}

export class Dir {
  constructor() {
    this.ino = nextIno++;
    this.children = new Map();
    this.parent = this;
    this.mtime = BigInt(Date.now()) * 1000000n;
  }

  add(name, node) {
    this.children.set(name, node);
    if (node instanceof Dir) node.parent = this;
    this.mtime = BigInt(Date.now()) * 1000000n;
  }

  remove(name) {
    this.children.delete(name);
    this.mtime = BigInt(Date.now()) * 1000000n;
  }
}

export class VFS {
  constructor() {
    this.root = new Dir();
  }

  // Resolves `path` relative to `dir`. Returns {node} or {parent, name} (for a
  // missing last component), or null if an intermediate component is missing.
  lookup(dir, path) {
    const parts = path.split("/").filter((p) => p !== "" && p !== ".");
    let node = path.startsWith("/") ? this.root : dir;
    for (let i = 0; i < parts.length; i++) {
      if (!(node instanceof Dir)) return null;
      const part = parts[i];
      if (part === "..") {
        node = node.parent;
        continue;
      }
      const child = node.children.get(part);
      if (child === undefined) {
        return i === parts.length - 1 ? { parent: node, name: part } : null;
      }
      node = child;
    }
    return { node };
  }

  mkdirp(path) {
    let node = this.root;
    for (const part of path.split("/").filter(Boolean)) {
      let child = node.children.get(part);
      if (!child) {
        child = new Dir();
        node.add(part, child);
      }
      node = child;
    }
    return node;
  }

  writeFile(path, bytes) {
    if (typeof bytes === "string") bytes = new TextEncoder().encode(bytes);
    const i = path.lastIndexOf("/");
    const dir = this.mkdirp(path.slice(0, i));
    const name = path.slice(i + 1);
    const existing = dir.children.get(name);
    if (existing instanceof File) {
      existing.data = bytes;
      existing.size = bytes.length;
      existing.touch();
      return existing;
    }
    const file = new File(bytes);
    dir.add(name, file);
    return file;
  }

  readFile(path) {
    const r = this.lookup(this.root, path);
    return r && r.node instanceof File ? r.node.contents() : null;
  }

  // Unpacks an (uncompressed) ustar/GNU tar archive under `dest`.
  extractTar(bytes, dest = "/") {
    const dec = new TextDecoder();
    const str = (off, len) => {
      const s = dec.decode(bytes.subarray(off, off + len));
      const nul = s.indexOf("\0");
      return nul >= 0 ? s.slice(0, nul) : s;
    };
    let off = 0;
    let longName = null;
    while (off + 512 <= bytes.length) {
      if (bytes[off] === 0) break;
      let name = str(off, 100);
      const size = parseInt(str(off + 124, 12).trim() || "0", 8);
      const type = String.fromCharCode(bytes[off + 156]);
      const prefix = str(off + 345, 155);
      if (prefix) name = prefix + "/" + name;
      const body = off + 512;
      off = body + Math.ceil(size / 512) * 512;
      if (type === "L") {
        longName = str(body, size);
        continue;
      }
      if (longName !== null) {
        name = longName;
        longName = null;
      }
      const full = dest.replace(/\/$/, "") + "/" + name.replace(/^\.?\//, "");
      if (type === "5") this.mkdirp(full);
      else if (type === "0" || type === "\0") this.writeFile(full, bytes.slice(body, body + size));
    }
  }
}
