// Confere o contraste WCAG dos pares texto/fundo de src/styles/tokens.css nos temas claro e escuro. Uso: npm run check:contrast
import { readFileSync } from "node:fs";
const css = readFileSync("src/styles/tokens.css", "utf8");
const grab = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
const light = grab(css.split(':root[data-theme="dark"]')[0]);
const dark = grab(css.split(':root[data-theme="dark"]')[1].split("@media")[0]);
const lum = (h) => { const c = [1,3,5].map((i) => parseInt(h.slice(i,i+2),16)/255).map((v) => v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; };
const ratio = (a,b) => { const [x,y] = [lum(a),lum(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05); };
const pairs = [
  ["ink","paper",4.5],["ink","surface",4.5],["ink-2","paper",4.5],["ink-2","surface",4.5],
  ["brand","paper",4.5],["brand","surface",4.5],["brand-ink","brand",4.5],["brand","brand-wash",4.5],
  ["ok","surface",4.5],["ok","ok-wash",4.5],["ok","paper",4.5],
  ["down","surface",4.5],["down","down-wash",4.5],["down","paper",4.5],
  ["pause","surface",4.5],["pause","pause-wash",4.5],["pause","paper",4.5],
  ["warn","surface",4.5],["warn","warn-wash",4.5],["warn","paper",4.5],
  ["hairline-strong","surface",3],["hairline-strong","paper",3],
];
let bad = 0;
for (const [name, t] of [["claro", light], ["escuro", dark]]) {
  console.log(`\n== tema ${name}`);
  for (const [fg,bg,min] of pairs) {
    const r = ratio(t[fg], t[bg]); const okk = r >= min; if (!okk) bad++;
    console.log(`${okk ? "ok  " : "FALHA"} ${fg.padEnd(16)} sobre ${bg.padEnd(10)} ${r.toFixed(2).padStart(5)}:1 (mín ${min})`);
  }
}
console.log(bad ? `\n${bad} par(es) abaixo do mínimo` : "\ntodos os pares passam"); process.exit(bad ? 1 : 0);
