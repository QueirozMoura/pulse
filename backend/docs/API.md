# Pulse — contrato da API

Contrato da API HTTP do backend. **Todos os exemplos abaixo são respostas reais** capturadas de um servidor
rodando contra PostgreSQL (com URLs de exemplo `*.example.com`/`*.invalid`); só os tokens de sessão foram
substituídos por `<token>`. `test/api-docs.test.ts` falha se uma rota registrada não estiver documentada aqui.

## 1. Convenções

| Item | Regra |
|---|---|
| Formato | JSON (`content-type: application/json`) em requisições com corpo e em todas as respostas. Outros tipos → `415` |
| Datas | ISO 8601 em UTC, ex.: `2026-10-27T01:57:07.652Z` |
| Ids | UUID v4 |
| Corpo máximo | 16 KB (`413 payload_too_large`) |
| Campos desconhecidos | Rejeitados com `400` nas rotas administrativas (sem *mass assignment*); ignorados em *query strings* |
| Cache | Rotas `/public/*`: `cache-control: public, max-age=10`. Todo o resto: `no-store`. Erros nunca são cacheados |
| CORS | Só com `CORS_ALLOWED_ORIGIN` definido, e só para essa origem (com credenciais). Métodos `GET, POST, PATCH, DELETE`; cabeçalhos aceitos `content-type` e `x-csrf-token`. Cabeçalhos **legíveis pelo JavaScript** do frontend além dos básicos: `retry-after` (429) e `x-request-id` |
| Rastreio | Toda resposta traz o cabeçalho `x-request-id`; o mesmo valor vai em `requestId` nos erros e nos logs do servidor |
| Compatibilidade | Campos novos podem ser **adicionados** a qualquer resposta (o cliente deve ignorar campos que não conhece). Remover/renomear campo, mudar tipo ou semântica é mudança incompatível |

### Autenticação das rotas administrativas

`POST /auth/login` devolve um cookie de sessão (`HttpOnly`, `SameSite=Strict`, `Secure` + prefixo `__Host-` em produção) e um
`csrfToken`. Em toda requisição administrativa envie o cookie (`credentials: "include"` no `fetch`). Em `POST`, `PATCH` e
`DELETE` envie também `X-CSRF-Token: <csrfToken>`. Sem sessão → `401`; com sessão mas sem token válido → `403 csrf`.
Se o navegador enviar `Origin`, ele precisa ser o da API ou `CORS_ALLOWED_ORIGIN`, senão `403 origin_not_allowed`.
Após recarregar a página, recupere o token com `GET /auth/session`.

### Formato único de erro

Toda resposta de erro (4xx/5xx), de qualquer rota, tem este formato:

```json
{ "error": "validation_error", "message": "Dados inválidos", "requestId": "req-2v", "issues": [ { "path": "url", "message": "Host não permitido" } ] }
```

| Campo | Tipo | Descrição |
|---|---|---|
| `error` | string | Código estável em `snake_case`. **É ele que o cliente deve testar** (catálogo na §6) |
| `message` | string | Texto em português, seguro para exibir. Pode mudar; não use para lógica |
| `requestId` | string | Identificador para localizar a requisição nos logs |
| `issues` | array, opcional | Só em `validation_error`: `{ path, message }`. `path` vazio = o objeto inteiro (ex.: campo desconhecido) |

Mensagens de erro de rede, banco, stack traces e valores internos **nunca** aparecem; ficam apenas no log do servidor.

### Paginação

Listas que podem crescer usam **cursor opaco**, nunca `offset`. Parâmetros: `limit` (inteiro, com padrão e teto por rota) e
`cursor`. A resposta traz `nextCursor` (string) ou `null` na última página. Para a próxima página, repita a mesma consulta
com `cursor=<nextCursor>`. O cursor é estável mesmo que linhas sejam inseridas ou apagadas entre as páginas, e é válido
por tempo indeterminado (não trate o conteúdo como estrutura). `limit` fora do intervalo → `400`, nunca é "ajustado" em silêncio.

| Rota | `limit` padrão | `limit` máximo |
|---|---|---|
| `GET /public/monitors/:id/history` | 50 | 200 |
| `GET /public/incidents` | 20 | 100 |
| `GET /public/status`, `GET /monitors` | sem paginação; limitadas por `MAX_MONITORS` (padrão 100) | — |

## 2. Resumo das rotas

| Método e rota | Acesso | Descrição |
|---|---|---|
| `GET /health/live` | público | O processo está de pé (não consulta o banco) |
| `GET /health` | público | Saúde do Pulse (banco + scheduler) e batimento do worker |
| `GET /public/status` | público | Estado atual dos monitores públicos (`publicVisible: true`) |
| `GET /public/monitors/:id` | público | Um monitor (mesmo formato da lista) |
| `GET /public/monitors/:id/history` | público | Checagens recentes, paginado |
| `GET /public/incidents` | público | Incidentes abertos e resolvidos, paginado |
| `POST /auth/login` | público (limitada) | Abre a sessão |
| `GET /auth/session` | sessão | Usuário e token CSRF atuais |
| `POST /auth/logout` | sessão + CSRF | Encerra a sessão |
| `POST /monitors` | sessão + CSRF | Cadastra |
| `GET /monitors` | sessão | Lista (com URL) |
| `GET /monitors/:id` | sessão | Detalha (com URL) |
| `PATCH /monitors/:id` | sessão + CSRF | Edita |
| `POST /monitors/:id/pause` | sessão + CSRF | Pausa |
| `POST /monitors/:id/resume` | sessão + CSRF | Retoma |
| `DELETE /monitors/:id` | sessão + CSRF | Exclui |

