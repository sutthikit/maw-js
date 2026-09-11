// #46 poison gate — live-tmux e2e (NOT part of the default-safe suite; needs a real tmux server).
//
// Proves head-truncation is dead: a maximal multi-line message delivered through the REAL
// Tmux.sendText() must arrive at a bracketed-paste-requesting TUI as ONE framed paste
// (\x1b[200~ … \x1b[201~) whose payload round-trips byte-identical. Without framing, tmux
// delivers embedded newlines as raw CR (= Enter keypresses): any chunk-seam stall submits
// the accumulated head mid-paste and only the tail ships — the #46 signature.
//
// Run: bun scripts/poison-46-head-truncation.ts
// Exit 0 = intact; exit 1 = gate failed (prints why). Seen failing pre-fix on 2026-09-11.

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tmux } from "../src/core/transport/tmux-class";

const SESSION = "h46poison";
const dir = mkdtempSync(join(tmpdir(), "poison46-"));
const logPath = join(dir, "chunks.b64");
const probePath = join(dir, "probe.ts");

// Probe = minimal TUI stand-in: requests bracketed paste, logs every raw stdin chunk as base64.
writeFileSync(probePath, `
const fs = require("node:fs");
process.stdout.write("\\x1b[?2004h");
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (c) => fs.appendFileSync(${JSON.stringify(logPath)}, c.toString("base64") + "\\n"));
`);

// Maximal poison: 80 long lines, Thai + emoji (multibyte), unambiguous head/tail markers.
const poison =
  "POISON-HEAD-MARKER 🐕\n" +
  Array.from({ length: 80 }, (_, i) => `L${String(i + 1).padStart(2, "0")} ทดสอบข้อความยาวหลายบรรทัด ${"x".repeat(70)}`).join("\n") +
  "\nPOISON-TAIL-MARKER ❄️";

const tmux = new Tmux();

async function main(): Promise<number> {
  await tmux.tryRun("kill-session", "-t", SESSION);
  await tmux.newSession(SESSION, { detached: true, command: `bun ${probePath}` });
  await new Promise(r => setTimeout(r, 1200));

  await tmux.sendText(SESSION, poison); // the REAL delivery path under test

  await new Promise(r => setTimeout(r, 1000));
  await tmux.tryRun("kill-session", "-t", SESSION);

  if (!existsSync(logPath)) {
    console.error("POISON FAIL: probe logged no chunks — delivery never reached the pane");
    return 1;
  }
  const bytes = readFileSync(logPath, "utf8")
    .split("\n").filter(Boolean)
    .map(line => Buffer.from(line, "base64"))
    .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
  const stream = bytes.toString("utf8");

  const opens = stream.split("\x1b[200~").length - 1;
  const closes = stream.split("\x1b[201~").length - 1;
  if (opens !== 1 || closes !== 1) {
    console.error(`POISON FAIL: expected exactly one bracketed-paste frame, saw open=${opens} close=${closes} — newlines are landing as raw Enter keypresses (#46 head-truncation live)`);
    return 1;
  }

  const payload = stream.slice(stream.indexOf("\x1b[200~") + 6, stream.indexOf("\x1b[201~"))
    .replace(/\r\n?/g, "\n"); // tmux transmits line breaks as CR inside the frame
  if (payload !== poison) {
    console.error(`POISON FAIL: framed payload differs from sent text (sent ${poison.length} chars, framed ${payload.length})`);
    const head = payload.startsWith("POISON-HEAD-MARKER");
    const tail = payload.endsWith("POISON-TAIL-MARKER ❄️");
    console.error(`  head marker present: ${head} · tail marker present: ${tail}`);
    return 1;
  }

  console.log(`POISON PASS: one frame, payload intact (${poison.length} chars, 82 lines, multibyte OK)`);
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error("POISON FAIL: unexpected error", err);
  process.exit(1);
});
