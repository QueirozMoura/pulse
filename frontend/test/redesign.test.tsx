import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { csrf } from "../src/api/client";
import type { Incident } from "../src/api/types";
import { AnimatedNumber } from "../src/components/AnimatedNumber";
import { IncidentTimeline } from "../src/components/IncidentTimeline";
import { LatencyChart } from "../src/components/LatencyChart";
import { MotionProvider } from "../src/components/motion";
import { MonitorPage } from "../src/pages/public/MonitorPage";
import { StatusPage } from "../src/pages/public/StatusPage";
import { apiError, mockApi } from "./api-mock";
import { NOW, check, iso, liveMonitor, mkMonitor } from "./fixtures";

const status = (monitors: unknown[], generatedAt = new Date(NOW).toISOString()) => ({ generatedAt, monitors });
const noIncidents = { incidents: [], nextCursor: null };
const wrap = (ui: React.ReactNode) => <MotionProvider><MemoryRouter>{ui}</MemoryRouter></MotionProvider>;

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("AnimatedNumber: nunca conta a partir do zero", () => {
  it("na primeira renderização mostra o valor real na hora", () => {
    render(<AnimatedNumber value={64} format={(n) => `${Math.round(n)} ms`} />);
    expect(screen.getByText("64 ms")).toBeInTheDocument();
  });

  it("quando o valor muda, desliza do valor anterior ao novo e termina exatamente no novo", async () => {
    const { rerender } = render(<AnimatedNumber value={100} format={(n) => `${Math.round(n)}`} ms={400} />);
    rerender(<AnimatedNumber value={200} format={(n) => `${Math.round(n)}`} ms={400} />);
    await advance(120);
    const mid = Number(screen.getByText(/^\d+$/).textContent);
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(200);
    await advance(600);
    expect(screen.getByText("200")).toBeInTheDocument();
  });

  it("com prefers-reduced-motion troca na hora, sem animação", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    const { rerender } = render(<AnimatedNumber value={10} format={(n) => `${Math.round(n)}`} />);
    rerender(<AnimatedNumber value={90} format={(n) => `${Math.round(n)}`} />);
    expect(await screen.findByText("90")).toBeInTheDocument();
  });
});

describe("linha do tempo de incidentes", () => {
  const resolved: Incident = { id: "i1", monitorId: "m1", monitorName: "Blog", status: "resolved", startedAt: iso(600_000), resolvedAt: iso(538_000), durationSeconds: 62 };
  const open: Incident = { id: "i2", monitorId: "m2", monitorName: "API", status: "open", startedAt: iso(600_000), resolvedAt: null, durationSeconds: null };

  it("resolvido: destaca início, duração e resolução, com a duração do contrato", () => {
    render(wrap(<IncidentTimeline incidents={[resolved]} nowMs={NOW} />));
    expect(screen.getByText("Início")).toBeInTheDocument();
    expect(screen.getByText("Resolvido")).toBeInTheDocument();
    expect(screen.getByText("1 min 2 s")).toBeInTheDocument();
    expect(screen.getByText("fora do ar")).toBeInTheDocument();
    expect(screen.queryByText("Em andamento")).toBeNull();
    expect(screen.getAllByRole("time")).toHaveLength(2); // início e fim
    expect(screen.getByRole("link", { name: "Blog" })).toHaveAttribute("href", "/s/m1");
  });

  it("aberto: 'Em andamento', sem horário de resolução, e a duração CONTA até agora", () => {
    const { rerender } = render(wrap(<IncidentTimeline incidents={[open]} nowMs={NOW} />));
    expect(screen.getByText("Em andamento")).toBeInTheDocument();
    expect(screen.getByText("10 min")).toBeInTheDocument();
    expect(screen.getByText("e contando")).toBeInTheDocument();
    expect(screen.queryByText("Resolvido")).toBeNull();
    expect(screen.getAllByRole("time")).toHaveLength(1);
    rerender(wrap(<IncidentTimeline incidents={[open]} nowMs={NOW + 5 * 60_000} />));
    expect(screen.getByText("15 min")).toBeInTheDocument();
  });

  it("a frase completa existe em texto para leitores de tela", () => {
    const { container } = render(wrap(<IncidentTimeline incidents={[resolved]} nowMs={NOW} />));
    expect(container.querySelector(".incident__meta")?.textContent).toMatch(/Começou em .*, durou 1 min 2 s\./);
  });

  it("sem o nome do monitor no detalhe (showMonitor=false)", () => {
    render(wrap(<IncidentTimeline incidents={[resolved]} showMonitor={false} nowMs={NOW} />));
    expect(screen.queryByRole("link", { name: "Blog" })).toBeNull();
  });
});

