# Pulse — backend

API + scheduler de checagens (Node 22+, TypeScript, Fastify, PostgreSQL, Prisma 7).

## Rodando localmente

```bash
cp .env.example .env              # NODE_ENV=development
docker compose up -d --wait       # Postgres em localhost:5433
npm install
npm run db:deploy                 # aplica as migrations
npm run admin -- create --username <usuario>   # cria o administrador (veja abaixo)
npm run dev                       # http://localhost:3000
npm run typecheck && npm run build
```

Para ver o ciclo completo sem esperar, use `MIN_INTERVAL_SECONDS=5` no `.env` e cadastre um monitor com `intervalSeconds: 5`.

### Testes

`npm test` roda os testes sem banco (lógica de estados, checagem HTTP, SSRF, hash, gating das rotas).
Os testes de integração (autenticação, sessões, CSRF, operações administrativas) precisam de um Postgres **descartável**
e são **pulados** sem ele; eles apagam as tabelas:

```bash
createdb -h localhost -p 5433 -U pulse pulse_test        # ou qualquer banco vazio de teste
export TEST_DATABASE_URL=postgresql://pulse:pulse@localhost:5433/pulse_test
DATABASE_URL=$TEST_DATABASE_URL npm run db:deploy
npm test
```

## Endpoints

**Públicos (sem login)**

| Rota | Descrição |
|---|---|
| `GET /health` | Estado do Pulse e conectividade com o banco (503 se o banco cair) |
| `GET /public/status` | Estado atual de cada monitor ativo, última latência, incidente em andamento |
| `GET /public/monitors/:id/history?limit=` | Checagens recentes (máx. 200) e últimos incidentes |

Nunca devolvem a URL monitorada nem mensagens de erro: apenas uma categoria
(`timeout`, `dns`, `connection`, `tls`, `http_status`, `redirect`, `blocked`, `unknown`). Monitores pausados somem daqui.

**Autenticação**

| Rota | Descrição |
|---|---|
| `POST /auth/login` `{username, password}` | Abre a sessão (cookie) e devolve `csrfToken`. Limitada por tentativas |
| `GET /auth/session` | Usuário logado + `csrfToken` (para o frontend recuperar o token após recarregar) |
| `POST /auth/logout` | Encerra a sessão no servidor e limpa o cookie |

**Administração (exigem sessão; escritas exigem `X-CSRF-Token`)**

| Rota | Descrição |
|---|---|
| `POST /monitors` `{name, url, intervalSeconds}` | Cadastra (201) |
| `GET /monitors`, `GET /monitors/:id` | Lista / detalha (inclui URL e estado interno) |
| `PATCH /monitors/:id` | Edita `name`, `url`, `intervalSeconds` (ao menos um; campos extras são rejeitados) |
| `POST /monitors/:id/pause`, `POST /monitors/:id/resume` | Pausa / retoma |
| `DELETE /monitors/:id` | Exclui (204); checagens e incidentes saem em cascata |

Erros: `401 unauthorized`, `403 csrf` / `origin_not_allowed`, `400 validation_error`, `404 not_found`, `429 too_many_attempts` (com `Retry-After`).

## Autenticação

Uma única conta de administrador. Nada de senha ou segredo no repositório: a senha só existe no seu terminal e,
depois, como hash no banco.

### Criando o primeiro administrador

A conta é criada por uma CLI, nunca por variável de ambiente nem por endpoint. A senha **não** vai em argumento
(ficaria no histórico do shell e no `ps`): é pedida num prompt oculto, ou lida da primeira linha do stdin.

```bash
# desenvolvimento
npm run admin -- create --username gustavo         # pede a senha duas vezes (mín. 12 caracteres)

# produção: rode contra o banco de produção, de uma máquina sua, ou no shell do serviço (se o plano tiver)
DATABASE_URL='postgresql://...' npm run admin -- create --username gustavo
#   ou, depois do build:  DATABASE_URL=... node dist/cli/admin.js create --username gustavo

# sem terminal (ex.: gerenciador de segredos), a senha vem pelo stdin:
op read "op://cofre/pulse/senha" | npm run admin -- create --username gustavo
```

