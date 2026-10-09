export const examples = {
  "Hello, stdin": `use std::io::{self, BufRead, Write};

fn main() {
    println!("Hello from Rust, compiled in your browser!");
    print!("What's your name? ");
    io::stdout().flush().unwrap();

    let mut name = String::new();
    io::stdin().read_line(&mut name).unwrap();
    println!("Nice to meet you, {}!", name.trim());

    println!("Type lines to echo them back (Ctrl-D to finish):");
    let mut count = 0;
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        count += 1;
        println!("{count:>3}: {}", line.chars().rev().collect::<String>());
    }
    println!("Read {count} lines. Bye!");
}
`,

  "Guessing game": `use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let secret = (seed % 100 + 1) as u32;
    println!("I'm thinking of a number between 1 and 100.");

    for tries in 1.. {
        print!("Your guess: ");
        io::stdout().flush().unwrap();
        let mut line = String::new();
        if io::stdin().read_line(&mut line).unwrap() == 0 {
            println!("\\nGiving up? It was {secret}.");
            return;
        }
        let guess: u32 = match line.trim().parse() {
            Ok(n) => n,
            Err(_) => { println!("That's not a number."); continue; }
        };
        match guess.cmp(&secret) {
            std::cmp::Ordering::Less => println!("Too small."),
            std::cmp::Ordering::Greater => println!("Too big."),
            std::cmp::Ordering::Equal => {
                println!("\\x1b[32mYou got it in {tries} tries!\\x1b[0m");
                return;
            }
        }
    }
}
`,

  "Threads": `use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

fn is_prime(n: u64) -> bool {
    n >= 2 && (2..).take_while(|d| d * d <= n).all(|d| n % d != 0)
}

fn main() {
    let start = Instant::now();
    let counter = Arc::new(Mutex::new(0u64));
    let (tx, rx) = mpsc::channel();

    let handles: Vec<_> = (0..4)
        .map(|id| {
            let counter = Arc::clone(&counter);
            let tx = tx.clone();
            thread::spawn(move || {
                let lo = id * 250_000;
                let primes = (lo..lo + 250_000).filter(|&n| is_prime(n)).count() as u64;
                *counter.lock().unwrap() += primes;
                tx.send(format!("worker {id}: {primes} primes in [{lo}, {})", lo + 250_000)).unwrap();
            })
        })
        .collect();
    drop(tx);

    for msg in rx {
        println!("{msg}");
    }
    for h in handles {
        h.join().unwrap();
    }
    println!("total primes below 1,000,000: {}", counter.lock().unwrap());
    println!("took {:?}", start.elapsed());

    for i in (1..=3).rev() {
        println!("sleeping... {i}");
        thread::sleep(Duration::from_millis(500));
    }
}
`,

  "Calculator REPL": `use std::io::{self, Write};

// A tiny recursive-descent calculator: + - * / ^ and parentheses.
struct Parser<'a> { s: &'a [u8], i: usize }

impl Parser<'_> {
    fn peek(&mut self) -> Option<u8> {
        while self.s.get(self.i) == Some(&b' ') { self.i += 1; }
        self.s.get(self.i).copied()
    }
    fn expr(&mut self) -> Result<f64, String> {
        let mut v = self.term()?;
        while let Some(c @ (b'+' | b'-')) = self.peek() {
            self.i += 1;
            let r = self.term()?;
            if c == b'+' { v += r } else { v -= r }
        }
        Ok(v)
    }
    fn term(&mut self) -> Result<f64, String> {
        let mut v = self.power()?;
        while let Some(c @ (b'*' | b'/')) = self.peek() {
            self.i += 1;
            let r = self.power()?;
            if c == b'*' { v *= r } else { v /= r }
        }
        Ok(v)
    }
    fn power(&mut self) -> Result<f64, String> {
        let base = self.atom()?;
        if self.peek() == Some(b'^') { self.i += 1; return Ok(base.powf(self.power()?)); }
        Ok(base)
    }
    fn atom(&mut self) -> Result<f64, String> {
        match self.peek() {
            Some(b'(') => {
                self.i += 1;
                let v = self.expr()?;
                if self.peek() != Some(b')') { return Err("expected ')'".into()); }
                self.i += 1;
                Ok(v)
            }
            Some(b'-') => { self.i += 1; Ok(-self.atom()?) }
            Some(c) if c.is_ascii_digit() || c == b'.' => {
                let start = self.i;
                while matches!(self.s.get(self.i), Some(c) if c.is_ascii_digit() || *c == b'.') { self.i += 1; }
                std::str::from_utf8(&self.s[start..self.i]).unwrap().parse().map_err(|e| format!("{e}"))
            }
            Some(c) => Err(format!("unexpected '{}'", c as char)),
            None => Err("unexpected end of input".into()),
        }
    }
}

fn main() {
    println!("calc — try (1 + 2) * 3 ^ 2. Ctrl-D to quit.");
    loop {
        print!("\\x1b[36m> \\x1b[0m");
        io::stdout().flush().unwrap();
        let mut line = String::new();
        if io::stdin().read_line(&mut line).unwrap() == 0 { println!(); break; }
        if line.trim().is_empty() { continue; }
        let mut p = Parser { s: line.trim().as_bytes(), i: 0 };
        match p.expr() {
            Ok(v) if p.peek().is_none() => println!("{v}"),
            Ok(_) => println!("\\x1b[31merror:\\x1b[0m trailing input"),
            Err(e) => println!("\\x1b[31merror:\\x1b[0m {e}"),
        }
    }
}
`,

  "Raw keys (enable raw mode)": `use std::io::{self, Read, Write};

// Enable "raw input" in the toolbar first: keys then arrive one at a time,
// without echo. Move the @ with w/a/s/d; q quits.
fn main() {
    let (w, h) = (30i32, 10i32);
    let (mut x, mut y) = (w / 2, h / 2);
    let mut out = io::stdout();
    let mut key = [0u8; 1];
    print!("\\x1b[?25l"); // hide cursor
    loop {
        let mut frame = String::from("\\x1b[H\\x1b[2J+");
        frame += &"-".repeat(w as usize);
        frame += "+\\r\\n";
        for row in 0..h {
            frame.push('|');
            for col in 0..w { frame.push(if (col, row) == (x, y) { '@' } else { ' ' }); }
            frame += "|\\r\\n";
        }
        frame += "+";
        frame += &"-".repeat(w as usize);
        frame += "+\\r\\nw/a/s/d to move, q to quit\\r\\n";
        out.write_all(frame.as_bytes()).unwrap();
        out.flush().unwrap();

        if io::stdin().read(&mut key).unwrap() == 0 { break; }
        match key[0] {
            b'w' => y = (y - 1).max(0),
            b's' => y = (y + 1).min(h - 1),
            b'a' => x = (x - 1).max(0),
            b'd' => x = (x + 1).min(w - 1),
            b'q' => break,
            _ => {}
        }
    }
    print!("\\x1b[?25h");
    println!("bye!");
}
`,
};