## 3. Rotas públicas

As rotas públicas **nunca** retornam a URL monitorada, mensagens de erro brutas, contagem interna de falhas, intervalo,
agendamento, versão ou *uptime* do processo. `test/public-api.integration.test.ts` mantém uma lista fechada de chaves
permitidas e falha se surgir qualquer outra.

### Os quatro estados (`state`)

Mutuamente exclusivos, avaliados nesta ordem:

| `state` | Significado | `lastCheck` | `uptime.*.percentage` |
|---|---|---|---|
| `paused` | O administrador pausou o monitor. Não está sendo checado | última antes da pausa, ou `null` | calculado com o histórico existente |
| `no_data` | Ativo, mas **nenhuma checagem aconteceu ainda**. Não se sabe nada | `null` | `null` |
| `unavailable` | Duas ou mais falhas consecutivas; há um incidente aberto | a última (normalmente `success: false`) | calculado |
| `operational` | Checado e sem incidente aberto | a última (normalmente `success: true`) | calculado |

Um monitor `operational` pode ter `lastCheck.success: false` (uma falha isolada ainda não abre incidente: são necessárias duas
seguidas). Uma resolução exige um sucesso.

### Uptime sem inventar dados

`uptime.last24h` e `uptime.last7d` são `{ checks, successfulChecks, percentage }`:

- `percentage = successfulChecks ÷ checks × 100`, duas casas decimais, **sobre as checagens realmente feitas** na janela.
- **Sem checagens → `percentage: null`** (nunca 0 nem 100). Exiba "sem dados".
- `checks` é o tamanho da amostra: mostre-o junto do percentual. Um monitor criado há 1 h tem `last7d` calculado sobre 1 h.
- Períodos sem checagem (monitor pausado, Pulse fora do ar) **não contam** como queda nem como disponibilidade.
- O histórico é mantido por `CHECK_RETENTION_DAYS` (padrão 30), então as duas janelas sempre estão cobertas.

### Categorias de falha (`errorKind`)

`timeout` · `dns` · `connection` · `tls` · `http_status` (a resposta final foi 4xx/5xx) · `redirect` (redirect inválido, em loop ou acima de 5) ·
`blocked` (destino não permitido) · `unknown`. É a única informação sobre *por que* falhou; `null` quando `success: true`.
O `statusCode` é `null` quando não houve resposta HTTP.

### `GET /health/live`

O processo está de pé. **Não consulta o banco** (não acorda o Neon gratuito). Sempre `200 { "status": "ok" }`. Use-o como *health check* da hospedagem.

### `GET /health`

Saúde do próprio Pulse. **Entrada:** nenhuma.

| Resposta | Corpo |
|---|---|
| `200` | `{ "status": "ok", "scheduler": "ok" \| "disabled", "worker"?: {...} }` |
| `503` | `{ "status": "degraded", "scheduler": "ok" \| "stalled" \| "disabled", "worker"?: {...} }` — banco inacessível **ou** scheduler *interno* sem conseguir consultar o banco há mais de `3 × tick + 15 s` |

`scheduler: "disabled"` quando a instância roda só a API (`SCHEDULER_ENABLED=false`), o caso do modo gratuito.

**`worker`** só aparece quando `WORKER_EXPECTED_INTERVAL_MINUTES` está definido (checagens feitas por um worker externo, ex.: GitHub Actions).
Ele é o **batimento real** do worker, lido da tabela `worker_runs`, e **nunca altera o código HTTP**: um agendamento atrasado
do GitHub não pode fazer a hospedagem reiniciar a API.

| Campo | Descrição |
|---|---|
| `status` | `ok` (última rodada bem-sucedida dentro do prazo) \| `late` (passou de `lateAfterMinutes`) \| `never` (nenhuma rodada bem-sucedida) \| `unknown` (não foi possível ler o batimento) |
| `lastSuccessAt` | Fim da última rodada `ok` ou `truncated` (`null` se nunca) |
| `ageSeconds` | Idade dessa rodada |
| `expectedEveryMinutes` / `lateAfterMinutes` | Cadência esperada e limite para considerar atraso (padrão 3×) |
| `lastRun` | Última rodada, qualquer resultado: `{ status, startedAt, finishedAt }` |

A API estar no ar **não** significa que o worker esteja saudável: leia `worker.status`.

**Exemplo**

```http
GET /health

HTTP/1.1 200 OK
cache-control: no-store

{
  "status": "ok",
  "scheduler": "disabled",
  "worker": { "status": "ok", "lastSuccessAt": "2026-10-27T04:52:03.114Z", "ageSeconds": 412, "expectedEveryMinutes": 15, "lateAfterMinutes": 45, "lastRun": { "status": "ok", "startedAt": "2026-10-27T04:52:00.201Z", "finishedAt": "2026-10-27T04:52:03.114Z" } }
}
```


### `GET /public/status`

