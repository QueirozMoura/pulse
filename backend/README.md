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

## API

O contrato completo (entradas, respostas, erros, exemplos reais capturados do servidor) está em
**[docs/API.md](docs/API.md)**. Um teste (`test/api-docs.test.ts`) falha se uma rota existir sem estar documentada.

| Grupo | Rotas |
|---|---|
| Público (sem login) | `GET /health`, `GET /public/status`, `GET /public/monitors/:id`, `GET /public/monitors/:id/history`, `GET /public/incidents` |
| Autenticação | `POST /auth/login`, `GET /auth/session`, `POST /auth/logout` |
| Administração (sessão + CSRF) | `POST/GET /monitors`, `GET/PATCH/DELETE /monitors/:id`, `POST /monitors/:id/pause`, `POST /monitors/:id/resume` |

Pontos que valem repetir: formato de erro único (`{ error, message, requestId, issues? }`); estados públicos
`operational | unavailable | paused | no_data`; uptime `null` quando não há checagens; listas longas com cursor e teto de `limit`;
as rotas públicas nunca expõem a URL monitorada nem detalhes internos.

### Cadastrando monitores em produção

Em produção só existe o caminho autenticado (não há flag nem modo aberto). Faça login e use o cookie + `X-CSRF-Token`:

```bash
API=https://sua-api.exemplo.com
curl -s -c jar -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"username":"seu-usuario","password":"..."}' > login.json         # digite a senha com cuidado com o histórico do shell
CSRF=$(jq -r .csrfToken login.json)
curl -s -b jar -X POST $API/monitors -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"name":"Meu site","url":"https://meusite.exemplo.com","intervalSeconds":60}'
```

(Em produção o cookie é `Secure`; o `curl -c/-b` só o reenvia por HTTPS.) O frontend fará o mesmo com `credentials: "include"`.

## Alertas por e-mail

Um e-mail quando um incidente **abre** (2 falhas consecutivas) e outro quando é **resolvido**, com a duração; nunca um por
checagem. Provedor: Resend (API HTTPS). A fila é uma tabela do próprio PostgreSQL (outbox): sobrevive a restart e a falha do
provedor, tem retentativas com limite, e não duplica nem com duas instâncias. O e-mail nunca contém URL, cookie, token ou stack.

```bash
ALERT_DELIVERY=off      # padrão: nada é criado nem enviado
ALERT_DELIVERY=log      # desenvolvimento: o e-mail renderizado vai só para o log
ALERT_DELIVERY=email    # exige ALERT_EMAIL_TO, ALERT_EMAIL_FROM e RESEND_API_KEY
npm run alerts -- status                 # situação da outbox
npm run alerts -- test-send --confirm    # envia UM e-mail de teste pelo provedor real
```

Tudo (funcionamento, configuração, como verificar um envio real sem disparar e-mails nos testes, operação e limitações) está em
**[docs/ALERTS.md](docs/ALERTS.md)**. A suíte de testes nunca envia e-mail.

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
   que escolhe os monitores com `next_check_at <= now()` **e já os reagenda** na mesma operação, só para as vagas livres
   (`SCHEDULER_CONCURRENCY`, padrão 10).
2. Cada checagem roda na sua vaga; ao terminar, a vaga é reutilizada na hora. Uma checagem lenta nunca atrasa as demais.
3. O resultado é gravado numa transação que trava a linha do monitor, grava o histórico (com o horário em que a checagem
   **começou**) e aplica estado/incidente.

Garantias (todas cobertas por testes com PostgreSQL real, em `test/scheduler.integration.test.ts` e `test/recorder.integration.test.ts`):

- **Múltiplas instâncias** (inclusive a sobreposição dos deploys sem downtime): cada monitor é checado por uma instância só.
  O teste força a janela de corrida e falha se o `SKIP LOCKED` for removido.
- **Reinício:** o agendamento está no banco. Um monitor vencido há 1 hora recebe **uma** checagem, não uma por intervalo perdido.
- **Banco fora:** o processo não cai; registra o erro, tenta no próximo ciclo e o `/health` responde 503 (`scheduler: "stalled"`).
- **Queda no meio de uma checagem ou falha ao gravar:** a checagem é perdida, nunca repetida nem duplicada.
- **Resultado atrasado ou obsoleto** (monitor pausado, excluído ou com URL editada durante a checagem; resultado que chega
  depois de um mais novo): não altera estado, não abre nem fecha incidente. Duas checagens simultâneas do mesmo monitor jamais
  geram dois incidentes abertos (índice único parcial no banco).
- **Intervalo > timeout:** o intervalo mínimo aceito é sempre maior que o timeout, então a checagem anterior termina antes da próxima.
- **Retenção:** `CHECK_RETENTION_DAYS` (30) apaga checagens antigas a cada hora, em lotes (≈ 168 bytes por checagem).

### Hospedagem

Veja **[docs/DEPLOY.md](docs/DEPLOY.md)**: estratégia (Render pago + Postgres gerenciado, ≈ US$ 13,30/mês), custos
comparados com alternativas, dimensionamento medido, limitações, procedimento para criar e recuperar o administrador em
produção e checklist de deploy. **Nada foi contratado nem implantado.**
O plano gratuito da Render **não serve**: o serviço dorme após 15 min sem requisições (o scheduler para) e o Postgres gratuito expira em 30 dias.

## Variáveis de ambiente

Ver `.env.example`. Obrigatória: `DATABASE_URL`. Demais têm padrão seguro (`NODE_ENV=production`,
`SESSION_COOKIE_SAMESITE=strict`, `CHECK_TIMEOUT_MS=10000`, `MIN_INTERVAL_SECONDS=30`, `MAX_MONITORS=100`,
`CHECK_RETENTION_DAYS=30`, `ALERT_DELIVERY=off`). Em produção defina também
`TRUST_PROXY_HOPS` e, se houver frontend, `CORS_ALLOWED_ORIGIN`.