describe("gráfico de latência: falhas, recuperações e incidentes legíveis", () => {
  // do mais novo para o mais antigo: ok, ok, RECUPEROU, falha, falha, ok, ok
  const checks = [
    check(1000, { latencyMs: 60 }), check(2000, { latencyMs: 62 }), check(3000, { latencyMs: 70 }),
    check(4000, { success: false, statusCode: null, errorKind: "dns", latencyMs: 20 }), check(5000, { success: false, statusCode: null, errorKind: "dns", latencyMs: 22 }),
    check(6000, { latencyMs: 58 }), check(7000, { latencyMs: 61 }),
  ];
  const incident: Incident = { id: "i", monitorId: "m", monitorName: "M", status: "resolved", startedAt: iso(5500), resolvedAt: iso(3500), durationSeconds: 2 };

  it("desenha um × por falha, um anel por recuperação e uma faixa por incidente", () => {
    const { container } = render(<LatencyChart checks={checks} incidents={[incident]} />);
    expect(container.querySelectorAll(".chart__fail")).toHaveLength(2);
    expect(container.querySelectorAll(".chart__rec")).toHaveLength(1);
    expect(container.querySelectorAll(".chart__band")).toHaveLength(1);
    expect(container.querySelectorAll(".chart__line")).toHaveLength(2); // a linha QUEBRA nas falhas
  });

  it("sem incidentes não inventa faixas", () => {
    const { container } = render(<LatencyChart checks={checks} incidents={[]} />);
    expect(container.querySelectorAll(".chart__band")).toHaveLength(0);
  });

  it("o resumo acessível conta falhas e recuperações", () => {
    render(<LatencyChart checks={checks} incidents={[incident]} />);
    expect(screen.getByRole("group", { name: /7 checagens, 2 falhas e 1 recuperação/ })).toBeInTheDocument();
  });

  it("pelo teclado, anuncia a checagem (inclusive 'recuperou') e Esc limpa", async () => {
    const { container } = render(<LatencyChart checks={checks} incidents={[incident]} />);
    const box = screen.getByRole("group");
    box.focus();
    // chronological: [7000,6000,5000,4000,3000,...]; índice 4 = a recuperação (3000)
    for (const key of ["Home", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"]) fireEvent.keyDown(box, { key });
    expect(container.querySelector("p.sr-only")?.textContent).toMatch(/70 ms, HTTP 200, recuperou/);
    expect(container.querySelector(".chart__tip-tag--ok")).not.toBeNull();
    fireEvent.keyDown(box, { key: "ArrowLeft" });
    expect(container.querySelector("p.sr-only")?.textContent).toMatch(/falha, falha de dns/);
    expect(container.querySelector(".chart__tip--fail")).not.toBeNull();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(container.querySelector(".chart__tip")).toBeNull();
  });

  it("só com falhas: mostra as falhas e nenhuma linha de latência (nada a desenhar além dos ×)", () => {
    const only = [check(1000, { success: false, statusCode: null, errorKind: "tls" }), check(2000, { success: false, statusCode: null, errorKind: "tls" })];
    const { container } = render(<LatencyChart checks={only} />);
    expect(container.querySelectorAll(".chart__fail")).toHaveLength(2);
    expect(container.querySelectorAll(".chart__line")).toHaveLength(0);
  });
});

describe("hero e cards da página pública", () => {
  const renderStatus = () => render(wrap(<StatusPage />));

  it("compõe o estado geral só com contagens reais da API", async () => {
    mockApi({
      "GET /public/status": status([
        liveMonitor("operational", 5000, { id: "a", name: "A" }), liveMonitor("operational", 5000, { id: "b", name: "B" }),
        liveMonitor("unavailable", 5000, { id: "c", name: "C" }),
        mkMonitor({ id: "d", name: "D", state: "paused" }), mkMonitor({ id: "e", name: "E", state: "no_data" }),
      ]),
      "GET /public/incidents": noIncidents,
    });
    renderStatus();
    const chips = await screen.findByRole("list", { name: "Composição do estado geral" });
    expect(within(chips).getByText("operacionais").parentElement).toHaveTextContent("2 operacionais");
    expect(chips).toHaveTextContent("1 indisponível");
    expect(chips).toHaveTextContent("1 pausado");
    expect(chips).toHaveTextContent("1 sem dados");
    expect(screen.getByText("Incidentes em andamento").nextElementSibling).toHaveTextContent("1");
  });

  it("disponibilidade 24 h é ponderada pelas checagens reais e mostra a amostra; sem checagens é 'Sem dados'", async () => {
    mockApi({
      "GET /public/status": status([liveMonitor("operational", 5000, { id: "a" }), liveMonitor("unavailable", 5000, { id: "b" })]),
      "GET /public/incidents": noIncidents,
    });
    renderStatus();
    const dd = (await screen.findByText("Disponibilidade 24 h")).nextElementSibling!;
    expect(dd).toHaveTextContent("98,61%"); // (2880 + 2800) / (2880 + 2880)
    expect(dd.nextElementSibling).toHaveTextContent("de 5760 checagens");
  });

  it("só sistemas sem checagem: disponibilidade vira 'Sem dados' (nunca 100%)", async () => {
    mockApi({ "GET /public/status": status([mkMonitor({ id: "d", name: "D", state: "no_data" })]), "GET /public/incidents": noIncidents });
    renderStatus();
    const dd = (await screen.findByText("Disponibilidade 24 h")).nextElementSibling!;
    expect(dd).toHaveTextContent("Sem dados");
    expect(dd.textContent).not.toMatch(/100/);
  });

  it("ordena por gravidade: indisponível primeiro; sem dados e pausado (atenuados) por último", async () => {
    mockApi({
      "GET /public/status": status([
        mkMonitor({ id: "p", name: "Pausado", state: "paused" }), liveMonitor("operational", 5000, { id: "o", name: "Operacional" }),
        mkMonitor({ id: "n", name: "SemDados", state: "no_data" }), liveMonitor("unavailable", 5000, { id: "u", name: "Caido" }),
      ]),
      "GET /public/incidents": noIncidents,
    });
    renderStatus();
    await screen.findByRole("link", { name: "Caido" });
    const names = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual(["Caido", "Operacional", "SemDados", "Pausado"]);
  });

  it("quando um sistema muda de estado numa atualização, o card é destacado e reordenado; os demais não", async () => {
    const api = mockApi({
      "GET /public/status": status([liveMonitor("operational", 5000, { id: "a", name: "Site" }), liveMonitor("operational", 5000, { id: "b", name: "Blog" })]),
      "GET /public/incidents": noIncidents,
    });
    const { container } = renderStatus();
    await screen.findByRole("link", { name: "Site" });
    expect(container.querySelectorAll(".unit--flash")).toHaveLength(0);
    api.set("GET /public/status", status([liveMonitor("operational", 5000, { id: "a", name: "Site" }), liveMonitor("unavailable", 3000, { id: "b", name: "Blog" })], new Date(NOW + 30_000).toISOString()));
    await advance(30_500);
    await waitFor(() => expect(container.querySelectorAll(".unit--flash")).toHaveLength(1));
    expect(container.querySelector(".unit--flash")).toHaveTextContent("Blog");
    expect(screen.getAllByRole("heading", { level: 3 })[0]).toHaveTextContent("Blog");
  });

  it("dados desatualizados: a lista é marcada como esmaecida e nenhum card aparece como 'ao vivo'", async () => {
    const api = mockApi({ "GET /public/status": status([liveMonitor("operational", 5000, { id: "a", name: "Site" })]), "GET /public/incidents": noIncidents });
    const { container } = renderStatus();
    await screen.findByRole("link", { name: "Site" });
    expect(container.querySelector(".live--operational")).not.toBeNull();
    api.set("GET /public/status", apiError(503, "internal_error", "x"));
    await advance(31_000);
    await advance(130_000);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dados desatualizados"));
    expect(container.querySelector(".units--stale")).not.toBeNull();
    expect(container.querySelector(".live--operational")).toBeNull(); // nenhum ponto "vivo" com dado velho
    expect(container.querySelector(".hero--stale")).not.toBeNull();
  });

  it("o osciloscópio só 'bate' no estado saudável: queda, atraso e dado velho NÃO batem", async () => {
    mockApi({ "GET /public/status": status([liveMonitor("operational", 5000, { id: "a" })]), "GET /public/incidents": noIncidents });
    const ok = renderStatus();
    await screen.findByRole("link", { name: /Site principal/ });
    expect(ok.container.querySelector(".signal--ok .signal__run")).not.toBeNull(); // rola batendo
    ok.unmount();

    mockApi({ "GET /public/status": status([liveMonitor("unavailable", 5000, { id: "a" })]), "GET /public/incidents": noIncidents });
    const down = renderStatus();
    await waitFor(() => expect(down.container.querySelector(".signal--down")).not.toBeNull());
    expect(down.container.querySelector(".signal__run")).toBeNull(); // linha reta, sem rolagem
    down.unmount();

    mockApi({ "GET /public/status": status([liveMonitor("operational", 20 * 60_000, { id: "a" })]), "GET /public/incidents": noIncidents });
    const late = renderStatus();
    await waitFor(() => expect(late.container.querySelector(".signal--warn")).not.toBeNull());
    expect(late.container.querySelector(".signal--ok")).toBeNull();
  });
});

describe("detalhe: estatísticas de latência", () => {
  const renderDetail = () =>
    render(
      <MotionProvider>
        <MemoryRouter initialEntries={["/s/m1"]}>
          <Routes><Route path="s/:id" element={<MonitorPage />} /></Routes>
        </MemoryRouter>
      </MotionProvider>,
    );

  it("mediana, p95 e máxima vêm só das checagens bem-sucedidas carregadas, com o tamanho da amostra", async () => {
    mockApi({
      "GET /public/monitors/m1": liveMonitor("operational", 5000, { id: "m1", name: "Site" }),
      "GET /public/monitors/m1/history": { monitorId: "m1", checks: [check(1000, { latencyMs: 50 }), check(2000, { latencyMs: 70 }), check(3000, { latencyMs: 90 }), check(4000, { success: false, statusCode: null, errorKind: "timeout", latencyMs: 10_000 })], nextCursor: null },
      "GET /public/incidents": noIncidents,
    });
    renderDetail();
    const dt = await screen.findByText("Mediana");
    expect(dt.nextElementSibling).toHaveTextContent("70 ms");
    expect(dt.parentElement).toHaveTextContent("de 3 checagens com sucesso");
    expect(screen.getByText("Máxima").nextElementSibling).toHaveTextContent("90 ms"); // o timeout de 10 s não entra
  });

  it("sem nenhuma checagem bem-sucedida: traço, nunca zero", async () => {
    mockApi({
      "GET /public/monitors/m1": liveMonitor("unavailable", 5000, { id: "m1", name: "Site" }),
      "GET /public/monitors/m1/history": { monitorId: "m1", checks: [check(1000, { success: false, statusCode: null, errorKind: "dns" })], nextCursor: null },
      "GET /public/incidents": noIncidents,
    });
    renderDetail();
    const dt = await screen.findByText("Mediana");
    expect(dt.nextElementSibling).toHaveTextContent("—");
    expect(dt.parentElement).toHaveTextContent("sem checagens com sucesso");
  });

  it("a tabela mostra poucas linhas por vez e revela mais sob demanda, sem nova chamada à API", async () => {
    const many = Array.from({ length: 40 }, (_, i) => check((i + 1) * 3000));
    const api = mockApi({
      "GET /public/monitors/m1": liveMonitor("operational", 5000, { id: "m1", name: "Site" }),
      "GET /public/monitors/m1/history": { monitorId: "m1", checks: many, nextCursor: null },
      "GET /public/incidents": noIncidents,
    });
    renderDetail();
    await screen.findByText("40 carregadas");
    expect(screen.getAllByRole("row")).toHaveLength(1 + 15);
    const before = api.count("GET /public/monitors/m1/history");
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: /Mostrar mais 25 checagens/ }));
    expect(screen.getAllByRole("row")).toHaveLength(1 + 40);
    expect(api.count("GET /public/monitors/m1/history")).toBe(before);
    expect(screen.queryByRole("button", { name: /Mostrar mais/ })).toBeNull();
  });

  it("pede ao contrato o limite máximo (200) para dar ao gráfico uma janela longa", async () => {
    const api = mockApi({
      "GET /public/monitors/m1": liveMonitor("operational", 5000, { id: "m1", name: "Site" }),
      "GET /public/monitors/m1/history": { monitorId: "m1", checks: [check(1000)], nextCursor: null },
      "GET /public/incidents": noIncidents,
    });
    renderDetail();
    await screen.findByText("Mediana");
    expect(api.last("GET /public/monitors/m1/history")?.query.limit).toBe("200");
  });
});