Todos os monitores (ativos e pausados), do mais antigo ao mais novo. **Entrada:** nenhuma.
**Resposta `200`:** `{ generatedAt, checkRounds, monitors: [Monitor] }`. `checkRounds` é `{ "everyMinutes": 15 }` quando as checagens acontecem em rodadas agendadas (worker externo; a cadência real pode atrasar) ou `null` com o scheduler interno. Com `PUBLIC_CACHE_SECONDS>0` os monitores podem ter até esse tempo de atraso; `generatedAt` é sempre o relógio do servidor no momento da resposta.

`Monitor`:

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | uuid | |
| `name` | string | |
| `state` | `operational` \| `unavailable` \| `paused` \| `no_data` | Ver acima |
| `monitoringSince` | datetime | Quando o monitor foi cadastrado |
| `lastCheck` | objeto \| `null` | `{ checkedAt, success, statusCode \| null, latencyMs, errorKind \| null }`. `checkedAt` é o instante em que a checagem **começou** |
| `ongoingIncident` | `{ id, startedAt }` \| `null` | Incidente aberto, se houver |
| `uptime` | objeto | `{ last24h, last7d }`, cada um `{ checks, successfulChecks, percentage \| null }` |

Erros: apenas `500 internal_error`. O exemplo mostra os quatro estados em uma mesma resposta.

**Exemplo**

```http
GET /public/status

HTTP/1.1 200 OK
cache-control: public, max-age=10

{
  "generatedAt": "2026-10-27T01:58:04.775Z",
  "monitors": [
    {
      "id": "b2c16d84-4cc6-440e-b3fd-2597d2590bf1",
      "name": "Novo monitor",
      "state": "no_data",
      "monitoringSince": "2026-10-26T23:58:04.505Z",
      "lastCheck": null,
      "ongoingIncident": null,
      "uptime": {
        "last24h": {
          "checks": 0,
          "successfulChecks": 0,
          "percentage": null
        },
        "last7d": {
          "checks": 0,
          "successfulChecks": 0,
          "percentage": null
        }
      }
    },
    {
      "id": "a373f990-dd0f-4dd8-83ea-fbfa01096073",
      "name": "Site principal",
      "state": "operational",
      "monitoringSince": "2026-10-27T01:54:37.034Z",
      "lastCheck": {
        "checkedAt": "2026-10-27T01:57:37.673Z",
        "success": true,
        "statusCode": 200,
        "latencyMs": 50,
        "errorKind": null
      },
      "ongoingIncident": null,
      "uptime": {
        "last24h": {
          "checks": 7,
          "successfulChecks": 7,
          "percentage": 100
        },
        "last7d": {
          "checks": 7,
          "successfulChecks": 7,
          "percentage": 100
        }
      }
    },
    {
      "id": "b5ae626b-2f98-45d9-a028-3d98d28e72d7",
      "name": "API de pagamentos",
      "state": "unavailable",
      "monitoringSince": "2026-10-27T01:54:37.054Z",
      "lastCheck": {
        "checkedAt": "2026-10-27T01:57:37.673Z",
        "success": false,
        "statusCode": null,
        "latencyMs": 18,
        "errorKind": "dns"
      },
      "ongoingIncident": {
        "id": "37ea5826-3320-4bb2-9b5e-99216d0569cb",
        "startedAt": "2026-10-27T01:55:07.540Z"
      },
      "uptime": {
        "last24h": {
          "checks": 7,
          "successfulChecks": 0,
          "percentage": 0
        },
        "last7d": {
          "checks": 7,
          "successfulChecks": 0,
          "percentage": 0
        }
      }
    },
    {
      "id": "484bece4-0ec0-4043-8a3b-f65ca1eee548",
      "name": "Blog",
      "state": "operational",
      "monitoringSince": "2026-10-27T01:54:37.079Z",
      "lastCheck": {
        "checkedAt": "2026-10-27T01:57:47.680Z",
        "success": true,
        "statusCode": 200,
        "latencyMs": 99,
        "errorKind": null
      },
      "ongoingIncident": null,
      "uptime": {
        "last24h": {
          "checks": 8,
          "successfulChecks": 4,
          "percentage": 50
        },
        "last7d": {
          "checks": 8,
          "successfulChecks": 4,
          "percentage": 50
        }
      }
    },
    {
      "id": "d13b14c1-5fd6-4c79-abfb-efd8511fa2e8",
      "name": "Painel interno",
      "state": "paused",
      "monitoringSince": "2026-10-27T01:54:37.102Z",
      "lastCheck": null,
      "ongoingIncident": null,
      "uptime": {
        "last24h": {
          "checks": 0,
          "successfulChecks": 0,
          "percentage": null
        },
        "last7d": {
          "checks": 0,
          "successfulChecks": 0,
          "percentage": null
        }
      }
    }
  ]
}
```


### `GET /public/monitors/:id`

Um monitor, no mesmo formato de `Monitor` acima. **Entrada:** `:id` (uuid).
Erros: `400 validation_error` (id inválido), `404 not_found`.

**Exemplo** — monitor indisponível, com incidente aberto

```http
GET /public/monitors/b5ae626b-2f98-45d9-a028-3d98d28e72d7

HTTP/1.1 200 OK
cache-control: public, max-age=10

{
  "id": "b5ae626b-2f98-45d9-a028-3d98d28e72d7",
  "name": "API de pagamentos",
  "state": "unavailable",
  "monitoringSince": "2026-10-27T01:54:37.054Z",
  "lastCheck": {
    "checkedAt": "2026-10-27T01:57:37.673Z",
    "success": false,
    "statusCode": null,
    "latencyMs": 18,
    "errorKind": "dns"
  },
  "ongoingIncident": {
    "id": "37ea5826-3320-4bb2-9b5e-99216d0569cb",
    "startedAt": "2026-10-27T01:55:07.540Z"
  },
  "uptime": {
    "last24h": {
      "checks": 7,
      "successfulChecks": 0,
      "percentage": 0
    },
    "last7d": {
      "checks": 7,
      "successfulChecks": 0,
      "percentage": 0
    }
  }
}
```