- Só existe **uma** conta: `create` recusa uma segunda, e o banco também (índice único). Para trocar a senha:
  `npm run admin -- reset-password`. Isso **encerra todas as sessões** abertas.
- Política: 12 a 128 caracteres, e a senha não pode conter o nome de usuário. Hash: **scrypt** (N=2^16, r=8, p=1,
  salt aleatório de 16 bytes), com os parâmetros dentro do hash para permitir evoluí-los.
- Se perder a senha: `reset-password` com acesso ao banco. Não há "esqueci minha senha" por e-mail.

### Sessão

- Login gera um token aleatório de 256 bits enviado em cookie; o banco guarda **só o SHA-256** dele. Um vazamento do
  banco não entrega sessões utilizáveis. Duração absoluta de `SESSION_TTL_HOURS` (12 h); logout apaga no servidor.
- Cookie: `HttpOnly` (JavaScript não lê), `Path=/`, `SameSite=Strict` e, em produção, `Secure` com prefixo `__Host-`
  (o navegador recusa o cookie se não for Secure/sem Domain). Em desenvolvimento (HTTP) o nome é `pulse_session` sem Secure.
- `Cache-Control: no-store` nas respostas de autenticação e administração.

### Frontend e `SameSite`

- **Recomendado:** frontend e API no mesmo *site* (ex.: `app.exemplo.com` e `api.exemplo.com`). Use o padrão
  `SESSION_COOKIE_SAMESITE=strict` e defina `CORS_ALLOWED_ORIGIN=https://app.exemplo.com` (CORS com credenciais
  só para essa origem).
- Frontend em outro site (ex.: `*.vercel.app` + `*.onrender.com`): `SESSION_COOKIE_SAMESITE=none`. Exige
  `NODE_ENV=production` e `CORS_ALLOWED_ORIGIN`, ou o processo não inicia. Cookies de terceiros são cada vez mais
  bloqueados pelos navegadores; prefira o mesmo site.

### CSRF

Defesa em três camadas, para toda operação que altera estado (`POST`/`PATCH`/`DELETE`, inclusive logout):
1. `SameSite` do cookie;
2. cabeçalho `Origin`, quando presente, precisa ser o próprio servidor ou `CORS_ALLOWED_ORIGIN` (vale também para o login);
3. token CSRF por sessão no cabeçalho `X-CSRF-Token` (recebido no login / `GET /auth/session`), comparado em tempo constante.

### Limite de tentativas de login

Falhas ficam no banco (valem entre instâncias e restarts). Por padrão, em 15 minutos: **5 falhas por IP** bloqueiam aquele IP
e **30 falhas globais** bloqueiam todos (limita ataques distribuídos). Bloqueado = `429` com `Retry-After`, **sem** executar
o scrypt. Efeito colateral aceito: durante um ataque distribuído o próprio administrador pode esperar até a janela esvaziar.
Usuário inexistente e senha errada dão a mesma resposta e custam o mesmo tempo.
Atrás de proxy, configure `TRUST_PROXY_HOPS` (normalmente `1`) para que `req.ip` seja o do cliente; com `0` o IP é o do
proxy e o limite por IP vira praticamente um limite global. Não use um valor maior que o número real de proxies,
senão o cliente forja `X-Forwarded-For` e escapa do limite.

### Como as rotas administrativas ficam protegidas

Não há mais flag nem modo de desenvolvimento sem login (`ADMIN_ROUTES_ENABLED` foi removida; a variável, se ainda
existir no ambiente, é ignorada). Toda rota administrativa é registrada num único escopo do Fastify (`src/app.ts`) cujos
hooks `onRequest` aplicam sessão e CSRF antes de qualquer parsing de corpo. Só `GET /health`, as rotas `/public/*` e
`POST /auth/login` ficam fora dele. `test/auth-gating.test.ts` percorre **todas** as rotas registradas: qualquer rota
nova que não esteja na lista pública e não esteja no escopo protegido quebra o teste.

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
`SESSION_COOKIE_SAMESITE=strict`, `CHECK_TIMEOUT_MS=10000`, `MIN_INTERVAL_SECONDS=30`). Em produção defina também
`TRUST_PROXY_HOPS` e, se houver frontend, `CORS_ALLOWED_ORIGIN`.
