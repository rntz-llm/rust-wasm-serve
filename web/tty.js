// Line discipline between an xterm.js terminal and a process's stdin.
//
// Cooked mode (default) echoes input, supports backspace / Ctrl-U, and delivers
// whole lines on Enter, like a Unix tty. Raw mode passes keystrokes straight
// through with no echo, for programs that want single key presses.
// Ctrl-C kills the process; Ctrl-D sends EOF (or flushes a partial line).

export class Tty {
  constructor(term) {
    this.term = term;
    this.raw = false;
    this.stream = null;
    this.onInterrupt = null;
    this.line = "";
    term.onData((data) => this.input(data));
  }

  // Connects a process's stdin stream; pass null when it exits.
  attach(stream, onInterrupt) {
    this.stream = stream;
    this.onInterrupt = onInterrupt;
    this.line = "";
  }

  input(data) {
    if (!this.stream) return;
    if (this.raw) {
      if (data === "\x03") return this.interrupt();
      this.stream.push(data);
      return;
    }
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this.term.write("\r\n");
        this.stream.push(this.line + "\n");
        this.line = "";
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line) {
          const chars = [...this.line];
          const last = chars.pop();
          this.line = chars.join("");
          const w = isWide(last) ? 2 : 1;
          this.term.write("\b".repeat(w) + " ".repeat(w) + "\b".repeat(w));
        }
      } else if (ch === "\x15") {
        // Ctrl-U: erase line.
        const w = [...this.line].reduce((n, c) => n + (isWide(c) ? 2 : 1), 0);
        this.term.write("\b \b".repeat(w));
        this.line = "";
      } else if (ch === "\x03") {
        this.term.write("^C\r\n");
        return this.interrupt();
      } else if (ch === "\x04") {
        if (this.line) {
          this.stream.push(this.line);
          this.line = "";
        } else this.stream.close();
      } else if (ch === "\x1b") {
        // Ignore escape sequences (arrow keys etc.) in cooked mode.
        return;
      } else if (ch >= " ") {
        this.line += ch;
        this.term.write(ch);
      }
    }
  }

  interrupt() {
    const f = this.onInterrupt;
    this.attach(null, null);
    if (f) f();
  }
}

function isWide(ch) {
  const c = ch.codePointAt(0);
  return c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd));
}
