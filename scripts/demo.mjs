// Generates assets/demo.svg, the animated terminal shown in the README.
// The cloudpin messages are rendered by cloudpin's own formatter (dist/), so
// the demo always matches real output; names and IDs are placeholders.
// Usage: npm run build && node scripts/demo.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatBlock } from "../dist/format.js";

const ROOT = join(import.meta.dirname, "..");
const PIN = "~/code/acme/.cloudpin.yml";

const vercelBlock = formatBlock(
  {
    action: "block",
    provider: "vercel",
    configPath: PIN,
    problems: ['team: expected "team_acme7Kq2", active is "team_side9Xw1" (my-side-project)'],
    fix: "vercel switch (choose the team with ID team_acme7Kq2)",
  },
  ["vercel", "deploy", "--prod"],
  "shell",
);
const agentBlock = formatBlock(
  {
    action: "block",
    provider: "github",
    configPath: PIN,
    problems: ['user: expected "acme-bot", active is "my-personal"'],
    fix: "gh auth switch --user acme-bot",
  },
  ["gh", "pr", "merge", "42"],
  "agent",
);

// Each line: [kind, text]. "cmd" lines are typed; others appear at once.
const scenes = [
  ["cmd", "cat .cloudpin.yml"],
  ["out", "vercel:"],
  ["out", '  team: "team_acme7Kq2" # acme'],
  ["out", "github:"],
  ["out", '  user: "acme-bot"'],
  ["gap", ""],
  ["cmd", "vercel deploy --prod"],
  ...vercelBlock.split("\n").map((l) => ["block", l]),
  ["gap", ""],
  ["note", "# the same check runs inside your AI agent (Claude Code shown)"],
  ["agent", "● Bash(gh pr merge 42)"],
  ...agentBlock.split("\n").map((l) => ["agentout", `  ⎿ ${l}`.replace("  ⎿   ", "     ")]),
  ["agent", "● Blocked by cloudpin: this repo is pinned to acme-bot. I won't work around it;"],
  ["agent", "  switch with `gh auth switch --user acme-bot`, or tell me to continue."],
];

const W = 920;
const LINE = 21;
const TOP = 48;
const CHAR_MS = 45;
const PAUSE_MS = 650;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const color = {
  cmd: "#e6edf3",
  out: "#9da7b3",
  block: "#ff7b72",
  note: "#7d8590",
  agent: "#d2a8ff",
  agentout: "#ffa198",
  gap: "#000",
};

let t = 300;
const rows = [];
const styles = [];
scenes.forEach(([kind, text], i) => {
  const y = TOP + i * LINE;
  const id = `l${i}`;
  if (kind === "cmd") {
    const typeMs = text.length * CHAR_MS;
    rows.push(
      `<text x="24" y="${y}" class="p" style="animation-delay:${t}ms" id="${id}p">~/code/acme $</text>`,
      `<clipPath id="${id}c"><rect x="140" y="${y - 16}" height="22" width="0" style="animation:type${i} ${typeMs}ms steps(${text.length}) ${t}ms forwards"/></clipPath>`,
      `<text x="140" y="${y}" fill="${color.cmd}" clip-path="url(#${id}c)">${esc(text)}</text>`,
    );
    styles.push(`@keyframes type${i}{to{width:${Math.ceil(text.length * 8.45)}px}}`);
    t += typeMs + PAUSE_MS;
  } else {
    if (text.trim() !== "") {
      const weight = text.startsWith("cloudpin: blocked") || text.includes("cloudpin: blocked") ? ' font-weight="700"' : "";
      rows.push(
        `<text x="24" y="${y}" fill="${color[kind]}"${weight} class="f" style="animation-delay:${t}ms" xml:space="preserve">${esc(text)}</text>`,
      );
    }
    t += kind === "gap" ? PAUSE_MS : 90;
  }
});
const total = t + 4000;
const H = TOP + scenes.length * LINE + 16;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="cloudpin blocking a Vercel deploy on the wrong team, and blocking an AI agent's gh command on the wrong account">
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:14px}
.f,.p{opacity:0;animation:show 1ms forwards}
.p{fill:#7ee787}
@keyframes show{to{opacity:1}}
${styles.join("\n")}
svg *{animation-iteration-count:1}
</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<rect width="${W}" height="30" rx="10" fill="#161b22"/>
<rect y="20" width="${W}" height="10" fill="#161b22"/>
<circle cx="20" cy="15" r="6" fill="#ff5f57"/><circle cx="40" cy="15" r="6" fill="#febc2e"/><circle cx="60" cy="15" r="6" fill="#28c840"/>
<text x="${W / 2}" y="20" fill="#7d8590" text-anchor="middle" style="font-size:12px">cloudpin demo</text>
${rows.join("\n")}
<!-- total ${total}ms -->
</svg>
`;
mkdirSync(join(ROOT, "assets"), { recursive: true });
writeFileSync(join(ROOT, "assets", "demo.svg"), svg);
console.log(`wrote assets/demo.svg (${scenes.length} lines, ${(total / 1000).toFixed(1)} s)`);
