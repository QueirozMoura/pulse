# Pulse — frontend

Página pública de status e painel administrativo do Pulse. React 19 + TypeScript + Vite, com uma direção visual própria de
**central de operações**: fundo escuro profundo, brilho controlado e um traçado de sinal que muda de comportamento conforme o estado.

O contrato de API vem de [`backend/docs/API.md`](../backend/docs/API.md); os tipos em `src/api/types.ts` são a transcrição dele.
Capturas de **antes** e **depois** (desktop 1440 px e celular 375 px, todas as telas e estados) estão em
[`docs/screenshots/`](docs/screenshots/).

## Rodar tudo localmente

Precisa de Node 22+ e de um PostgreSQL (o do `backend/docker-compose.yml`, na porta 5433).

```bash
# 1) Banco + API (terminal 1)
cd backend
docker compose up -d --wait          # PostgreSQL em localhost:5433
cp -n .env.example .env              # já traz CORS_ALLOWED_ORIGIN=http://localhost:5173
npm install
npm run db:deploy                    # migrations
npm run admin -- create --username SEU_USUARIO     # cria o administrador (pede a senha, sem eco)
npm run dev                          # API + scheduler em http://localhost:3000

# 2) Frontend (terminal 2)
cd frontend
cp -n .env.example .env              # VITE_API_URL=http://localhost:3000
npm install
npm run dev                          # http://localhost:5173
```

- Página pública: <http://localhost:5173/> (detalhe de um sistema em `/s/<id>`).
- Painel: <http://localhost:5173/admin> (login com o usuário criado acima). Não há link para o painel na página pública, de propósito.
- Para ver o ciclo completo rápido, suba o backend com `MIN_INTERVAL_SECONDS=2 CHECK_TIMEOUT_MS=1500` e cadastre monitores com
  intervalo curto (o formulário oferece 30 s ou mais; intervalos menores só pela API).

**Use `localhost` nos dois lados**, não `127.0.0.1`. O cookie de sessão é `SameSite=Strict`: `localhost:5173` e `localhost:3000`
são o mesmo *site*, mas `127.0.0.1` e `localhost` não são, e o navegador descartaria o cookie.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Vite com recarga a quente em `localhost:5173` |
| `npm test` | Testes (Vitest + Testing Library): 141 testes |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Typecheck + build de produção em `dist/` |
| `npm run check:contrast` | Confere 40 pares de contraste do tema (texto ≥ 4,5:1; borda de campo ≥ 3:1) |
| `npm run preview` | Serve o build para conferir |

## Direção visual

**Conceito:** o próprio sinal é o herói. O topo da página pública é um osciloscópio de largura total, com o veredito geral escrito
grande sobre ele. Tudo o mais é quieto, para o traçado e os estados falarem.

| Eixo | Decisão |
|---|---|
| **Cor** | Fundo azul-violáceo quase preto (`#060912`) e superfícies em três níveis. A marca é um gradiente ultravioleta→gelo (`#8e7cff→#4fd8ff`), usado só no logo, no botão principal, na linha do gráfico e no foco. Os estados têm cores **reservadas** com brilho próprio (ok `#35e8b0`, queda `#ff6a85`, atenção `#ffc25a`, pausa `#9aaccf`) e nunca são usados como decoração. Luz ambiente estática (gradientes radiais fixos), sem fundo animado. |
| **Tipografia** | Archivo variável em largura expandida e peso alto (títulos e números grandes) + Atkinson Hyperlegible Next no texto. Sem mono em rótulos, sem caixa-alta. |
| **Hierarquia por gravidade** | Sistema indisponível ocupa duas colunas e mostra o incidente em destaque; os saudáveis são compactos; **sem dados** e **pausado** ficam atenuados, hachurados e no fim. |
| **Estado nunca só por cor** | Cada estado tem glifo próprio (batimento, linha reta cortada, barras, pontilhado), selo com texto e um ponto "vivo" com comportamento próprio. |

### O traçado do hero

O osciloscópio **só "bate" quando o estado é saudável**. Queda vira linha reta com um ponto de alarme; atraso vira batimento tracejado
âmbar; dado velho, erro e vazio viram linha pontilhada parada. Um traçado batendo nunca aparece em situação de dúvida.

### Movimento

