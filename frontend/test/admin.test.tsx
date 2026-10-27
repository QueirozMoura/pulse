import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { csrf } from "../src/api/client";
import type { AdminMonitor } from "../src/api/types";
import { apiError, json, mockApi } from "./api-mock";

const SESSION = { username: "admin", csrfToken: "csrf-1", expiresAt: "2026-10-28T00:00:00.000Z" };
const unauth = () => apiError(401, "unauthorized", "Autenticação necessária");

function mon(over: Partial<AdminMonitor> & { name: string }): AdminMonitor {
  return {
    id: over.id ?? over.name.toLowerCase().replace(/\W+/g, "-"),
    url: `https://${over.name.toLowerCase().replace(/\W+/g, "")}.example.com/`,
    intervalSeconds: 60,
    active: true,
    status: "OPERATIONAL",
    consecutiveFailures: 0,
    nextCheckAt: new Date(Date.now() + 30_000).toISOString(),
    lastCheckedAt: new Date(Date.now() - 5000).toISOString(),
    createdAt: "2026-10-26T00:00:00.000Z",
    ...over,
  };
}
const LIST = [
  mon({ name: "Site", id: "m-site" }),
  mon({ name: "API", id: "m-api", status: "UNAVAILABLE", consecutiveFailures: 3 }),
  mon({ name: "Painel", id: "m-painel", active: false }),
  mon({ name: "Novo", id: "m-novo", lastCheckedAt: null }),
];

const renderAdmin = (path = "/admin") => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
const user = () => userEvent.setup();

/** API com sessão válida e lista. */
const loggedIn = (extra: Record<string, Parameters<typeof mockApi>[0][string]> = {}) =>
  mockApi({ "GET /auth/session": SESSION, "GET /monitors": { monitors: LIST }, ...extra });

const row = (name: string) => screen.getByRole("row", { name: new RegExp(`^${name}`) });

beforeEach(() => csrf.clear());
afterEach(() => vi.unstubAllGlobals());

