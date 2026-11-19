// A fake agent for load tests, drawn like an Ink app such as Claude Code: a
// status block redrawn in place many times a second, text scrolling above
// it, phases of work and of waiting for input, and a long conversation that
// it prints again in full when the terminal is resized.
const rows = 14;
const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const rand = (a, b) => a + Math.random() * (b - a);
const color = (i) => `\x1b[38;2;${120 + ((i * 37) % 120)};${150 + ((i * 53) % 100)};${200 - ((i * 29) % 90)}m`;
const history = Array.from({ length: 3000 }, (_, i) => `${color(i)}● ${i} ${'transcript line with some words '.repeat(3)}\x1b[0m`).join('\r\n') + '\r\n';

let frame = 0;
let working = true;
let phaseEnd = Date.now() + rand(3000, 8000);
process.stdout.write(`\x1b[?2004h\x1b[?1004h\x1b[?25l${history}${'\r\n'.repeat(rows)}`);
process.on('SIGWINCH', () => process.stdout.write(`\x1b[2J\x1b[3J\x1b[H${history}${'\r\n'.repeat(rows)}`));
setInterval(() => {
  const now = Date.now();
  if (now > phaseEnd) {
    working = !working;
    phaseEnd = now + (working ? rand(3000, 8000) : rand(2000, 6000));
  }
  if (!working) return;
  frame++;
  let out = `\x1b[${rows}A`;
  if (frame % 12 === 0) {
    for (let i = 0; i < 25; i++) out += `\x1b[2K${color(i)}● \x1b[1mStep ${frame}.${i}\x1b[22m ${'lorem ipsum dolor sit amet consectetur '.repeat(2)}\x1b[0m\r\n`;
  }
  for (let i = 0; i < rows; i++) {
    const text = i === 0 ? `${spin[frame % spin.length]} Thinking… (${frame}s · esc to interrupt)` : `│ ${'tool output '.repeat(4)}${i}`;
    out += `\x1b[2K${color(i + frame)}${text}\x1b[0m\r\n`;
  }
  process.stdout.write(out);
}, 60);
process.stdin.resume();