**Exemplo (sem dados)** — monitor cadastrado e ainda não checado

```http
GET /public/monitors/b2c16d84-4cc6-440e-b3fd-2597d2590bf1

HTTP/1.1 200 OK
cache-control: public, max-age=10

{
  "id": "b2c16d84-4cc6-440e-b3fd-2597d2590bf1",
  "name": "Novo monitor",
  "state": "no_data",
  "monitoringSince": "2026-10-26T23:58:04.505Z",
  "lastCheck": null,
  "ongoingIncident": null,
  "uptime": {
    "last24h": {
      "checks": 0,
      "successfulChecks": 0,
      "percentage": null
    },
    "last7d": {
      "checks": 0,
      "successfulChecks": 0,
      "percentage": null
    }
  }
}
```

**Exemplo (404)**

```http
GET /public/monitors/00000000-0000-4000-8000-000000000000

HTTP/1.1 404 Not Found

{
  "error": "not_found",
  "message": "Monitor não encontrado",
  "requestId": "req-39"
}
```

**Exemplo (400)**

```http
GET /public/monitors/abc

HTTP/1.1 400 Bad Request

{
  "error": "validation_error",
  "message": "Dados inválidos",
  "requestId": "req-3a",
  "issues": [
    {
      "path": "id",
      "message": "Invalid UUID"
    }
  ]
}
```


### `GET /public/monitors/:id/history`

Checagens do monitor, da mais recente para a mais antiga.

| Entrada | Tipo | Padrão | Descrição |
|---|---|---|---|
| `:id` | uuid | — | |
| `limit` | inteiro 1–200 | 50 | |
| `cursor` | string | — | Valor de `nextCursor` da página anterior |

**Resposta `200`:** `{ monitorId, checks: [{ checkedAt, success, statusCode, latencyMs, errorKind }], nextCursor }`.
Erros: `400 validation_error` (id, `limit` ou `cursor` inválidos), `404 not_found`.

**Exemplo (1ª página)** — limit=2

```http
GET /public/monitors/a373f990-dd0f-4dd8-83ea-fbfa01096073/history?limit=2

HTTP/1.1 200 OK
cache-control: public, max-age=10

{
  "monitorId": "a373f990-dd0f-4dd8-83ea-fbfa01096073",
  "checks": [
    {
      "checkedAt": "2026-10-27T01:57:37.673Z",
      "success": true,
      "statusCode": 200,
      "latencyMs": 50,
      "errorKind": null
    },
    {
      "checkedAt": "2026-10-27T01:57:07.652Z",
      "success": true,
      "statusCode": 200,
      "latencyMs": 65,
      "errorKind": null
    }
  ],
  "nextCursor": "MjAyNi0xMC0yN1QwMTo1NzowNy42NTJafDE4NzZmMmFmLTQ5ZmUtNDgwMy1iMzk2LTRlYTE3MTQ3MDRmZQ"
}
```

**Exemplo (2ª página)** — usando o nextCursor anterior

```http
GET /public/monitors/a373f990-dd0f-4dd8-83ea-fbfa01096073/history?limit=2&cursor=MjAyNi0xMC0yN1QwMTo1NzowNy42NTJafDE4NzZmMmFmLTQ5ZmUtNDgwMy1iMzk2LTRlYTE3MTQ3MDRmZQ

HTTP/1.1 200 OK
cache-control: public, max-age=10

{
  "monitorId": "a373f990-dd0f-4dd8-83ea-fbfa01096073",
  "checks": [
    {
      "checkedAt": "2026-10-27T01:56:37.624Z",
      "success": true,
      "statusCode": 200,
      "latencyMs": 69,
      "errorKind": null
    },
    {
      "checkedAt": "2026-10-27T01:56:07.600Z",
      "success": true,
      "statusCode": 200,
      "latencyMs": 91,
      "errorKind": null
    }
  ],
  "nextCursor": "MjAyNi0xMC0yN1QwMTo1NjowNy42MDBafDRjZTEwMzIwLWQ0YTQtNDdkOS1hNmIzLTc1ZGQ4OTMzYzY0Yg"
}
```

**Exemplo (400)**

```http
GET /public/monitors/a373f990-dd0f-4dd8-83ea-fbfa01096073/history?limit=0

HTTP/1.1 400 Bad Request

{
  "error": "validation_error",
  "message": "Dados inválidos",
  "requestId": "req-3d",
  "issues": [
    {
      "path": "limit",
      "message": "Too small: expected number to be >=1"
    }
  ]
}
```


### `GET /public/incidents`

Incidentes de todos os monitores, do mais recente para o mais antigo. Um incidente **abre** na 2ª falha consecutiva e **resolve**
na primeira checagem bem-sucedida seguinte. Incidentes de monitores excluídos desaparecem junto com eles; os de monitores
pausados continuam listados.

