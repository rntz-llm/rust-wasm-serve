use std::io::BufRead;
fn main() {
    let hs: Vec<_> = (0..4).map(|i| std::thread::spawn(move || i * 10)).collect();
    let s: i32 = hs.into_iter().map(|h| h.join().unwrap()).sum();
    println!("threads sum = {s}");
    std::thread::sleep(std::time::Duration::from_millis(100));
    println!("tty? {}", std::io::IsTerminal::is_terminal(&std::io::stdin()));
    for line in std::io::stdin().lock().lines() { println!("echo: {}", line.unwrap()); }
}
