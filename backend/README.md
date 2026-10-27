# Pulse — backend

API + scheduler de checagens (Node 22+, TypeScript, Fastify, PostgreSQL, Prisma 7).

## Rodando localmente

```bash
cp .env.example .env              # NODE_ENV=development e ADMIN_ROUTES_ENABLED=true
docker compose up -d --wait       # Postgres em localhost:5433
npm install
npm run db:deploy                 # aplica as migrations
npm run dev                       # http://localhost:3000
npm test && npm run typecheck && npm run build
```

Para ver o ciclo completo sem esperar, use `MIN_INTERVAL_SECONDS=5` no `.env` e cadastre um monitor com `intervalSeconds: 5`.

## Endpoints

| Rota | Acesso | Descrição |
|---|---|---|
| `GET /health` | público | Estado do Pulse e conectividade com o banco (503 se o banco cair) |
| `GET /public/status` | público | Estado atual de cada monitor, última latência, incidente em andamento |
| `GET /public/monitors/:id/history?limit=` | público | Checagens recentes (máx. 200) e últimos incidentes |
| `POST /monitors`, `GET /monitors` | **somente dev** | Cadastro/listagem (inclui a URL). Ver "Rotas de escrita" |

Os endpoints públicos nunca devolvem a URL monitorada nem mensagens de erro: apenas uma categoria
(`timeout`, `dns`, `connection`, `tls`, `http_status`, `redirect`, `blocked`, `unknown`).

## Rotas de escrita inacessíveis em produção

Enquanto não há autenticação, `POST /monitors` e `GET /monitors` são protegidas em três camadas
(testes em `test/admin-routes.test.ts`):

1. **Não são registradas.** Sem `ADMIN_ROUTES_ENABLED=true`, as rotas não existem no Fastify: a resposta é 404, não 401/403.
   O padrão da flag é `false`.
2. **Produção não aceita a flag.** `NODE_ENV=production` com `ADMIN_ROUTES_ENABLED=true` faz o processo
   **falhar na inicialização** (`loadConfig`). Não dá para ligar por engano em um deploy.
3. **Falha fechada.** `NODE_ENV` ausente vale `production`; só um `NODE_ENV=development` explícito permite a flag.

Consequência prática: em produção ainda não há como cadastrar monitores pela API. Isso é intencional até a etapa de autenticação.

## Proteção contra SSRF e redirects

O Pulse faz requisições a URLs fornecidas por usuário, então o destino é validado em cada conexão:

- **Cadastro:** só `https`, sem credenciais na URL, sem `localhost`/sufixos internos, sem IP interno em qualquer notação
  (`2130706433`, `0x7f.1`, `[::ffff:7f00:1]` são normalizados pelo parser de URL e bloqueados). É só um filtro rápido.
- **Conexão (a defesa real):** o socket usa um `lookup` próprio (`security/guarded-lookup.ts`) que resolve o nome,
  valida **todos** os IPs devolvidos (`security/ip.ts`: loopback, privados, CGNAT, link-local/metadados de nuvem,
  multicast, reservados, ULA IPv6, IPv4-mapeado, NAT64, 6to4, Teredo) e entrega ao socket exatamente os endereços
  validados. Não existe segunda consulta de DNS entre validar e conectar, o que fecha a janela de DNS rebinding.
  Uma resolução com *qualquer* IP interno é recusada por inteiro. Como a validação roda a cada checagem, um nome
  que passar a apontar para a rede interna depois de cadastrado também é bloqueado.
- **Redirects:** seguidos manualmente, no máximo 5, detectando loops. Cada destino passa pelas mesmas validações
  (https, sem credenciais, host/IP público). Sucesso significa que a **resposta final** tem status < 400; um 301 isolado,
  sem destino válido, é falha (`redirect` ou `blocked`).
- Sem keep-alive: cada hop resolve e valida de novo.

Limite conhecido: um DNS que devolva um IP público *diferente* do esperado (ex.: o dono do domínio troca o apontamento
para outro serviço público) não é detectável, e não é o objetivo desta defesa.

## Como o scheduler roda continuamente

O scheduler não depende de visitas à API. É um loop (`setInterval`) iniciado em `server.ts`, no mesmo processo do Fastify:

1. A cada `SCHEDULER_TICK_MS` (5 s) executa `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`,
   que escolhe os monitores com `next_check_at <= now()` e já reagenda `next_check_at = agora + intervalo`.
2. Checa cada um (até `SCHEDULER_CONCURRENCY` por ciclo) e grava resultado, estado e incidente numa transação.

O agendamento fica no banco: reinício retoma o que estiver vencido, e várias instâncias não duplicam checagens.
Verificado com PostgreSQL real: 2 instâncias simultâneas, intervalo de 2 s → 5 checagens por monitor em 10 s e
espaçamento mínimo de 2,00 s. Com `SCHEDULER_ENABLED=false` o processo só serve a API (útil para separar API e worker).

### Hospedagem: premissa Render

A hospedagem não foi definida na conversa; assumi **Render**. Precisa ser um **processo sempre ligado**
(web service ou background worker). Plataformas serverless (ex.: Vercel Functions) não servem para o scheduler.

Configuração: build `npm ci && npm run build`; pre-deploy `npm run db:deploy`; start `npm start`;
`NODE_ENV=production`, `DATABASE_URL` (Postgres da Render), `HOST=0.0.0.0`, health check em `/health`.
Mantenha **uma** instância enquanto não houver necessidade de mais (o `SKIP LOCKED` permite escalar depois).

### Limitações do plano gratuito (fonte: https://render.com/docs/free, consultada em 2026-10-26)

- **Dorme após 15 min sem requisições de entrada.** O loop do scheduler **para** (não conta como tráfego), e voltar
  leva cerca de 1 minuto. Enquanto dorme, o Pulse não checa nada: um site pode cair e ninguém é notificado,
  e o histórico terá buracos. Isso inviabiliza monitoramento confiável no plano gratuito.
- **Contornar com ping externo em `/health` a cada < 15 min mantém acordado**, mas é paliativo: depende de um
  terceiro, e reinícios "a qualquer momento" ainda causam lacunas curtas.
- **750 horas/mês por workspace**: cobre uma instância 24 h/dia; acabando, todos os serviços gratuitos são suspensos até o mês seguinte.
- **Reinícios a qualquer momento** e filesystem efêmero (o Pulse não usa disco local).
- **Postgres gratuito expira 30 dias após a criação** (14 dias de carência antes de apagar), com 1 GB, sem backups e
  sem pool de conexões. O histórico seria perdido.
- Workers e cron jobs **não** têm instância gratuita; só web services, Postgres, Key Value e sites estáticos.
- Suspensão possível por alto tráfego de saída. Cada checagem baixa só os cabeçalhos, então o consumo é baixo.

**Efeito na frequência:** no gratuito, o intervalo efetivo é "o que o ping externo mantiver acordado", sem garantia, e
um intervalo de checagem menor que o tempo de despertar (~1 min) não faz sentido. Para monitoramento real, use um
plano pago (instância sempre ligada) e um Postgres pago; aí `MIN_INTERVAL_SECONDS=30` é viável (tick de 5 s, uma
checagem por conexão curta). Recomendo reavaliar preços e limites no painel antes de contratar.

## Variáveis de ambiente

Ver `.env.example`. Obrigatória: `DATABASE_URL`. Demais têm padrão seguro (`NODE_ENV=production`,
`ADMIN_ROUTES_ENABLED=false`, `CHECK_TIMEOUT_MS=10000`, `MIN_INTERVAL_SECONDS=30`).