| Entrada | Tipo | Padrão | Descrição |
|---|---|---|---|
| `limit` | inteiro 1–100 | 20 | |
| `cursor` | string | — | |
| `monitorId` | uuid | — | Só os incidentes desse monitor (monitor inexistente → lista vazia) |
| `status` | `open` \| `resolved` | — | Filtra |

**Resposta `200`:** `{ incidents: [Incident], nextCursor }`.
`Incident`: `{ id, monitorId, monitorName, status: "open" | "resolved", startedAt, resolvedAt | null, durationSeconds | null }`.
`durationSeconds` só existe quando resolvido; para um incidente aberto calcule no cliente a partir de `startedAt`.
Erros: `400 validation_error`.

**Exemplo**

```http
GET /public/incidents

HTTP/1.1 200 OK
cache-control: public, max-age=10

{
  "incidents": [
    {
      "id": "bbf85c82-5253-4534-ad2a-3b1fa1e1a6c0",
      "monitorId": "484bece4-0ec0-4043-8a3b-f65ca1eee548",
      "monitorName": "Blog",
      "status": "resolved",
      "startedAt": "2026-10-27T01:55:07.541Z",
      "resolvedAt": "2026-10-27T01:56:17.607Z",
      "durationSeconds": 70
    },
    {
      "id": "37ea5826-3320-4bb2-9b5e-99216d0569cb",
      "monitorId": "b5ae626b-2f98-45d9-a028-3d98d28e72d7",
      "monitorName": "API de pagamentos",
      "status": "open",
      "startedAt": "2026-10-27T01:55:07.540Z",
      "resolvedAt": null,
      "durationSeconds": null
    }
  ],
  "nextCursor": null
}
```

**Exemplo (filtro)** — status=open

```http
GET /public/incidents?status=open

HTTP/1.1 200 OK
cache-control: public, max-age=10

{
  "incidents": [
    {
      "id": "37ea5826-3320-4bb2-9b5e-99216d0569cb",
      "monitorId": "b5ae626b-2f98-45d9-a028-3d98d28e72d7",
      "monitorName": "API de pagamentos",
      "status": "open",
      "startedAt": "2026-10-27T01:55:07.540Z",
      "resolvedAt": null,
      "durationSeconds": null
    }
  ],
  "nextCursor": null
}
```

**Exemplo (paginado)** — limit=1 devolve nextCursor

```http
GET /public/incidents?limit=1

HTTP/1.1 200 OK
cache-control: public, max-age=10

{
  "incidents": [
    {
      "id": "bbf85c82-5253-4534-ad2a-3b1fa1e1a6c0",
      "monitorId": "484bece4-0ec0-4043-8a3b-f65ca1eee548",
      "monitorName": "Blog",
      "status": "resolved",
      "startedAt": "2026-10-27T01:55:07.541Z",
      "resolvedAt": "2026-10-27T01:56:17.607Z",
      "durationSeconds": 70
    }
  ],
  "nextCursor": "MjAyNi0xMC0yN1QwMTo1NTowNy41NDFafGJiZjg1YzgyLTUyNTMtNDUzNC1hZDJhLTNiMWZhMWUxYTZjMA"
}
```


## 4. Autenticação

### `POST /auth/login`

Abre a sessão. **Entrada (JSON):** `username` (string, 1–64) e `password` (string, 1–128). O usuário não diferencia maiúsculas de minúsculas.

| Resposta | Quando |
|---|---|
| `200` | `{ username, csrfToken, expiresAt, limits }` + cabeçalho `set-cookie`. `limits`: `{ minIntervalSeconds, maxMonitors }` |
| `400 validation_error` | Corpo ausente ou campos inválidos |
| `401 invalid_credentials` | Usuário inexistente **ou** senha errada (mesma resposta e mesmo tempo) |
| `403 origin_not_allowed` | `Origin` de outro site |
| `429 too_many_attempts` | Muitas falhas (padrão: 5 por IP ou 30 globais em 15 min). Cabeçalho `retry-after` em segundos. Bloqueia mesmo com a senha correta |

Os cabeçalhos abaixo foram capturados de um login real (o valor do cookie foi omitido):

```http
POST /auth/login
content-type: application/json

{ "username": "admin", "password": "••••••••••••" }

HTTP/1.1 200 OK
set-cookie: pulse_session=<token>; Path=/; Expires=Tue, 27 Oct 2026 13:56:31 GMT; HttpOnly; SameSite=Strict
cache-control: no-store

{ "username": "admin", "csrfToken": "fnGxExs1TYGdt93ZqIiCzh35evaXgV4U2aKAjmV1Gtw", "expiresAt": "2026-10-27T13:56:31.189Z", "limits": { "minIntervalSeconds": 30, "maxMonitors": 100 } }
```

Em produção o cookie se chama `__Host-pulse_session` e inclui `Secure`.

**Exemplo (401)**

```http
POST /auth/login
content-type: application/json

{
  "username": "admin",
  "password": "senha errada"
}

HTTP/1.1 401 Unauthorized
cache-control: no-store

{
  "error": "invalid_credentials",
  "message": "Credenciais inválidas",
  "requestId": "req-3i"
}
```

**Exemplo (400)**

```http
POST /auth/login
content-type: application/json

{
  "username": "admin"
}

HTTP/1.1 400 Bad Request
cache-control: no-store

{
  "error": "validation_error",
  "message": "Dados inválidos",
  "requestId": "req-3j",
  "issues": [
    {
      "path": "password",
      "message": "Invalid input: expected string, received undefined"
    }
  ]
}
```


