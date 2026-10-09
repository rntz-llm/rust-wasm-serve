#!/usr/bin/env bash
# Downloads prebuilt rustc.wasm (LLVM + in-process lld, built for wasm32-wasip1-threads)
# and a wasm32-wasip1-threads sysroot, and packs them into web/assets/.
#
# Prebuilt binaries come from https://github.com/oligamiq/rust_wasm (release v3.0.0).
# libwasi-emulated-mman.a comes from wasi-sdk 24, which the sysroot's std links against.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.cache"
OUT="$ROOT/web/assets"
RUST_WASM="https://github.com/oligamiq/rust_wasm/releases/download/v3.0.0-release"
WASI_SDK="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sysroot-24.0.tar.gz"
TARGET=wasm32-wasip1-threads

mkdir -p "$CACHE" "$OUT"
fetch() {
  if [ ! -f "$CACHE/$2" ]; then
    curl -fSL --retry 4 -o "$CACHE/$2.part" "$1"
    mv -f "$CACHE/$2.part" "$CACHE/$2"
  fi
}
# The panic=unwind build of rustc exits cleanly (code 1) on compile errors; the
# panic=abort build traps instead. It needs wasm exception handling.
fetch "$RUST_WASM/rustc_unwind_opt.wasm.tar.gz" rustc_unwind_opt.wasm.tar.gz
fetch "$RUST_WASM/$TARGET.tar.gz" "$TARGET.tar.gz"
fetch "$WASI_SDK" wasi-sysroot-24.0.tar.gz

# rustc.wasm, gzipped (decompressed in the browser with DecompressionStream).
tar -xzf "$CACHE/rustc_unwind_opt.wasm.tar.gz" -O rustc_unwind_opt.wasm | gzip -6 > "$OUT/rustc.wasm.gz"

# Sysroot: keep only what `std` programs need, laid out as /sysroot/lib/rustlib/<target>/lib.
STAGE="$CACHE/sysroot-stage"
rm -rf "$STAGE"
LIB="$STAGE/lib/rustlib/$TARGET/lib"
mkdir -p "$LIB"
tar -xzf "$CACHE/$TARGET.tar.gz" -C "$LIB"
rm -f "$LIB"/libtest-*.rlib "$LIB"/libgetopts-*.rlib "$LIB"/libproc_macro-*.rlib \
      "$LIB"/libsysroot-*.rlib "$LIB"/libunicode_width-*.rlib "$LIB"/librustc_std_workspace_std-*.rlib \
      "$LIB"/libpanic_unwind-*.rlib
tar -xzf "$CACHE/wasi-sysroot-24.0.tar.gz" -O "wasi-sysroot-24.0/lib/$TARGET/libwasi-emulated-mman.a" \
    > "$LIB/self-contained/libwasi-emulated-mman.a"
tar -C "$STAGE" --owner=0 --group=0 -cf - lib | gzip -6 > "$OUT/sysroot.tar.gz"

ls -la "$OUT"