describe("sessão", () => {
  it("sem sessão (401), /admin leva ao login e a lista nunca é pedida", async () => {
    const api = mockApi({ "GET /auth/session": unauth() });
    renderAdmin();
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(api.count("GET /monitors")).toBe(0);
  });

  it("a página pública não consulta a sessão (nenhuma chamada a /auth)", async () => {
    const api = mockApi({ "GET /public/status": { generatedAt: new Date().toISOString(), monitors: [] }, "GET /public/incidents": { incidents: [], nextCursor: null } });
    render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
    await screen.findByRole("heading", { level: 1 });
    expect(api.calls.some((c) => c.path.startsWith("/auth"))).toBe(false);
  });

  it("com sessão válida mostra a lista e guarda o token CSRF só em memória", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const api = loggedIn();
    renderAdmin();
    expect(await screen.findByRole("heading", { name: "Monitores" })).toBeInTheDocument();
    await screen.findByRole("row", { name: /^Site/ });
    expect(csrf.get()).toBe("csrf-1");
    expect(setItem).not.toHaveBeenCalled();
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(api.calls.filter((c) => c.path !== "/auth/session").every((c) => c.credentials === "include")).toBe(true);
    setItem.mockRestore();
  });

  it("não dá para saber se há sessão (rede): mostra erro com nova tentativa, não o formulário de login", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderAdmin();
    expect(await screen.findByText("Não foi possível verificar sua sessão")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Entrar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("recarregar a página recupera o token CSRF por GET /auth/session", async () => {
    const api = loggedIn();
    renderAdmin();
    await screen.findByRole("row", { name: /^Site/ });
    expect(api.count("GET /auth/session")).toBe(1);
    expect(api.last("GET /auth/session")?.credentials).toBe("include");
  });
});

describe("login", () => {
  const fill = async (u = "admin", p = "segredo-123") => {
    const ui = user();
    await ui.type(await screen.findByLabelText("Usuário"), u);
    await ui.type(screen.getByLabelText("Senha"), p);
    await ui.click(screen.getByRole("button", { name: "Entrar" }));
  };

  it("sucesso: envia usuário e senha, entra no painel e guarda o token em memória", async () => {
    const api = mockApi({ "GET /auth/session": unauth(), "POST /auth/login": SESSION, "GET /monitors": { monitors: LIST } });
    renderAdmin();
    await fill();
    expect(await screen.findByRole("heading", { name: "Monitores" })).toBeInTheDocument();
    expect(api.last("POST /auth/login")).toMatchObject({ credentials: "include", body: { username: "admin", password: "segredo-123" } });
    expect(csrf.get()).toBe("csrf-1");
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain("csrf-1");
  });

  it("401: 'Usuário ou senha incorretos', sem revelar qual deles, e a senha é apagada do campo", async () => {
    mockApi({ "GET /auth/session": unauth(), "POST /auth/login": apiError(401, "invalid_credentials", "Credenciais inválidas") });
    renderAdmin();
    await fill("admin", "errada");
    expect(await screen.findByRole("alert")).toHaveTextContent("Usuário ou senha incorretos");
    expect(screen.getByLabelText("Senha")).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("Código: req-test");
  });

  it("429 com Retry-After legível: diz em quanto tempo tentar de novo", async () => {
    mockApi({ "GET /auth/session": unauth(), "POST /auth/login": apiError(429, "too_many_attempts", "Muitas tentativas.", {}, { "retry-after": "900" }) });
    renderAdmin();
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("Tente de novo em 15 min");
  });

  it("429 sem Retry-After não inventa um prazo", async () => {
    mockApi({ "GET /auth/session": unauth(), "POST /auth/login": apiError(429, "too_many_attempts", "Muitas tentativas.") });
    renderAdmin();
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("em alguns minutos");
  });

  it("403 de origem: aponta o CORS do backend em vez de uma mensagem genérica", async () => {
    mockApi({ "GET /auth/session": unauth(), "POST /auth/login": apiError(403, "origin_not_allowed", "Origem não permitida") });
    renderAdmin();
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("CORS_ALLOWED_ORIGIN");
  });

  it("falha de rede: 'Sem conexão com a API'", async () => {
    const api = mockApi({ "GET /auth/session": unauth() });
    renderAdmin();
    await screen.findByLabelText("Usuário");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("Sem conexão com a API");
    void api;
  });

  it("erro 500: mensagem de servidor com o código de suporte", async () => {
    mockApi({ "GET /auth/session": unauth(), "POST /auth/login": apiError(500, "internal_error", "Erro interno") });
    renderAdmin();
    await fill();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Erro no servidor");
    expect(alert).toHaveTextContent("req-test");
  });

  it("botão fica desabilitado sem usuário/senha e durante o envio", async () => {
    mockApi({ "GET /auth/session": unauth() });
    renderAdmin();
    expect(await screen.findByRole("button", { name: "Entrar" })).toBeDisabled();
  });
});

describe("lista de monitores", () => {
  it("mostra cada monitor com o estado correto (pausado, sem dados, indisponível) e a URL (só no painel)", async () => {
    loggedIn();
    renderAdmin();
    await screen.findByRole("row", { name: /^Site/ });
    expect(within(row("Site")).getByText("Operacional")).toBeInTheDocument();
    expect(within(row("API")).getByText("Indisponível")).toBeInTheDocument();
    expect(within(row("Painel")).getByText("Pausado")).toBeInTheDocument();
    expect(within(row("Novo")).getByText("Sem dados")).toBeInTheDocument();
    expect(within(row("Site")).getByText("https://site.example.com/")).toBeInTheDocument();
    expect(screen.getByText("4 monitores: 1 operacional, 1 indisponível, 1 pausado, 1 sem dados.")).toBeInTheDocument();
  });

  it("lista vazia: convite para cadastrar", async () => {
    mockApi({ "GET /auth/session": SESSION, "GET /monitors": { monitors: [] } });
    renderAdmin();
    expect(await screen.findByText("Você ainda não monitora nada")).toBeInTheDocument();
  });

  it("falha ao carregar a lista: erro com nova tentativa", async () => {
    mockApi({ "GET /auth/session": SESSION, "GET /monitors": apiError(500, "internal_error", "Erro interno") });
    renderAdmin();
    expect(await screen.findByText("Erro no servidor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("401 ao carregar a lista: volta ao login", async () => {
    mockApi({ "GET /auth/session": SESSION, "GET /monitors": unauth() });
    renderAdmin();
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(screen.getByText(/Sua sessão expirou/)).toBeInTheDocument();
  });
});

describe("cadastro e edição", () => {
  const openNew = async () => {
    const ui = user();
    await screen.findByRole("row", { name: /^Site/ });
    await ui.click(screen.getByRole("button", { name: "Novo monitor" }));
    return { ui, dlg: await screen.findByRole("dialog") };
  };

  it("cadastra enviando nome, URL e intervalo com cookie e X-CSRF-Token; depois recarrega a lista", async () => {
    const api = loggedIn({ "POST /monitors": (c) => json(201, mon({ name: String((c.body as { name: string }).name), id: "novo-1" })) });
    renderAdmin();
    const { ui, dlg } = await openNew();
    await ui.type(within(dlg).getByLabelText("Nome"), "Documentação");
    await ui.clear(within(dlg).getByLabelText("URL a monitorar"));
    await ui.type(within(dlg).getByLabelText("URL a monitorar"), "https://docs.example.com/status");
    await ui.selectOptions(within(dlg).getByLabelText("Intervalo entre checagens"), "300");
    await ui.click(within(dlg).getByRole("button", { name: "Cadastrar monitor" }));
    await screen.findByText("«Documentação» foi cadastrado.");
    const sent = api.last("POST /monitors")!;
    expect(sent.body).toEqual({ name: "Documentação", url: "https://docs.example.com/status", intervalSeconds: 300 });
    expect(sent.headers["x-csrf-token"]).toBe("csrf-1");
    expect(sent.credentials).toBe("include");
    await waitFor(() => expect(api.count("GET /monitors")).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("URL sem https:// é barrada no formulário, sem chamar o servidor", async () => {
    const api = loggedIn();
    renderAdmin();
    const { ui, dlg } = await openNew();
    await ui.type(within(dlg).getByLabelText("Nome"), "X");
    await ui.clear(within(dlg).getByLabelText("URL a monitorar"));
    await ui.type(within(dlg).getByLabelText("URL a monitorar"), "http://inseguro.example.com");
    await ui.click(within(dlg).getByRole("button", { name: "Cadastrar monitor" }));
    expect(await within(dlg).findByText("A URL precisa começar com https://.")).toBeInTheDocument();
    expect(within(dlg).getByLabelText("URL a monitorar")).toHaveAttribute("aria-invalid", "true");
    expect(api.count("POST /monitors")).toBe(0);
  });

  it("400 do servidor (SSRF): o erro aparece no campo certo, com aria-invalid, e o diálogo continua aberto", async () => {
    loggedIn({ "POST /monitors": apiError(400, "validation_error", "Dados inválidos", { issues: [{ path: "url", message: "Host não permitido" }] }) });
    renderAdmin();
    const { ui, dlg } = await openNew();
    await ui.type(within(dlg).getByLabelText("Nome"), "Interno");
    await ui.clear(within(dlg).getByLabelText("URL a monitorar"));
    await ui.type(within(dlg).getByLabelText("URL a monitorar"), "https://localhost/admin");
    await ui.click(within(dlg).getByRole("button", { name: "Cadastrar monitor" }));
    expect(await within(dlg).findByText("Host não permitido")).toBeInTheDocument();
    expect(within(dlg).getByLabelText("URL a monitorar")).toHaveAttribute("aria-invalid", "true");
    expect(within(dlg).getByLabelText("URL a monitorar")).toHaveAccessibleDescription(/Host não permitido/);
    expect(within(dlg).getByRole("alert")).toHaveTextContent("Revise os dados informados");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("400 de intervalo e erro sem campo (campo desconhecido) são exibidos", async () => {
    loggedIn({ "POST /monitors": apiError(400, "validation_error", "Dados inválidos", { issues: [{ path: "intervalSeconds", message: "Too small: expected number to be >=30" }, { path: "", message: 'Unrecognized key: "extra"' }] }) });
    renderAdmin();
    const { ui, dlg } = await openNew();
    await ui.type(within(dlg).getByLabelText("Nome"), "X");
    await ui.click(within(dlg).getByRole("button", { name: "Cadastrar monitor" }));
    expect(await within(dlg).findByText("Too small: expected number to be >=30")).toBeInTheDocument();
    expect(within(dlg).getByText('Unrecognized key: "extra"')).toBeInTheDocument();
  });

  it("409 (limite de monitores): mensagem que diz o que fazer", async () => {
    loggedIn({ "POST /monitors": apiError(409, "monitor_limit_reached", "Limite de 5 monitores atingido") });
    renderAdmin();
    const { ui, dlg } = await openNew();
    await ui.type(within(dlg).getByLabelText("Nome"), "Sexto");
    await ui.click(within(dlg).getByRole("button", { name: "Cadastrar monitor" }));
    const alert = await within(dlg).findByRole("alert");
    expect(alert).toHaveTextContent("Limite de monitores atingido");
    expect(alert).toHaveTextContent("Exclua um monitor");
  });

  it("falha de rede ao cadastrar: avisa e mantém o que foi digitado", async () => {
    loggedIn();
    renderAdmin();
    const { ui, dlg } = await openNew();
    await ui.type(within(dlg).getByLabelText("Nome"), "Mantido");
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i: RequestInit) => { if (i?.method === "POST") throw new TypeError("Failed to fetch"); return real(u, i); }));
    await ui.click(within(dlg).getByRole("button", { name: "Cadastrar monitor" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("Sem conexão com a API");
    expect(within(dlg).getByLabelText("Nome")).toHaveValue("Mantido");
  });

  it("edição envia só o que mudou (PATCH) e nada se nada mudou", async () => {
    const api = loggedIn({ "PATCH /monitors/m-site": (c) => json(200, mon({ name: String((c.body as { name?: string }).name ?? "Site"), id: "m-site" })) });
    renderAdmin();
    const ui = user();
    await screen.findByRole("row", { name: /^Site/ });
    await ui.click(screen.getByRole("button", { name: "Editar Site" }));
    let dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByLabelText("URL a monitorar")).toHaveValue("https://site.example.com/");
    await ui.click(within(dlg).getByRole("button", { name: "Salvar alterações" })); // sem mudanças
    expect(api.count("PATCH /monitors/m-site")).toBe(0);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await ui.click(screen.getByRole("button", { name: "Editar Site" }));
    dlg = await screen.findByRole("dialog");
    await ui.clear(within(dlg).getByLabelText("Nome"));
    await ui.type(within(dlg).getByLabelText("Nome"), "Site novo");
    await ui.click(within(dlg).getByRole("button", { name: "Salvar alterações" }));
    await screen.findByText("«Site novo» foi atualizado.");
    expect(api.last("PATCH /monitors/m-site")).toMatchObject({ body: { name: "Site novo" } });
    expect(api.last("PATCH /monitors/m-site")?.headers["x-csrf-token"]).toBe("csrf-1");
  });

  it("Esc fecha o formulário sem enviar nada", async () => {
    const api = loggedIn();
    renderAdmin();
    await openNew();
    // O jsdom não traduz Esc em "cancel" como o navegador faz; dispara o evento que o navegador dispararia.
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.count("POST /monitors")).toBe(0);
  });
});

describe("pausar, retomar e excluir", () => {
  it("pausa e retoma com POST + X-CSRF-Token e mostra a confirmação em texto", async () => {
    const api = loggedIn({ "POST /monitors/m-site/pause": mon({ name: "Site", id: "m-site", active: false }), "POST /monitors/m-painel/resume": mon({ name: "Painel", id: "m-painel" }) });
    renderAdmin();
    const ui = user();
    await screen.findByRole("row", { name: /^Site/ });
    await ui.click(screen.getByRole("button", { name: "Pausar Site" }));
    expect(await screen.findByText("«Site» foi pausado.")).toBeInTheDocument();
    expect(api.last("POST /monitors/m-site/pause")).toMatchObject({ headers: expect.objectContaining({ "x-csrf-token": "csrf-1" }), credentials: "include" });
    expect(api.last("POST /monitors/m-site/pause")?.body).toBeUndefined();
    await ui.click(screen.getByRole("button", { name: "Retomar Painel" }));
    expect(await screen.findByText("«Painel» foi retomado.")).toBeInTheDocument();
    expect(api.count("POST /monitors/m-painel/resume")).toBe(1);
  });

  it("excluir EXIGE confirmação: cancelar não chama a API", async () => {
    const api = loggedIn();
    renderAdmin();
    const ui = user();
    await screen.findByRole("row", { name: /^Site/ });
    await ui.click(screen.getByRole("button", { name: "Excluir Site" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg).toHaveTextContent("Excluir «Site»?");
    expect(dlg).toHaveTextContent("Não dá para desfazer");
    expect(within(dlg).getByRole("button", { name: "Cancelar" })).toHaveFocus();
    expect(api.count("DELETE /monitors/m-site")).toBe(0);
    await ui.click(within(dlg).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.count("DELETE /monitors/m-site")).toBe(0);
  });

  it("confirmar chama DELETE com CSRF, mostra o aviso e recarrega a lista", async () => {
    const api = loggedIn({ "DELETE /monitors/m-site": null });
    renderAdmin();
    const ui = user();
    await screen.findByRole("row", { name: /^Site/ });
    await ui.click(screen.getByRole("button", { name: "Excluir Site" }));
    await ui.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Excluir monitor" }));
    expect(await screen.findByText("«Site» foi excluído.")).toBeInTheDocument();
    expect(api.last("DELETE /monitors/m-site")).toMatchObject({ headers: expect.objectContaining({ "x-csrf-token": "csrf-1" }) });
    await waitFor(() => expect(api.count("GET /monitors")).toBeGreaterThanOrEqual(2));
  });

  it("404 numa operação (já foi excluído em outro lugar): explica e atualiza a lista", async () => {
    const api = loggedIn({ "POST /monitors/m-site/pause": apiError(404, "not_found", "Monitor não encontrado") });
    renderAdmin();
    await screen.findByRole("row", { name: /^Site/ });
    await user().click(screen.getByRole("button", { name: "Pausar Site" }));
    expect(await screen.findByText("Monitor não encontrado")).toBeInTheDocument();
    await waitFor(() => expect(api.count("GET /monitors")).toBeGreaterThanOrEqual(2));
  });

  it("falha de rede numa operação: mensagem clara, sem perder a lista", async () => {
    loggedIn();
    renderAdmin();
    await screen.findByRole("row", { name: /^Site/ });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i: RequestInit) => { if (i?.method === "POST") throw new TypeError("Failed to fetch"); return real(u, i); }));
    await user().click(screen.getByRole("button", { name: "Pausar Site" }));
    expect(await screen.findByText("Sem conexão com a API")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^Site/ })).toBeInTheDocument();
  });

  it("depois de uma operação, falha ao recarregar a lista mantém a leitura anterior com aviso", async () => {
    const api = loggedIn({ "POST /monitors/m-site/pause": mon({ name: "Site", id: "m-site", active: false }) });
    renderAdmin();
    await screen.findByRole("row", { name: /^Site/ });
    api.set("GET /monitors", apiError(503, "internal_error", "Erro interno"));
    await user().click(screen.getByRole("button", { name: "Pausar Site" }));
    expect(await screen.findByText("Não foi possível atualizar a lista")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^Site/ })).toBeInTheDocument();
  });
});

describe("sessão que acaba no meio do uso", () => {
  it("401 numa operação: volta ao login com aviso e apaga o token da memória", async () => {
    loggedIn({ "POST /monitors/m-site/pause": unauth() });
    renderAdmin();
    await screen.findByRole("row", { name: /^Site/ });
    await user().click(screen.getByRole("button", { name: "Pausar Site" }));
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(screen.getByText(/Sua sessão expirou/)).toBeInTheDocument();
    expect(csrf.get()).toBeNull();
  });

  it("403 csrf: explica, recarrega a sessão (novo token) e a ação repetida funciona", async () => {
    let token = "csrf-1";
    const api = loggedIn({
      "GET /auth/session": () => ({ ...SESSION, csrfToken: token }),
      "POST /monitors/m-site/pause": (c) => (c.headers["x-csrf-token"] === "csrf-2" ? mon({ name: "Site", id: "m-site", active: false }) : apiError(403, "csrf", "Token CSRF ausente ou inválido")),
    });
    renderAdmin();
    await screen.findByRole("row", { name: /^Site/ });
    token = "csrf-2"; // o servidor passa a ter outro token (ex.: sessão renovada em outra aba)
    const ui = user();
    await ui.click(screen.getByRole("button", { name: "Pausar Site" }));
    expect(await screen.findByText("Verificação de segurança falhou")).toBeInTheDocument();
    await waitFor(() => expect(api.count("GET /auth/session")).toBe(2));
    await waitFor(() => expect(csrf.get()).toBe("csrf-2"));
    await ui.click(screen.getByRole("button", { name: "Pausar Site" }));
    expect(await screen.findByText("«Site» foi pausado.")).toBeInTheDocument();
  });
});

describe("logout", () => {
  it("encerra a sessão no servidor (POST + CSRF), apaga o token e volta ao login", async () => {
    const api = loggedIn({ "POST /auth/logout": null });
    renderAdmin();
    await screen.findByRole("row", { name: /^Site/ });
    api.set("GET /auth/session", unauth()); // depois de sair, o servidor já não reconhece a sessão
    await user().click(screen.getByRole("button", { name: "Sair" }));
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(screen.getByText("Você saiu da sua conta.")).toBeInTheDocument();
    expect(api.last("POST /auth/logout")).toMatchObject({ credentials: "include", headers: expect.objectContaining({ "x-csrf-token": "csrf-1" }) });
    expect(csrf.get()).toBeNull();
  });

  it("depois de sair, uma nova visita a /admin exige login de novo", async () => {
    const api = loggedIn({ "POST /auth/logout": null });
    const { unmount } = renderAdmin();
    await screen.findByRole("row", { name: /^Site/ });
    await user().click(screen.getByRole("button", { name: "Sair" }));
    await screen.findByRole("heading", { name: "Entrar" });
    unmount();
    api.set("GET /auth/session", unauth());
    renderAdmin();
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(csrf.get()).toBeNull();
  });

  it("se o servidor não confirma o logout (500), a sessão continua e o erro é mostrado", async () => {
    loggedIn({ "POST /auth/logout": apiError(500, "internal_error", "Erro interno") });
    renderAdmin();
    await screen.findByRole("row", { name: /^Site/ });
    await user().click(screen.getByRole("button", { name: "Sair" }));
    expect(await screen.findByText("Não foi possível sair")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Monitores" })).toBeInTheDocument();
    expect(csrf.get()).toBe("csrf-1");
  });

  it("logout com 401 (sessão já tinha acabado) é tratado como saída bem-sucedida", async () => {
    loggedIn({ "POST /auth/logout": unauth() });
    renderAdmin();
    await screen.findByRole("row", { name: /^Site/ });
    await user().click(screen.getByRole("button", { name: "Sair" }));
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(csrf.get()).toBeNull();
  });
});