| Onde | O quê | Como |
|---|---|---|
| Hero | Entrada em sequência (uma vez), traçado rolando | CSS (`transform`/`opacity`); loop sem emenda de 8 batimentos |
| Pontos de status | Anéis que respiram (ok), pulsam mais rápido (queda), lentos (atraso); pausado é estático; sem dados é anel vazio | CSS |
| Cards | Entrada em cascata; **reordenação suave** quando um sistema muda de estado; destaque de 1,8 s no card que mudou | `motion` (`layout`) + CSS |
| Números | Deslizam **de um valor real para o outro**; na primeira renderização mostram o valor final na hora (nunca contam do zero, o que sugeriria uma medição que não houve) | `AnimatedNumber` |
| Diálogos | Entrada com mola | CSS |

`prefers-reduced-motion` desliga o traçado rolando, os anéis, as entradas e a reordenação (verificado no navegador: durações ≈ 0, cards visíveis).
Só se animam `transform` e `opacity`; sem `backdrop-filter`, sem partículas.

**Desempenho medido** (Chromium headless, viewport 375 px, hero batendo + 6 cards, CPU estrangulada): **60 fps e zero tarefas longas a 4×**;
≈ 59–60 fps a 6× e a 8× (2–3 tarefas longas de até 65 ms só sob estrangulamento extremo). Desktop: 60 fps.

### Gráficos

- **Latência** (SVG próprio): linha com área e brilho, **faixas hachuradas** nos intervalos de incidente (início → resolução), **×** numa faixa de falhas,
  **anel verde** em cada recuperação, mediana na margem, tooltip por ponteiro e por setas do teclado. A linha **quebra** nas falhas (nada se afirma entre
  duas checagens). O eixo usa só checagens bem-sucedidas, para um timeout de 10 s não distorcer a escala. A largura do gráfico acompanha a tela, então o
  texto mantém o tamanho real no celular.
- **Faixa de checagens**: traços de sucesso (curtos) e falha (altos, com recorte), em quantidade proporcional à largura.
- **Linha do tempo de incidentes**: cada incidente mostra **início → duração → resolução**; o aberto mostra "Em andamento" e a duração **contando**.
- O histórico pedido ao contrato é de **200 checagens** (o teto), para a janela do gráfico ser longa o bastante para conter falhas e recuperações.
  A tabela mostra 15 linhas por vez; "Mostrar mais" revela as já carregadas sem nova chamada, e só depois usa o cursor da API.

## Como o frontend usa o contrato

- **Cookies e CSRF, como no API.md.** Rotas administrativas usam `credentials: "include"`; `POST/PATCH/DELETE` levam `X-CSRF-Token`.
  O token vem de `POST /auth/login` ou `GET /auth/session` e fica **só em memória** (variável de módulo em `src/api/client.ts`):
  nunca em `localStorage`/`sessionStorage`/cookie legível. O cookie de sessão é `HttpOnly`, o JavaScript nem o enxerga.
  Ao recarregar, o token é recuperado por `GET /auth/session`. Rotas públicas usam `credentials: "omit"`.
- **A sessão só é consultada em `/admin`.** Visitantes da página pública não disparam nenhuma chamada a `/auth/*`.
- **Erros** (`src/lib/errorText.ts`): `validation_error` vira erro no campo certo (`issues[].path`); `401` volta ao login com aviso;
  `403 csrf` recarrega a sessão e pede para repetir; `403 origin_not_allowed` aponta o `CORS_ALLOWED_ORIGIN`; `409` explica o limite;
  `429` mostra o prazo do `Retry-After`; falha de rede e `5xx` têm mensagens próprias, e o `requestId` aparece como "Código".
- **Logout** chama `POST /auth/logout` e só então limpa o estado; se o servidor não confirmar, a sessão segue aberta e o erro é mostrado.

## Honestidade da página pública

Nada transforma ausência de dado em "tudo funcionando" (`src/lib/freshness.ts`, coberto por testes). O redesenho manteve todas as regras e
acrescentou o visual correspondente a cada uma:

