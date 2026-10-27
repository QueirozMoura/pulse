// Confere o contraste WCAG dos pares texto/fundo e das bordas de controles de src/styles/tokens.css (tema escuro único).
// Cores translúcidas (rgb(... / a)) são compostas sobre o fundo real antes da conta. Uso: npm run check:contrast
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const tokens = {};
for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|rgb\(\s*\d+\s+\d+\s+\d+\s*(?:\/\s*[\d.]+)?\s*\))/g)) tokens[m[1]] = m[2];

const parse = (v) => {
  if (v.startsWith("#")) return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), a: 1 };
  const [r, g, b, a = 1] = v.match(/[\d.]+/g).map(Number);
  return { r, g, b, a };
};
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const lum = ({ r, g, b }) => { const c = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const C = (name) => parse(tokens[name]);

const surfaces = ["void", "deck", "console", "console-2"];
const rows = [];
const add = (label, fg, bg, min) => rows.push({ label, ratio: ratio(fg, bg), min });

for (const s of surfaces) for (const t of ["ink", "ink-2", "ink-3"]) add(`${t} sobre ${s}`, C(t), C(s), 4.5);
for (const s of ["void", "deck", "console"]) {
  add(`ice (links) sobre ${s}`, C("ice"), C(s), 4.5);
  for (const st of ["ok", "down", "warn", "pause"]) add(`${st} sobre ${s}`, C(st), C(s), 4.5);
}
for (const st of ["ok", "down", "warn", "pause"]) for (const s of ["console", "deck"]) add(`${st} sobre ${st}-wash (selo) em ${s}`, C(st), over(C(`${st}-wash`), C(s)), 4.5);
add("brand-ink sobre uv (botão primário)", C("brand-ink"), C("uv"), 4.5);
add("brand-ink sobre ice (botão primário)", C("brand-ink"), C("ice"), 4.5);
for (const s of ["console", "console-2", "deck"]) add(`borda de campo (control-border) sobre ${s}`, C("control-border"), C(s), 3);

let bad = 0;
for (const r of rows) {
  const ok = r.ratio >= r.min;
  if (!ok) bad++;
  console.log(`${ok ? "ok   " : "FALHA"} ${r.label.padEnd(52)} ${r.ratio.toFixed(2).padStart(5)}:1 (mín ${r.min})`);
}
console.log(bad ? `\n${bad} par(es) abaixo do mínimo` : `\ntodos os ${rows.length} pares passam`);
process.exit(bad ? 1 : 0);