429 real (após 5 falhas do mesmo IP):

```http
HTTP/1.1 429 Too Many Requests
retry-after: 900

{ "error": "too_many_attempts", "message": "Muitas tentativas. Tente novamente mais tarde.", "requestId": "req-z" }
```

### `GET /auth/session`

Exige sessão. **Entrada:** nenhuma. **Resposta `200`:** `{ username, csrfToken, expiresAt, limits: { minIntervalSeconds, maxMonitors } }`. Erros: `401`.

**Exemplo**

```http
GET /auth/session

HTTP/1.1 200 OK
cache-control: no-store

{
  "username": "admin",
  "csrfToken": "39s6yJMXZCa0xrdnCGh7GccDlLbc6Lo3I4Q4jz2qTOA",
  "expiresAt": "2026-10-27T13:58:04.688Z",
  "limits": { "minIntervalSeconds": 30, "maxMonitors": 100 }
}
```


### `POST /auth/logout`

Exige sessão e `X-CSRF-Token`. **Entrada:** nenhuma. **Resposta `204`** (sem corpo); a sessão é apagada no servidor e o cookie é limpo.
Erros: `401 unauthorized`, `403 csrf`.

**Exemplo**

```http
POST /auth/logout

HTTP/1.1 204 No Content
cache-control: no-store
```


## 5. Administração de monitores

Todas exigem sessão; as que alteram dados exigem também `X-CSRF-Token`. Respondem com a URL monitorada e dados internos,
por isso **nunca** são públicas.

`Monitor` administrativo: `{ id, name, url, intervalSeconds, active, publicVisible, status: "OPERATIONAL" | "UNAVAILABLE", consecutiveFailures, nextCheckAt, lastCheckedAt | null, createdAt }`.
(`status` aqui é o estado interno; para exibição ao público use o `state` das rotas `/public`.)

Regras de entrada:

| Campo | Regra |
|---|---|
| `name` | string, 1–100 caracteres (espaços nas pontas são removidos) |
| `url` | **HTTPS** obrigatório, até 2048 caracteres, sem usuário/senha, sem `localhost`/sufixos internos, sem IP privado/reservado em qualquer notação. Normalizada (ex.: `https://example.com` → `https://example.com/`). Mesmo uma URL aceita aqui é revalidada a cada conexão (DNS que aponta para a rede interna é bloqueado; redirects são seguidos até 5 vezes, validando cada destino) |
| `intervalSeconds` | inteiro entre `max(MIN_INTERVAL_SECONDS, CHECK_TIMEOUT_MS/1000 + 1)` (padrão **30**) e **86400** |
| `publicVisible` | booleano, opcional, padrão **`true`**. `false` = monitor **interno**: continua sendo checado e aparece nas rotas administrativas, mas some de `/public/status`, das métricas e incidentes públicos, e `GET /public/monitors/:id` e `/history` respondem `404` (idêntico a um id inexistente). Alterar não muda pausa, intervalo nem agendamento |

### `POST /monitors`

**Entrada:** `{ name, url, intervalSeconds, publicVisible? }` (`name`, `url` e `intervalSeconds` obrigatórios; `publicVisible` opcional, padrão `true`; campos extras → `400`). **Resposta `201`:** `Monitor` administrativo.
A primeira checagem acontece em poucos segundos.

| Erro | Quando |
|---|---|
| `400 validation_error` | Entrada inválida (ver `issues`) |
| `401` / `403 csrf` / `403 origin_not_allowed` | Autenticação/CSRF |
| `409 monitor_limit_reached` | Já existem `MAX_MONITORS` monitores |

**Exemplo**

```http
POST /monitors
content-type: application/json

{
  "name": "Documentação",
  "url": "https://docs.example.com/status",
  "intervalSeconds": 60
}

HTTP/1.1 201 Created
cache-control: no-store

{
  "id": "238f20d6-8632-423d-8bc8-912fc0d6620b",
  "name": "Documentação",
  "url": "https://docs.example.com/status",
  "intervalSeconds": 60,
  "active": true,
  "status": "OPERATIONAL",
  "consecutiveFailures": 0,
  "nextCheckAt": "2026-10-27T01:58:05.020Z",
  "lastCheckedAt": null,
  "createdAt": "2026-10-27T01:58:05.020Z"
}
```

**Exemplo (400, HTTP sem TLS)**

```http
POST /monitors
content-type: application/json

{
  "name": "X",
  "url": "http://x.example.com",
  "intervalSeconds": 60
}

HTTP/1.1 400 Bad Request
cache-control: no-store

{
  "error": "validation_error",
  "message": "Dados inválidos",
  "requestId": "req-3o",
  "issues": [
    {
      "path": "url",
      "message": "A URL deve usar HTTPS"
    }
  ]
}
```

**Exemplo (400, IP interno + campo desconhecido)**

```http
POST /monitors
content-type: application/json

{
  "name": "X",
  "url": "https://169.254.169.254/latest",
  "intervalSeconds": 60,
  "extra": 1
}

HTTP/1.1 400 Bad Request
cache-control: no-store

{
  "error": "validation_error",
  "message": "Dados inválidos",
  "requestId": "req-3p",
  "issues": [
    {
      "path": "url",
      "message": "Host não permitido"
    },
    {
      "path": "",
      "message": "Unrecognized key: \"extra\""
    }
  ]
}
```

