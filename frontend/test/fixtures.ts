import type { LastCheck, PublicMonitor, PublicState } from "../src/api/types";

export const NOW = Date.parse("2026-10-27T12:00:00.000Z");
export const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const emptyUptime = { checks: 0, successfulChecks: 0, percentage: null };

export function mkMonitor(over: Partial<PublicMonitor> & { state: PublicState; name?: string }): PublicMonitor {
  const base: PublicMonitor = {
    id: over.id ?? "3fce024b-dde7-4aa6-9ef9-fd63be37ff98",
    name: over.name ?? "Site principal",
    state: over.state,
    monitoringSince: iso(3 * 86_400_000),
    lastCheck: null,
    ongoingIncident: null,
    uptime: { last24h: emptyUptime, last7d: emptyUptime },
  };
  return { ...base, ...over };
}

/** Monitor com cadência de 30 s, checado há `agoMs` (amostra de 24 h coerente: 2880 checagens). */
export function liveMonitor(state: "operational" | "unavailable", agoMs = 5_000, over: Partial<PublicMonitor> = {}): PublicMonitor {
  const ok = state === "operational";
  return mkMonitor({
    state,
    lastCheck: { checkedAt: iso(agoMs), success: ok, statusCode: ok ? 200 : null, latencyMs: 65, errorKind: ok ? null : "dns" },
    ongoingIncident: ok ? null : { id: "inc-1", startedAt: iso(600_000) },
    uptime: {
      last24h: { checks: 2880, successfulChecks: ok ? 2880 : 2800, percentage: ok ? 100 : 97.22 },
      last7d: { checks: 20160, successfulChecks: ok ? 20160 : 20000, percentage: ok ? 100 : 99.21 },
    },
    ...over,
  });
}

export const check = (agoMs: number, over: Partial<LastCheck> = {}): LastCheck => ({
  checkedAt: iso(agoMs),
  success: true,
  statusCode: 200,
  latencyMs: 60,
  errorKind: null,
  ...over,
});
