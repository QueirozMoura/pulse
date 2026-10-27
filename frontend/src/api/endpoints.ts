import { csrf, request } from "./client";
import type {
  AdminMonitor,
  HistoryResponse,
  IncidentsResponse,
  MonitorInput,
  PublicMonitor,
  PublicStatusResponse,
  SessionInfo,
} from "./types";

/** Rotas públicas (sem login). */
export const publicApi = {
  status: (signal?: AbortSignal) => request<PublicStatusResponse>("GET", "/public/status", { signal }),
  monitor: (id: string, signal?: AbortSignal) => request<PublicMonitor>("GET", `/public/monitors/${id}`, { signal }),
  history: (id: string, o: { cursor?: string; limit?: number; signal?: AbortSignal } = {}) =>
    request<HistoryResponse>("GET", `/public/monitors/${id}/history`, { query: { cursor: o.cursor, limit: o.limit }, signal: o.signal }),
  incidents: (o: { monitorId?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {}) =>
    request<IncidentsResponse>("GET", "/public/incidents", { query: { monitorId: o.monitorId, cursor: o.cursor, limit: o.limit }, signal: o.signal }),
};

/** Sessão: o token CSRF devolvido vai para a memória do módulo `client`, nunca para o armazenamento do navegador. */
export const authApi = {
  async login(username: string, password: string): Promise<SessionInfo> {
    const s = await request<SessionInfo>("POST", "/auth/login", { body: { username, password } });
    csrf.set(s.csrfToken);
    return s;
  },
  async session(signal?: AbortSignal): Promise<SessionInfo> {
    const s = await request<SessionInfo>("GET", "/auth/session", { signal });
    csrf.set(s.csrfToken);
    return s;
  },
  async logout(): Promise<void> {
    await request<void>("POST", "/auth/logout");
    csrf.clear();
  },
};

/** Administração de monitores (exige sessão; escritas levam X-CSRF-Token automaticamente). */
export const adminApi = {
  list: (signal?: AbortSignal) => request<{ monitors: AdminMonitor[] }>("GET", "/monitors", { signal }),
  create: (input: MonitorInput) => request<AdminMonitor>("POST", "/monitors", { body: input }),
  update: (id: string, patch: Partial<MonitorInput>) => request<AdminMonitor>("PATCH", `/monitors/${id}`, { body: patch }),
  pause: (id: string) => request<AdminMonitor>("POST", `/monitors/${id}/pause`),
  resume: (id: string) => request<AdminMonitor>("POST", `/monitors/${id}/resume`),
  remove: (id: string) => request<void>("DELETE", `/monitors/${id}`),
};