**Exemplo (403, sem token CSRF)**

```http
POST /monitors
content-type: application/json

{
  "name": "X",
  "url": "https://x.example.com",
  "intervalSeconds": 60
}

HTTP/1.1 403 Forbidden
cache-control: no-store

{
  "error": "csrf",
  "message": "Token CSRF ausente ou inválido",
  "requestId": "req-3n"
}
```

**Exemplo (409)**

```http
POST /monitors
content-type: application/json

{
  "name": "Extra",
  "url": "https://extra.example.com",
  "intervalSeconds": 60
}

HTTP/1.1 409 Conflict
cache-control: no-store

{
  "error": "monitor_limit_reached",
  "message": "Limite de 5 monitores atingido",
  "requestId": "req-9"
}
```


### `GET /monitors`

**Entrada:** nenhuma. **Resposta `200`:** `{ monitors: [Monitor] }` do mais antigo ao mais novo (no máximo `MAX_MONITORS`). Erros: `401`.

**Exemplo**

```http
GET /monitors

HTTP/1.1 200 OK
cache-control: no-store

{
  "monitors": [
    {
      "id": "b2c16d84-4cc6-440e-b3fd-2597d2590bf1",
      "name": "Novo monitor",
      "url": "https://novo.example.com",
      "intervalSeconds": 30,
      "active": true,
      "status": "OPERATIONAL",
      "consecutiveFailures": 0,
      "nextCheckAt": "2026-10-28T01:58:04.505Z",
      "lastCheckedAt": null,
      "createdAt": "2026-10-26T23:58:04.505Z"
    },
    {
      "id": "a373f990-dd0f-4dd8-83ea-fbfa01096073",
      "name": "Site principal",
      "url": "https://example.com/",
      "intervalSeconds": 30,
      "active": true,
      "status": "OPERATIONAL",
      "consecutiveFailures": 0,
      "nextCheckAt": "2026-10-27T01:58:07.673Z",
      "lastCheckedAt": "2026-10-27T01:57:37.673Z",
      "createdAt": "2026-10-27T01:54:37.034Z"
    },
    {
      "id": "b5ae626b-2f98-45d9-a028-3d98d28e72d7",
      "name": "API de pagamentos",
      "url": "https://pagamentos-api.invalid/health",
      "intervalSeconds": 30,
      "active": true,
      "status": "UNAVAILABLE",
      "consecutiveFailures": 7,
      "nextCheckAt": "2026-10-27T01:58:07.673Z",
      "lastCheckedAt": "2026-10-27T01:57:37.673Z",
      "createdAt": "2026-10-27T01:54:37.054Z"
    },
    {
      "id": "484bece4-0ec0-4043-8a3b-f65ca1eee548",
      "name": "Blog",
      "url": "https://example.org/",
      "intervalSeconds": 30,
      "active": true,
      "status": "OPERATIONAL",
      "consecutiveFailures": 0,
      "nextCheckAt": "2026-10-27T01:58:17.680Z",
      "lastCheckedAt": "2026-10-27T01:57:47.680Z",
      "createdAt": "2026-10-27T01:54:37.079Z"
    },
    {
      "id": "d13b14c1-5fd6-4c79-abfb-efd8511fa2e8",
      "name": "Painel interno",
      "url": "https://painel.example.com/",
      "intervalSeconds": 30,
      "active": false,
      "status": "OPERATIONAL",
      "consecutiveFailures": 0,
      "nextCheckAt": "2026-10-27T01:54:37.101Z",
      "lastCheckedAt": null,
      "createdAt": "2026-10-27T01:54:37.102Z"
    }
  ]
}
```


### `GET /monitors/:id`

**Entrada:** `:id`. **Resposta `200`:** `Monitor` administrativo. Erros: `400` (id inválido), `401`, `404 not_found`.

**Exemplo**

```http
GET /monitors/b5ae626b-2f98-45d9-a028-3d98d28e72d7

HTTP/1.1 200 OK
cache-control: no-store

{
  "id": "b5ae626b-2f98-45d9-a028-3d98d28e72d7",
  "name": "API de pagamentos",
  "url": "https://pagamentos-api.invalid/health",
  "intervalSeconds": 30,
  "active": true,
  "status": "UNAVAILABLE",
  "consecutiveFailures": 7,
  "nextCheckAt": "2026-10-27T01:58:07.673Z",
  "lastCheckedAt": "2026-10-27T01:57:37.673Z",
  "createdAt": "2026-10-27T01:54:37.054Z"
}
```

**Exemplo (404)**

```http
GET /monitors/238f20d6-8632-423d-8bc8-912fc0d6620b

HTTP/1.1 404 Not Found
cache-control: no-store

{
  "error": "not_found",
  "message": "Monitor não encontrado",
  "requestId": "req-3v"
}
```

**Exemplo (401)**

```http
GET /monitors

HTTP/1.1 401 Unauthorized
cache-control: no-store

{
  "error": "unauthorized",
  "message": "Autenticação necessária",
  "requestId": "req-3h"
}
```


### `PATCH /monitors/:id`

