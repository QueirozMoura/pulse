import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Incident, LastCheck } from "../api/types";
import { useElementWidth } from "../hooks/useElementWidth";
import { errorKindLabel, formatClock, formatDateTime, formatLatency } from "../lib/format";
import { incidentBands, latencyStats } from "../lib/stats";

const LANE = 26; // faixa das falhas, logo abaixo da área de latência

/** Geometria em função da largura REAL do contêiner: o texto do gráfico mantém o tamanho verdadeiro em qualquer tela. */
function geometry(W: number) {
  const compact = W < 520;
  // margem direita reservada ao rótulo da mediana (só em telas largas), para ele nunca cobrir a linha
  const M = compact ? { l: 46, r: 12, t: 16, b: 30 } : { l: 56, r: 92, t: 20, b: 34 };
  const H = compact ? 250 : 300;
  return { H, M, PW: W - M.l - M.r, PH: H - M.t - M.b - LANE };
}
const MAX_POINTS = 200;

const niceCeil = (v: number) => {
  const steps = [50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 5000, 10_000, 20_000, 60_000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 1000) * 1000;
};

interface Pt {
  c: LastCheck;
  t: number;
  x: number;
  y: number;
  recovered: boolean;
}

/**
 * Latência no tempo, feita para contar a história do sistema:
 * - linha com área (só checagens bem-sucedidas; a linha QUEBRA nas falhas, pois nada se afirma entre duas checagens);
 * - faixas hachuradas em vermelho nos intervalos de incidente (início → resolução);
 * - "×" numa faixa própria para cada falha e um anel verde em cada recuperação;
 * - linha tracejada da mediana.
 * O eixo Y usa só checagens bem-sucedidas (um timeout de 10 s não distorce a escala).
 * Ponteiro e setas do teclado mostram cada checagem; a tabela abaixo é a alternativa em texto.
 */
