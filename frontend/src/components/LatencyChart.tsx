import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { LastCheck } from "../api/types";
import { errorKindLabel, formatDateTime, formatLatency, formatTime } from "../lib/format";

const W = 640;
const H = 214;
const M = { l: 48, r: 14, t: 16, b: 30 };
const LANE = 20; // faixa das falhas, logo abaixo da área de latência
const PW = W - M.l - M.r;
const PH = H - M.t - M.b - LANE;
const MAX_POINTS = 120;

const niceCeil = (v: number) => {
  const steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 20_000, 60_000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 1000) * 1000;
};

interface Pt {
  c: LastCheck;
  t: number;
  x: number;
  y: number;
}

/**
 * Latência no tempo. Uma série só (marca), linha de 2 px; a linha QUEBRA nas falhas (não afirmamos nada entre
 * duas checagens). As falhas ficam numa faixa própria, com forma de "x" (não só cor). O eixo Y considera só
 * checagens bem-sucedidas: o tempo até falhar (ex.: timeout de 10 s) não distorce a escala.
 * Hover/ponteiro e setas do teclado mostram cada checagem. A tabela "Checagens" abaixo é a alternativa em texto.
 */
export function LatencyChart({ checks }: { checks: LastCheck[] }) {
  const [active, setActive] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const model = useMemo(() => {
    const chrono = [...checks].slice(0, MAX_POINTS).reverse();
    if (chrono.length === 0) return null;
    const times = chrono.map((c) => Date.parse(c.checkedAt));
    const t0 = times[0]!;
    const span = Math.max(1, times[times.length - 1]! - t0);
    const okLat = chrono.filter((c) => c.success).map((c) => c.latencyMs);
    const yMax = niceCeil(Math.max(50, ...okLat) * 1.1);
    const pts: Pt[] = chrono.map((c, i) => ({
      c,
      t: times[i]!,
      x: M.l + (chrono.length === 1 ? PW / 2 : ((times[i]! - t0) / span) * PW),
      y: M.t + PH - (c.success ? Math.min(c.latencyMs, yMax) / yMax : 0) * PH,
    }));
    const segments: Pt[][] = [];
    for (const p of pts) {
      if (!p.c.success) { segments.push([]); continue; }
      if (segments.length === 0) segments.push([]);
      segments[segments.length - 1]!.push(p);
    }
    return { pts, yMax, segments: segments.filter((s) => s.length > 0), t0, t1: times[times.length - 1]!, okCount: okLat.length };
  }, [checks]);

  if (!model) return null;
  const { pts, yMax, segments } = model;
  const failures = pts.filter((p) => !p.c.success);
  const ticks = [0, 0.5, 1].map((f) => ({ v: Math.round(yMax * f), y: M.t + PH - f * PH }));
  const a = active !== null ? pts[active] : undefined;

  const nearest = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(p.x - x) < Math.abs(pts[best]!.x - x)) best = i; });
    return best;
  };
  const onMove = (e: PointerEvent) => setActive(nearest(e.clientX));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); setActive((i) => Math.max(0, (i ?? pts.length) - 1)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); setActive((i) => Math.min(pts.length - 1, (i ?? -1) + 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(pts.length - 1); }
    else if (e.key === "Escape") setActive(null);
  };

  const describe = (p: Pt) =>
    p.c.success
      ? `${formatDateTime(p.t)}: ${formatLatency(p.c.latencyMs)}${p.c.statusCode ? `, HTTP ${p.c.statusCode}` : ""}`
      : `${formatDateTime(p.t)}: falha, ${errorKindLabel(p.c.errorKind).toLowerCase()}`;

  return (
    <figure className="chart">
      <figcaption className="chart__caption">
        <span>Latência das últimas {pts.length} checagens</span>
        <span className="chart__legend">
          <span className="chart__key chart__key--line" aria-hidden="true" /> latência
          <span className="chart__key chart__key--fail" aria-hidden="true">×</span> falha
        </span>
      </figcaption>
      <div
        ref={box}
        className="chart__box"
        tabIndex={0}
        role="group"
        aria-label={`Gráfico de latência com ${pts.length} checagens, ${failures.length} ${failures.length === 1 ? "falha" : "falhas"}. Use as setas para percorrer. A tabela de checagens abaixo traz os mesmos dados.`}
        onPointerMove={onMove}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="chart__svg" aria-hidden="true" focusable="false">
          {ticks.map((t) => (
            <g key={t.v}>
              <line className="chart__grid" x1={M.l} x2={W - M.r} y1={t.y} y2={t.y} />
              <text className="chart__tick" x={M.l - 8} y={t.v === 0 ? t.y - 5 : t.y + 4} textAnchor="end">{t.v >= 1000 ? `${t.v / 1000} s` : `${t.v} ms`}</text>
            </g>
          ))}
          <text className="chart__tick" x={M.l - 8} y={M.t + PH + LANE / 2 + 4} textAnchor="end">falhas</text>
          <line className="chart__grid" x1={M.l} x2={W - M.r} y1={M.t + PH + LANE} y2={M.t + PH + LANE} />
          <text className="chart__tick" x={M.l} y={H - 8}>{formatTime(model.t0)}</text>
          <text className="chart__tick" x={W - M.r} y={H - 8} textAnchor="end">{formatTime(model.t1)}</text>

          {segments.map((seg, i) =>
            seg.length === 1 ? (
              <circle key={i} className="chart__dot" cx={seg[0]!.x} cy={seg[0]!.y} r={3} />
            ) : (
              <polyline key={i} className="chart__line" points={seg.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} />
            ),
          )}
          {failures.map((p) => (
            <path key={p.c.checkedAt} className="chart__fail" d={`M${p.x - 3.5} ${M.t + PH + LANE / 2 - 3.5}l7 7m0-7l-7 7`} />
          ))}
          {a && (
            <g>
              <line className="chart__cursor" x1={a.x} x2={a.x} y1={M.t} y2={M.t + PH + LANE} />
              {a.c.success && <circle className="chart__point" cx={a.x} cy={a.y} r={4.5} />}
            </g>
          )}
        </svg>
        {a && (
          <div className="chart__tip" style={{ left: `${(a.x / W) * 100}%` }} data-flip={a.x > W * 0.6 ? "left" : "right"} aria-hidden="true">
            <strong>{a.c.success ? formatLatency(a.c.latencyMs) : "Falha"}</strong>
            <span>{formatDateTime(a.t)}</span>
            <span>{a.c.success ? (a.c.statusCode ? `HTTP ${a.c.statusCode}` : "") : errorKindLabel(a.c.errorKind)}</span>
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">{a ? describe(a) : ""}</p>
    </figure>
  );
}