| Situação | O que aparece |
|---|---|
| Carregando / erro sem nenhum dado | Esqueleto com a silhueta dos cards / "Não foi possível carregar o estado dos sistemas" (e diz que isso não significa que estejam fora do ar) |
| Nenhum monitor cadastrado | "Nenhum sistema monitorado ainda" e o convite, com traçado pontilhado |
| Atualização falhou, mas há leitura anterior | A leitura continua visível com o aviso "Falha ao atualizar" e o ponto da barra "ao vivo" muda para âmbar |
| Sem atualização com sucesso há mais de 3 ciclos (90 s) | Título "Dados desatualizados", traçado âmbar pontilhado **parado**, lista e chips dessaturados, **todos os pontos viram anéis vazios** (nada "ao vivo"), último estado conhecido |
| Checagem muito mais velha que a cadência esperada | "Checagens atrasadas", traçado âmbar tracejado e selo "Operacional, checagem atrasada" |
| Algum sistema `no_data` | Nunca "todos operacionais"; o card diz "Não sabemos o estado" e não mostra latência |
| Somente `paused`/`no_data` | "Nenhum sistema está sendo checado" / "Aguardando as primeiras checagens" |
| Uptime sem checagens | "Sem dados" e barra hachurada (nunca 0% nem 100%); com checagens, sempre "de N checagens" |
| Disponibilidade geral das 24 h | Ponderada pelas checagens reais de cada sistema, com a amostra; "Sem dados" se nenhuma |

Atualização periódica: `usePolling` busca a cada 30 s, pausa com a aba oculta, atualiza ao voltar e, após falhas, espera mais (até 1 min).
As idades usam o relógio do **servidor** (`generatedAt` + tempo decorrido) na lista; um relógio local errado não faz uma checagem recente parecer velha.
A API pública **não expõe o intervalo de checagem**, então "atrasada" usa uma estimativa da cadência (janela observada ÷ checagens de 24 h;
mínimo de 2 min e 3 intervalos de tolerância). A página de detalhe não recebe `generatedAt` e usa o relógio do navegador.

A página pública **nunca** mostra URLs monitoradas nem dados administrativos: elas não existem nas respostas públicas, e um teste confere o DOM.

## Acessibilidade

- Contraste conferido por script (`npm run check:contrast`): texto ≥ 4,5:1 em todas as superfícies, status sobre os fundos translúcidos dos selos, e **bordas de
  campo ≥ 3:1** (token `--control-border`).
- Teclado: link "Ir para o conteúdo", foco visível em gradiente, diálogos nativos (`<dialog>`: foco preso, Esc, foco devolvido, foco inicial explícito),
  foco no conteúdo a cada troca de página, gráfico navegável por setas com anúncio em texto.
- Gráficos têm resumo em texto (`aria-label`) e uma tabela equivalente; falhas usam forma (×, recorte) além de cor.
- Tema único (escuro): a direção visual é de "central de operações". O tema claro anterior foi removido com o redesenho (um sistema visual só, bem acabado).

## Estrutura

```
src/
  api/        client.ts (fetch, erros, CSRF em memória), endpoints.ts, types.ts
  auth/       AuthContext.tsx (sessão; só montado em /admin)
  components/ HeroSignal, LiveDot, SystemCard, UptimeMeter, IncidentTimeline, LatencyChart, CheckStrip,
              AnimatedNumber, feedback (carregando/vazio/erro/aviso), Modal, layouts, motion (provider)
  hooks/      usePolling, usePagedFeed, useChangeFlash, useElementWidth, useDocumentTitle
  lib/        format, freshness (regras de honestidade), history (paginação), stats (percentis, faixas), errorText
  pages/      public/ (StatusPage, MonitorPage), admin/ (login, painel, formulário)
  styles/     tokens, base, layout, components, hero, units, detail, admin
scripts/      check-contrast.mjs
test/         lógica pura, cliente HTTP, páginas públicas, sessão e painel, comportamentos do redesenho (fetch simulado)
docs/screenshots/{before,after}/{desktop,mobile}/   36 telas e estados por versão
```

Dependências de runtime: `react`, `react-dom`, `react-router-dom`, `motion` (reordenação por layout, entradas), `lucide-react` (ícones de ação) e duas
famílias de fonte autohospedadas. Gráficos, polling, cliente HTTP e estado são código do projeto.

## Produção (nada foi implantado)

- Defina `VITE_API_URL` **na hora do build** e sirva `dist/` como site estático com *fallback* para `index.html` (as rotas são do lado do cliente).
- Mantenha frontend e API no **mesmo site** (ex.: `app.exemplo.com` e `api.exemplo.com`): o cookie é `SameSite=Strict` e `__Host-`/`Secure`.
  No backend, `CORS_ALLOWED_ORIGIN=https://app.exemplo.com` e `TRUST_PROXY_HOPS` conforme o proxy.
- Os testes de componentes usam `fetch` simulado e desligam as animações do `motion`; a integração real e as animações foram verificadas à mão no navegador.
