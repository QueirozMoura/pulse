import { vi } from "vitest";

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: unknown;
}
type Result = Response | object | null;
type Handler = Result | ((c: Call) => Result | Promise<Result>);

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const apiError = (status: number, error: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json(status, { error, message, requestId: "req-test", ...extra }, headers);

/**
 * Instala um fetch falso por rota ("GET /public/status"). Respostas podem ser objetos (200 JSON), `Response`,
 * `null` (204) ou funções. Toda chamada fica registrada em `calls`. Rotas sem handler devolvem 404 no formato do contrato.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const table = new Map(Object.entries(routes));
  const fake = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const call: Call = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: (init.headers ?? {}) as Record<string, string>,
      credentials: init.credentials,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const h = table.get(`${method} ${url.pathname}`);
    if (h === undefined) return apiError(404, "not_found", "Rota não encontrada");
    const res = typeof h === "function" ? await h(call) : h;
    if (res instanceof Response) return res.clone();
    return res === null ? new Response(null, { status: 204 }) : json(200, res);
  });
  vi.stubGlobal("fetch", fake);
  return {
    calls,
    set: (key: string, h: Handler) => void table.set(key, h),
    count: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key).length,
    last: (key: string) => [...calls].reverse().find((c) => `${c.method} ${c.path}` === key),
  };
}