describe("painel: filtros por estado", () => {
  const SESSION = { username: "admin", csrfToken: "csrf-1", expiresAt: "2026-10-28T00:00:00.000Z" };
  const mon = (name: string, over = {}) => ({ id: name.toLowerCase(), name, url: `https://${name.toLowerCase()}.example.com/`, intervalSeconds: 60, active: true, status: "OPERATIONAL", consecutiveFailures: 0, nextCheckAt: new Date(Date.now() + 30_000).toISOString(), lastCheckedAt: new Date(Date.now() - 5000).toISOString(), createdAt: "2026-10-26T00:00:00.000Z", ...over });

  it("filtra a lista pelo estado, marca o filtro ativo e permite voltar a 'Todos'", async () => {
    csrf.clear();
    mockApi({ "GET /auth/session": SESSION, "GET /monitors": { monitors: [mon("Site"), mon("Api", { status: "UNAVAILABLE" }), mon("Painel", { active: false })] } });
    render(<MotionProvider><MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter></MotionProvider>);
    const ui = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await screen.findByRole("article", { name: "Site" });
    expect(screen.getAllByRole("article")).toHaveLength(3);

    await ui.click(screen.getByRole("button", { name: /Pausados 1/ }));
    expect(screen.getByRole("button", { name: /Pausados 1/ })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(screen.getByRole("article", { name: "Painel" })).toBeInTheDocument();

    await ui.click(screen.getByRole("button", { name: /Todos 3/ }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
  });

  it("o botão 'Novo monitor' está sempre no cabeçalho e, com a lista vazia, também no convite", async () => {
    csrf.clear();
    mockApi({ "GET /auth/session": SESSION, "GET /monitors": { monitors: [] } });
    render(<MotionProvider><MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter></MotionProvider>);
    await screen.findByText("Você ainda não monitora nada");
    expect(screen.getAllByRole("button", { name: "Novo monitor" })).toHaveLength(2);
  });
});

describe("tabela de checagens: texto das falhas", () => {
  it("'Falha de DNS' não vira 'Falha: falha de dns'; os outros rótulos ganham o prefixo", async () => {
    const { CheckTable } = await import("../src/components/lists");
    render(<CheckTable nowMs={NOW} checks={[check(1000, { success: false, statusCode: null, errorKind: "dns" }), check(2000, { success: false, statusCode: null, errorKind: "timeout" }), check(3000, { success: false, statusCode: null, errorKind: "tls" })]} />);
    expect(screen.getByText("Falha de DNS")).toBeInTheDocument();
    expect(screen.getByText("Falha: tempo esgotado")).toBeInTheDocument();
    expect(screen.getByText("Falha de TLS/certificado")).toBeInTheDocument();
    expect(screen.queryByText(/falha: falha/i)).toBeNull();
  });

  it("sistema que nunca foi checado não mostra o campo de latência (nada de 'Latência —')", async () => {
    mockApi({ "GET /public/status": status([mkMonitor({ id: "n", name: "Novo", state: "no_data" })]), "GET /public/incidents": noIncidents });
    render(wrap(<StatusPage />));
    await screen.findByRole("link", { name: "Novo" });
    expect(screen.queryByText("Latência")).toBeNull();
    expect(screen.getByText("Nenhuma ainda")).toBeInTheDocument();
  });
});