export function LatencyChart({ checks, incidents = [] }: { checks: LastCheck[]; incidents?: Incident[] }) {
  const uid = useId().replace(/:/g, "");
  const [active, setActive] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const W = Math.max(300, useElementWidth(box, 760));
  const { H, M, PW, PH } = useMemo(() => geometry(W), [W]);

  const model = useMemo(() => {
    const chrono = [...checks].slice(0, MAX_POINTS).reverse();
    if (chrono.length === 0) return null;
    const times = chrono.map((c) => Date.parse(c.checkedAt));
    const t0 = times[0]!;
    const t1 = times[times.length - 1]!;
    const span = Math.max(1, t1 - t0);
    const yMax = niceCeil(Math.max(50, ...chrono.filter((c) => c.success).map((c) => c.latencyMs)) * 1.12);
    const xOf = (t: number) => M.l + (chrono.length === 1 ? PW / 2 : ((t - t0) / span) * PW);
    const yOf = (ms: number) => M.t + PH - (Math.min(ms, yMax) / yMax) * PH;
    const pts: Pt[] = chrono.map((c, i) => ({ c, t: times[i]!, x: xOf(times[i]!), y: c.success ? yOf(c.latencyMs) : M.t + PH, recovered: c.success && i > 0 && !chrono[i - 1]!.success }));
    const segments: Pt[][] = [];
    for (const p of pts) {
      if (!p.c.success) { segments.push([]); continue; }
      if (segments.length === 0) segments.push([]);
      segments[segments.length - 1]!.push(p);
    }
    const stats = latencyStats(chrono);
    const bands = incidentBands(incidents, t0, t1).map((b) => ({ ...b, x1: xOf(b.start), x2: Math.max(xOf(b.end), xOf(b.start) + 3) }));
    return { pts, yMax, yOf, xOf, t0, t1, segments: segments.filter((s) => s.length > 0), stats, bands };
  }, [checks, incidents, W, M, PW, PH]);

  if (!model) return null;
  const { pts, yMax, segments, stats, bands } = model;
  const failures = pts.filter((p) => !p.c.success);
  const recoveries = pts.filter((p) => p.recovered);
  const yTicks = [0, 0.5, 1].map((f) => ({ v: Math.round(yMax * f), y: M.t + PH - f * PH }));
  const xTicks = pts.length < 2 ? [] : (W < 520 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((f) => ({ t: model.t0 + (model.t1 - model.t0) * f, x: M.l + PW * f }));
  const a = active !== null ? pts[active] : undefined;
  const inIncident = (p: Pt) => bands.some((b) => p.t >= b.start && p.t <= b.end);

  const nearest = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(p.x - x) < Math.abs(pts[best]!.x - x)) best = i; });
    return best;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); setActive((i) => Math.max(0, (i ?? pts.length) - 1)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); setActive((i) => Math.min(pts.length - 1, (i ?? -1) + 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(pts.length - 1); }
    else if (e.key === "Escape") setActive(null);
  };
  const describe = (p: Pt) =>
    p.c.success
      ? `${formatDateTime(p.t)}: ${formatLatency(p.c.latencyMs)}${p.c.statusCode ? `, HTTP ${p.c.statusCode}` : ""}${p.recovered ? ", recuperou" : ""}`
      : `${formatDateTime(p.t)}: falha, ${errorKindLabel(p.c.errorKind).toLowerCase()}`;

  return (
    <figure className="chart">
      <figcaption className="chart__caption">
        <span className="chart__title">Latência das últimas {pts.length} checagens</span>
        <ul className="chart__legend">
          <li><span className="chart__key chart__key--line" aria-hidden="true" />latência</li>
          <li><span className="chart__key chart__key--fail" aria-hidden="true">×</span>falha</li>
          <li><span className="chart__key chart__key--rec" aria-hidden="true" />recuperação</li>
          <li><span className="chart__key chart__key--band" aria-hidden="true" />incidente</li>
        </ul>
      </figcaption>
      <div
        ref={box}
        className="chart__box"
        tabIndex={0}
        role="group"
        aria-label={`Gráfico de latência com ${pts.length} checagens, ${failures.length} ${failures.length === 1 ? "falha" : "falhas"} e ${recoveries.length} ${recoveries.length === 1 ? "recuperação" : "recuperações"}. Use as setas para percorrer. A tabela de checagens abaixo traz os mesmos dados.`}
        onPointerMove={(e: PointerEvent) => setActive(nearest(e.clientX))}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="chart__svg" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={`${uid}-area`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#4fd8ff" stopOpacity="0.34" />
              <stop offset="1" stopColor="#8e7cff" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`${uid}-line`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#8e7cff" />
              <stop offset="1" stopColor="#4fd8ff" />
            </linearGradient>
            <pattern id={`${uid}-hatch`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="7" height="7" fill="rgb(255 106 133 / 0.1)" />
              <line x1="0" y1="0" x2="0" y2="7" stroke="rgb(255 106 133 / 0.4)" strokeWidth="2" />
            </pattern>
          </defs>

          {bands.map((b) => (
            <rect key={b.incidentId} className="chart__band" x={b.x1} y={M.t} width={Math.max(3, b.x2 - b.x1)} height={PH + LANE} fill={`url(#${uid}-hatch)`} />
          ))}
          {yTicks.map((t) => (
            <g key={t.v}>
              <line className="chart__grid" x1={M.l} x2={W - M.r} y1={t.y} y2={t.y} />
              <text className="chart__tick" x={M.l - 10} y={t.v === 0 ? t.y - 5 : t.y + 4} textAnchor="end">{t.v >= 1000 ? `${t.v / 1000} s` : `${t.v} ms`}</text>
            </g>
          ))}
          <text className="chart__tick" x={M.l - 10} y={M.t + PH + LANE / 2 + 4} textAnchor="end">falhas</text>
          <line className="chart__grid" x1={M.l} x2={W - M.r} y1={M.t + PH + LANE} y2={M.t + PH + LANE} />
          {xTicks.map((t) => (
            <text key={t.x} className="chart__tick" x={t.x} y={H - 10} textAnchor={t.x === M.l ? "start" : t.x === W - M.r ? "end" : "middle"}>{formatClock(t.t)}</text>
          ))}

          {stats && stats.samples > 1 && (
            <g>
              <line className="chart__median" x1={M.l} x2={W - M.r + 6} y1={model.yOf(stats.median)} y2={model.yOf(stats.median)} />
              {W >= 520 && <text className="chart__median-label" x={W - M.r + 12} y={model.yOf(stats.median) + 4}>mediana {formatLatency(stats.median)}</text>}
            </g>
          )}
          {segments.map((seg, i) =>
            seg.length === 1 ? (
              <circle key={i} className="chart__dot" cx={seg[0]!.x} cy={seg[0]!.y} r={3.2} />
            ) : (
              <g key={i}>
                <path className="chart__area" fill={`url(#${uid}-area)`} d={`M${seg[0]!.x.toFixed(1)} ${M.t + PH}${seg.map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("")}L${seg[seg.length - 1]!.x.toFixed(1)} ${M.t + PH}Z`} />
                <polyline className="chart__line" stroke={`url(#${uid}-line)`} points={seg.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} />
              </g>
            ),
          )}
          {failures.map((p) => (
            <path key={p.c.checkedAt} className="chart__fail" d={`M${p.x - 4} ${M.t + PH + LANE / 2 - 4}l8 8m0-8l-8 8`} />
          ))}
          {recoveries.map((p) => (
            <g key={p.c.checkedAt}>
              <line className="chart__rec-line" x1={p.x} x2={p.x} y1={p.y} y2={M.t + PH + LANE} />
              <circle className="chart__rec" cx={p.x} cy={p.y} r={5.5} />
            </g>
          ))}
          {a && (
            <g>
              <line className="chart__cursor" x1={a.x} x2={a.x} y1={M.t} y2={M.t + PH + LANE} />
              {a.c.success && <circle className="chart__point" cx={a.x} cy={a.y} r={5} />}
            </g>
          )}
        </svg>
        {a && (
          <div className={`chart__tip${a.c.success ? "" : " chart__tip--fail"}`} style={{ left: `${(a.x / W) * 100}%` }} data-flip={a.x > W * 0.6 ? "left" : "right"} aria-hidden="true">
            <strong>{a.c.success ? formatLatency(a.c.latencyMs) : "Falha"}</strong>
            <span>{formatDateTime(a.t)}</span>
            <span>{a.c.success ? (a.c.statusCode ? `HTTP ${a.c.statusCode}` : "") : errorKindLabel(a.c.errorKind)}</span>
            {a.recovered && <span className="chart__tip-tag chart__tip-tag--ok">recuperou</span>}
            {inIncident(a) && !a.recovered && <span className="chart__tip-tag">durante um incidente</span>}
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">{a ? describe(a) : ""}</p>
    </figure>
  );
}
