// Tipos transcritos de backend/docs/API.md. Nada aqui é inventado: se o contrato mudar, mude aqui e o compilador aponta o resto.

export type PublicState = "operational" | "unavailable" | "paused" | "no_data";

export interface LastCheck {
  /** Instante em que a checagem COMEÇOU. */
  checkedAt: string;
  success: boolean;
  statusCode: number | null;
  latencyMs: number;
  /** timeout | dns | connection | tls | http_status | redirect | blocked | unknown (string: o contrato permite novas categorias). */
  errorKind: string | null;
}

export interface UptimeWindow {
  checks: number;
  successfulChecks: number;
  /** null quando não há checagens na janela: nunca 0 nem 100. */
  percentage: number | null;
}

export interface PublicMonitor {
  id: string;
  name: string;
  state: PublicState;
  monitoringSince: string;
  lastCheck: LastCheck | null;
  ongoingIncident: { id: string; startedAt: string } | null;
  uptime: { last24h: UptimeWindow; last7d: UptimeWindow };
}

export interface PublicStatusResponse {
  generatedAt: string;
  /** Checagens em rodadas agendadas (worker externo): cadência prevista, não garantida. null = checagem contínua. */
  checkRounds: { everyMinutes: number } | null;
  monitors: PublicMonitor[];
}

export interface HistoryResponse {
  monitorId: string;
  checks: LastCheck[];
  nextCursor: string | null;
}

export interface Incident {
  id: string;
  monitorId: string;
  monitorName: string;
  status: "open" | "resolved";
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number | null;
}

export interface IncidentsResponse {
  incidents: Incident[];
  nextCursor: string | null;
}

export interface SessionInfo {
  username: string;
  csrfToken: string;
  expiresAt: string;
  /** Limites do servidor (ex.: menor intervalo aceito). Ausente em servidores antigos. */
  limits?: { minIntervalSeconds: number; maxMonitors: number };
}

/** Monitor administrativo (inclui a URL: nunca use nas telas públicas). */
export interface AdminMonitor {
  id: string;
  name: string;
  url: string;
  intervalSeconds: number;
  active: boolean;
  /** false = monitor interno: fora da página pública e das métricas públicas, mas checado e visível no painel. */
  publicVisible: boolean;
  status: "OPERATIONAL" | "UNAVAILABLE";
  consecutiveFailures: number;
  nextCheckAt: string;
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface MonitorInput {
  name: string;
  url: string;
  intervalSeconds: number;
  publicVisible: boolean;
}

export interface ValidationIssue {
  path: string;
  message: string;
}