**Entrada:** ao menos um entre `name`, `url`, `intervalSeconds`, `publicVisible` (mesmas regras; qualquer outro campo → `400`). **Resposta `200`:** `Monitor` administrativo atualizado.
Trocar a `url` agenda uma checagem imediata. Reduzir o intervalo antecipa a próxima checagem. Resultados de uma checagem que
estava em andamento com a URL antiga são descartados. Erros: `400`, `401`, `403`, `404`.

**Exemplo**

```http
PATCH /monitors/238f20d6-8632-423d-8bc8-912fc0d6620b
content-type: application/json

{
  "name": "Documentação (v2)",
  "intervalSeconds": 120
}

HTTP/1.1 200 OK
cache-control: no-store

{
  "id": "238f20d6-8632-423d-8bc8-912fc0d6620b",
  "name": "Documentação (v2)",
  "url": "https://docs.example.com/status",
  "intervalSeconds": 120,
  "active": true,
  "status": "OPERATIONAL",
  "consecutiveFailures": 0,
  "nextCheckAt": "2026-10-27T01:58:05.020Z",
  "lastCheckedAt": null,
  "createdAt": "2026-10-27T01:58:05.020Z"
}
```


### `POST /monitors/:id/pause` e `POST /monitors/:id/resume`

**Entrada:** nenhuma. **Resposta `200`:** `Monitor` administrativo com `active` atualizado. Idempotentes.
Pausar: o monitor deixa de ser checado e aparece como `paused` na API pública (histórico e incidentes são mantidos; um incidente
aberto permanece aberto até uma checagem bem-sucedida depois de retomar). Retomar agenda uma checagem imediata.
Erros: `400`, `401`, `403`, `404`.

**Exemplo**

```http
POST /monitors/238f20d6-8632-423d-8bc8-912fc0d6620b/pause

HTTP/1.1 200 OK
cache-control: no-store

{
  "id": "238f20d6-8632-423d-8bc8-912fc0d6620b",
  "name": "Documentação (v2)",
  "url": "https://docs.example.com/status",
  "intervalSeconds": 120,
  "active": false,
  "status": "OPERATIONAL",
  "consecutiveFailures": 0,
  "nextCheckAt": "2026-10-27T01:58:05.020Z",
  "lastCheckedAt": null,
  "createdAt": "2026-10-27T01:58:05.020Z"
}
```

**Exemplo**

```http
POST /monitors/238f20d6-8632-423d-8bc8-912fc0d6620b/resume

HTTP/1.1 200 OK
cache-control: no-store

{
  "id": "238f20d6-8632-423d-8bc8-912fc0d6620b",
  "name": "Documentação (v2)",
  "url": "https://docs.example.com/status",
  "intervalSeconds": 120,
  "active": true,
  "status": "OPERATIONAL",
  "consecutiveFailures": 0,
  "nextCheckAt": "2026-10-27T01:58:05.032Z",
  "lastCheckedAt": null,
  "createdAt": "2026-10-27T01:58:05.020Z"
}
```


### `DELETE /monitors/:id`

**Entrada:** nenhuma. **Resposta `204`** (sem corpo). Apaga também, em cascata, o histórico de checagens e os incidentes do monitor. Irreversível.
Erros: `400`, `401`, `403`, `404`.

**Exemplo**

```http
DELETE /monitors/238f20d6-8632-423d-8bc8-912fc0d6620b

HTTP/1.1 204 No Content
cache-control: no-store
```


## 6. Catálogo de erros

| HTTP | `error` | Quando |
|---|---|---|
| 400 | `validation_error` | Corpo, query ou parâmetros de rota inválidos (`issues` presente) |
| 400 | `bad_request` | JSON malformado ou requisição inválida sem detalhe |
| 401 | `unauthorized` | Rota administrativa sem sessão válida/expirada |
| 401 | `invalid_credentials` | Falha no login |
| 403 | `csrf` | Falta o `X-CSRF-Token` ou ele não corresponde à sessão |
| 403 | `origin_not_allowed` | Cabeçalho `Origin` de outro site |
| 404 | `not_found` | Recurso ou rota inexistente (inclui método não suportado na rota) |
| 409 | `monitor_limit_reached` | Teto de monitores atingido |
| 413 | `payload_too_large` | Corpo acima de 16 KB |
| 415 | `unsupported_media_type` | `content-type` diferente de `application/json` |
| 429 | `too_many_attempts` | Login bloqueado (ver `retry-after`) |
| 500 | `internal_error` | Falha inesperada (detalhes só no log; informe o `requestId`) |
| 503 | — | Só em `/health`: `{ status: "degraded", scheduler }` |

**Exemplo (rota inexistente)**

```http
GET /nada

HTTP/1.1 404 Not Found

{
  "error": "not_found",
  "message": "Rota não encontrada",
  "requestId": "req-3w"
}
```


## 7. O que o frontend pode assumir

- Status público = `GET /public/status` (uma chamada). Detalhe de um monitor = `GET /public/monitors/:id` + `/history` (gráfico de latência) + `/incidents?monitorId=`.
- Barra de uptime: use `uptime.*.percentage` e mostre `checks`; `null` = "sem dados".
- "Operacional" **só** quando `state === "operational"`. `no_data` e `paused` não são "tudo certo".
- Atualização: o dado muda no ritmo do intervalo de cada monitor (≥ 30 s) e a resposta é cacheável por 10 s; consultar a cada 15–30 s é suficiente.
- Rotas administrativas exigem `credentials: "include"` e o header `X-CSRF-Token`; guarde o token em memória, não em `localStorage`.
