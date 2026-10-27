# Pulse — frontend

Página pública de status e painel administrativo do Pulse. React 19 + TypeScript + Vite. Em runtime só há três
dependências além do React: `react-router-dom` e duas famílias de fonte autohospedadas (Bricolage Grotesque e Atkinson
Hyperlegible Next). Sem biblioteca de componentes, de estado, de requisições nem de gráficos: o cliente HTTP, o polling e os
gráficos (SVG) são código deste projeto.

O contrato de API vem de [`backend/docs/API.md`](../backend/docs/API.md); os tipos em `src/api/types.ts` são a transcrição dele.

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
- Para ver o ciclo completo rápido, suba o backend com `MIN_INTERVAL_SECONDS=2 CHECK_TIMEOUT_MS=1500` e cadastre um monitor com
  intervalo curto (o formulário oferece 30 s ou mais; intervalos menores só pela API).

**Use `localhost` nos dois lados**, não `127.0.0.1`. O cookie de sessão é `SameSite=Strict`: `localhost:5173` e `localhost:3000`
são o mesmo *site*, mas `127.0.0.1` e `localhost` não são, e o navegador descartaria o cookie.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Vite com recarga a quente em `localhost:5173` |
| `npm test` | Testes (Vitest + Testing Library): 108 testes |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Typecheck + build de produção em `dist/` |
| `npm run preview` | Serve o build para conferir |

## Configuração

| Variável | Quando | Descrição |
|---|---|---|
| `VITE_API_URL` | **build** (o Vite a embute no JavaScript) | URL base da API, sem barra no final. Em desenvolvimento o padrão é `http://localhost:3000`; num build de produção, defina-a (ou deixe vazia para mesma origem). Não é segredo |

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

A página nunca transforma ausência de dado em "tudo funcionando" (`src/lib/freshness.ts`, coberto por testes):

| Situação | O que aparece |
|---|---|
| Carregando / erro sem nenhum dado | Esqueleto / "Não foi possível carregar o estado dos sistemas" (e diz que isso não significa que estejam fora do ar) |
| Nenhum monitor cadastrado | "Nenhum sistema monitorado ainda" |
| Atualização falhou, mas há leitura anterior | A leitura continua visível com o aviso "Falha ao atualizar" |
| Sem atualização com sucesso há mais de 3 ciclos (90 s) | Título "Dados desatualizados", traçado âmbar, lista esmaecida, último estado conhecido |
| Checagem muito mais velha que a cadência esperada | "Checagens atrasadas" e selo "Operacional, checagem atrasada" |
| Algum sistema `no_data` | Nunca "todos operacionais"; o sistema diz "Não sabemos o estado" |
| Somente `paused`/`no_data` | "Nenhum sistema está sendo checado" / "Aguardando as primeiras checagens" |
| Uptime sem checagens | "Sem dados" (nunca 0% nem 100%); com checagens, sempre "de N checagens" |

Atualização periódica: `usePolling` busca a cada 30 s, pausa com a aba oculta, atualiza ao voltar e, após falhas, espera mais
(até 1 min). As idades usam o relógio do **servidor** (`generatedAt` + tempo decorrido) na lista; um relógio local errado não faz
uma checagem recente parecer velha. A API pública **não expõe o intervalo de checagem**, então "atrasada" usa uma estimativa da
cadência (janela observada ÷ checagens de 24 h; mínimo de 2 min e 3 intervalos de tolerância).

A página pública **nunca** mostra URLs monitoradas nem dados administrativos: elas não existem nas respostas públicas, e um teste confere o DOM.

## Acessibilidade e design

- Estado nunca só por cor: cada um tem **glifo próprio** (batimento, linha reta cortada, barras, pontilhado) **e** texto. Os gráficos usam
  formas distintas para falhas (`×`), têm resumo em texto e uma tabela equivalente; o gráfico de latência é navegável por setas.
- Contraste conferido por script nos dois temas (texto ≥ 4,5:1; bordas de controles ≥ 3:1). Tema claro/escuro seguem o sistema, com alternância manual.
- Teclado: link "Ir para o conteúdo", foco visível, diálogos nativos (`<dialog>`: foco preso, Esc, foco devolvido), foco no conteúdo a cada troca de página.
- `prefers-reduced-motion` desliga o único movimento (o traçado desenhando uma vez).

## Estrutura

```
src/
  api/        client.ts (fetch, erros, CSRF em memória), endpoints.ts, types.ts
  auth/       AuthContext.tsx (sessão; só montado em /admin)
  components/ glifos, traçado, gráficos, listas, avisos, modal, layouts
  hooks/      usePolling, usePagedFeed, useDocumentTitle
  lib/        format, freshness (regras de honestidade), history (paginação), errorText
  pages/      public/ (StatusPage, MonitorPage), admin/ (login, painel, formulário)
  styles/     tokens (cores/tema), base, layout, components
test/         lógica pura, cliente HTTP, páginas públicas, sessão e painel (com fetch simulado)
```

## Produção (nada foi implantado)

- Defina `VITE_API_URL` **na hora do build** e sirva `dist/` como site estático com *fallback* para `index.html` (as rotas são do lado do cliente).
- Mantenha frontend e API no **mesmo site** (ex.: `app.exemplo.com` e `api.exemplo.com`): o cookie é `SameSite=Strict` e `__Host-`/`Secure`.
  No backend, `CORS_ALLOWED_ORIGIN=https://app.exemplo.com` e `TRUST_PROXY_HOPS` conforme o proxy.
- Os testes de componentes usam `fetch` simulado: a integração real foi verificada à mão no navegador (ver o relatório da etapa).
