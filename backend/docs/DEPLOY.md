# Hospedagem gratuita e operação

> **Estado:** nada foi contratado, configurado ou implantado. Os limites abaixo vêm das páginas oficiais consultadas em
> 2026-10-27 (fontes no fim). Planos gratuitos mudam: **reconfira cada limite no painel antes de depender dele.**
> Este guia usa apenas planos gratuitos.

## 1. Arquitetura

```
                       ┌───────────────────────────── GitHub Actions (cron ≈ 15 min) ─────────────────────────────┐
                       │  npm run build → node dist/worker/once.js                                                  │
                       │  1. reivindica monitores vencidos (FOR UPDATE SKIP LOCKED) e checa                          │
                       │  2. envia alertas pendentes / retentativas da outbox (Resend)                               │
                       │  3. grava o batimento em worker_runs e termina (código de saída 0/1/2/3/130)                │
                       └───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                                   │ DATABASE_URL (segredo do repositório)
 visitante ──► Site estático (página pública) ──► API (Render Web Service gratuito, pode dormir) ──► Neon PostgreSQL (gratuito)
 administrador ───────────────► painel /admin servido PELA API (mesma origem do cookie) ─────────────────┘
```

| Peça | Serviço gratuito | Papel |
|---|---|---|
| Checagens + envio de alertas | **GitHub Actions** (agendado) | Roda **independente de a API estar acordada** |
| Banco | **Neon PostgreSQL** | Todo o estado: monitores, histórico, incidentes, outbox, sessões, batimento do worker |
| API pública e administrativa | **Render Web Service** (free) | Lê o banco; **não** faz checagens nem envia e-mails (`SCHEDULER_ENABLED=false`) |
| Página pública | Site estático (Render Static Site ou Cloudflare Pages) | Só chama rotas públicas |
| Painel `/admin` | A própria API (`STATIC_DIR`) | Mesma origem do cookie de sessão (ver §2) |

### O que esperar (sem promessas falsas)

- **Cadência real ≈ 15 min, não exata.** O cron do GitHub é "melhor esforço": pode atrasar vários minutos ou pular uma
  rodada em horários de pico. O Pulse tolera isso (folga de vencimento, `/health` mostrando o atraso real), mas não o elimina.
- **Uma queda leva, em média, de 15 a 30 min para ser detectada**: a falha precisa ser vista em **duas rodadas seguidas**
  (regra das 2 falhas consecutivas), mais o atraso do agendador. Não há checagem a cada 30 s nem detecção em 1 minuto.
- A API **dorme após 15 min sem requisição** e leva cerca de um minuto para acordar. O worker não depende dela.
- O Neon **suspende a computação após 5 min sem uso** (não dá para desativar no plano gratuito); a primeira consulta depois disso demora mais.
- Se o GitHub parar de agendar (repositório inativo, §3) ou o Neon esgotar as horas do mês, **as checagens param** e o
  `/health` passa a mostrar `worker.status: "late"`. Mantenha um monitor externo gratuito em `/health/live` (não em `/health`, §3) e confira `/health` de vez em quando.

## 2. Por que o painel fica na API (cookie e *Public Suffix List*)

`onrender.com`, `netlify.app`, `vercel.app`, `pages.dev`, `github.io` e similares estão na *Public Suffix List*. Para o navegador,
`pulse-web.onrender.com` e `pulse-api.onrender.com` são **sites diferentes** (cross-site). O cookie de sessão é `SameSite=Strict`
(e `__Host-` em produção), então **não seria enviado** do site estático para a API: o login pareceria funcionar e a sessão nunca valeria.
Afrouxar isso (`SameSite=None`) abriria mão da proteção contra CSRF; **não fizemos**.

Solução adotada, sem enfraquecer nada:

- A **página pública** (somente rotas públicas, `credentials: omit`) fica no site estático e usa CORS (`CORS_ALLOWED_ORIGIN`).
- O **painel** é servido pela própria API (`STATIC_DIR`), na mesma origem do cookie. No site estático, `VITE_ADMIN_URL` faz `/admin*` redirecionar para ele.
- Com **domínio próprio** (`app.exemplo.com` + `api.exemplo.com`, mesmo site registrável) nada disso é necessário:
  um só build do frontend com `VITE_API_URL=https://api.exemplo.com`, sem `STATIC_DIR` nem `VITE_ADMIN_URL`.

Verificado localmente: o painel servido pela API (login, cadastro de monitor) funciona na mesma origem com a CSP aplicada (`connect-src 'self'`).
**Não verificado** (exigiria deploy): redirects/rewrites da Render ou do Cloudflare Pages e o comportamento real do cron do GitHub.

## 3. Limites dos planos gratuitos (e a conta que importa)

| Serviço | Limite gratuito | Consequência para o Pulse |
|---|---|---|
| **Neon Free** | 100 CU-horas/projeto/mês, 1 GB de armazenamento, 5 GB de egress, PITR de 6 h, autosuspend em 5 min (fixo) | Cálculo abaixo. Esgotadas as CU-horas, a computação é suspensa até o próximo período: **o worker falha (exit 1) e a API fica sem banco** |
| **Render Web Service Free** | 750 h/mês de instância, dorme após 15 min sem requisição de entrada, sem *Pre-Deploy Command* nem Shell | Cold start de ~1 min. Migrations e criação do administrador são feitas do **seu computador** |
| **Render Static Site** | Gratuito, com limites de banda/build da workspace | Alternativa: Cloudflare Pages (500 builds/mês, 20.000 arquivos) |
| **GitHub Actions** | Repositório **público**: gratuito. **Privado**: 2.000 min/mês | Cálculo abaixo |
| **GitHub `schedule`** | Mínimo de 5 min; UTC; pode atrasar/descartar sob carga; só na branch padrão; em repositório público é **desativado após 60 dias sem atividade** | Faça um commit ocasional ou reative em *Actions* quando o GitHub avisar |
| **Resend Free** | 3.000 e-mails/mês, 100/dia | Um e-mail por abertura e um por resolução: folgado. `ALERT_MAX_PER_HOUR` protege contra oscilação |

### Neon: horas de computação

Cada rodada acorda a computação, que só suspende 5 min depois da última atividade. Com rodadas de duração *T* a cada 15 min:

```
tempo ligado por rodada ≈ T + 5 min   →   fração ligada ≈ (T + 5) / 15
T ≈ 20 s:   5,3 / 15 ≈ 36 %   →   730 h × 0,36 ≈ 260 h de computação por mês
a 0,25 CU (menor tamanho do autoscaling):   ≈ 65 CU-h/mês   (de 100)
```

Sobram ≈ 35 CU-h (≈ 140 h a 0,25 CU) para a API: consultas públicas, painel e `/health`. **É uma estimativa, não uma medição**:
o consumo real aparece em Neon → *Usage*. Para não estourar:

- `PUBLIC_CACHE_SECONDS=30`: cache em memória das rotas públicas (invalidado quando você altera algo no painel).
- `VITE_POLL_SECONDS=600` no frontend (o padrão do código é 60 s; uma aba aberta a cada 60 s manteria o banco ligado o tempo todo).
- Health check da Render em **`/health/live`** (não consulta o banco). **Não** ponha um monitor externo a cada poucos minutos em `/health`.
- Rodadas mais espaçadas (ex.: `*/30`) gastam menos, ao custo de detectar quedas mais devagar.

### GitHub Actions: minutos

Cada rodada é um job (dependências em cache, `npm run build`, worker): **estimo ~1 min cobrado** (arredondado para cima por job).
Em repositório **privado**: 96 rodadas/dia × 30 ≈ **2.880 min** > 2.000 min grátis → **estoura**. Opções:
(a) repositório **público** (o código não contém segredos; eles ficam em *Secrets*; revise o histórico antes de publicar), ou
(b) cadência de 30 min (`*/30`, ≈ 1.440 min) com `WORKER_EXPECTED_INTERVAL_MINUTES=30` na API.

## 4. Passo a passo

Faça nesta ordem. **Nada abaixo foi executado por mim**; são os passos exatos para você executar.

### 4.1 Repositório no GitHub

1. Crie o repositório e envie o código (branch padrão `main`). O workflow `.github/workflows/worker.yml` já está no repositório.
2. Escolha **público** (recomendado, §3) ou privado com `*/30`.
3. Em *Settings → Actions → General → Fork pull request workflows* mantenha o padrão (sem segredos para forks). O workflow também não escuta `pull_request`.

### 4.2 Neon (banco)

1. Crie a conta em <https://neon.com> e um projeto **Free**, na região mais próxima da região da Render (ex.: `us-east`).
2. Em *Connect*, copie **duas** URLs do mesmo banco, ambas com `sslmode=require`; trate-as como senhas:
   - **Pooled** (host com `-pooler`): para a API e o worker → `DATABASE_URL` da Render e do GitHub.
   - **Direct** (sem `-pooler`): para migrations e CLI do administrador, rodadas do **seu computador**.
3. Aplique as migrations **do seu computador** (a Render gratuita não tem Pre-Deploy; o worker nunca roda migrations):
   ```bash
   cd backend && npm ci
   read -rs DATABASE_URL && export DATABASE_URL     # cole a URL DIRECT; sem eco, fora do histórico
   npm run db:deploy
   ```
4. Crie o administrador (pede a senha duas vezes, sem eco), com a mesma `DATABASE_URL` ainda exportada:
   ```bash
   npm run admin -- create --username seu-usuario
   unset DATABASE_URL
   ```

### 4.3 Render (API + painel)

1. *New → Web Service* → conecte o repositório. **Deixe *Root Directory* vazio** (os comandos entram nas pastas).
2. Campos:

   | Campo | Valor |
   |---|---|
   | Runtime | Node |
   | Instance Type | **Free** |
   | Build Command | `cd frontend && npm ci && VITE_API_URL= npm run build && cd ../backend && npm ci --include=dev && npm run build` |
   | Start Command | `cd backend && node dist/server.js` |
   | Health Check Path | `/health/live` |

   `VITE_API_URL=` (vazio) faz o painel falar com a mesma origem. `--include=dev` porque a Render define `NODE_ENV=production`.
3. *Environment* (marque `DATABASE_URL` como secreta):

   | Variável | Valor |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | URL **pooled** do Neon |
   | `SCHEDULER_ENABLED` | `false` (a API não faz checagens nem envia e-mails) |
   | `MIN_INTERVAL_SECONDS` | `900` (o cadastro só aceita 15 min ou mais) |
   | `WORKER_EXPECTED_INTERVAL_MINUTES` | `15` (ou `30`, conforme o cron do workflow) |
   | `PUBLIC_CACHE_SECONDS` | `30` |
   | `STATIC_DIR` | `../frontend/dist` |
   | `TRUST_PROXY_HOPS` | `1` |
   | `CORS_ALLOWED_ORIGIN` | origem do site estático (§4.4), ex.: `https://pulse-web.onrender.com`. Omita se usar só a API |
   | `ALERT_DELIVERY` | `off` (quem envia e-mails é o worker) |

4. Faça o deploy e confira `curl https://<api>.onrender.com/health/live` → `{"status":"ok"}`.
   `/health` mostra `worker.status: "never"` até a primeira rodada do GitHub.
5. Abra `https://<api>.onrender.com/admin`, entre e cadastre um monitor (o formulário só oferece ≥ 15 min).

### 4.4 Site estático (página pública)

Opcional: a API já serve a página pública em `/`. O site estático existe para a página abrir mesmo com a API dormindo
(mostra "o servidor está acordando" e carrega os dados quando a API responde).

**Render Static Site** (ou Cloudflare Pages, com os mesmos valores):

| Campo | Valor |
|---|---|
| Build Command | `cd frontend && npm ci && npm run build` |
| Publish Directory | `frontend/dist` |
| Redirect/Rewrite | `/*` → `/index.html` (**Rewrite**) |
| `VITE_API_URL` | `https://<api>.onrender.com` |
| `VITE_ADMIN_URL` | `https://<api>.onrender.com` |
| `VITE_POLL_SECONDS` | `600` |

Depois de criar, copie a URL do site para `CORS_ALLOWED_ORIGIN` na API e refaça o deploy dela.

### 4.5 GitHub Actions (worker)

1. *Settings → Secrets and variables → Actions → Secrets → New repository secret*:

   | Secret | Valor |
   |---|---|
   | `DATABASE_URL` | URL **pooled** do Neon |
   | `RESEND_API_KEY` | só quando ativar alertas por e-mail |
   | `ALERT_EMAIL_TO` | destinatário dos alertas |
   | `ALERT_EMAIL_FROM` | remetente, ex.: `Pulse <alertas@seudominio.com>` |

2. *Variables → New repository variable*: `ALERT_DELIVERY` = `email` (ou `log`). Sem a variável os alertas ficam **desligados**.
   Opcionais: `WORKER_TIMEOUT_SECONDS` (240), `WORKER_MAX_CHECKS` (200).
3. *Actions → Pulse worker → Run workflow* (disparo manual). O resumo mostra duração, checagens e alertas; código de saída ≠ 0 marca a execução como falha.
4. Confirme em `https://<api>.onrender.com/health` que `worker.status` virou `ok`.
5. Antes de depender dos alertas, faça o `test-send` de `docs/ALERTS.md` a partir do seu computador.

O cron é `7,22,37,52 * * * *` (UTC), de propósito fora do minuto `:00`. Para `*/30`, troque a linha no workflow.

## 5. Como o worker se comporta

| Pergunta | Resposta |
|---|---|
| Duas execuções ao mesmo tempo (agendada + manual)? | `concurrency` do workflow as serializa; e, mesmo sem ele, `FOR UPDATE SKIP LOCKED` garante que cada monitor e cada alerta sejam processados **uma vez** (testado com PostgreSQL real) |
| Rodar de novo logo em seguida? | Não acha nada vencido: idempotente |
| Monitor de 15 min com cron de 15 min? | `WORKER_DUE_SLACK_SECONDS` (300) considera vencido quem vence nos próximos 5 min; sem isso o jitter do cron faria o monitor ser pulado cerca de metade das vezes |
| Muitos monitores? | `WORKER_MAX_CHECKS` (200) por rodada; o resto fica vencido e é feito na seguinte |
| Cancelado ou morto no meio? | SIGTERM → para de reivindicar, fecha o que começou, grava `cancelled` (exit 130). Morte brusca: a rodada fica `running` e vira `abandoned` na seguinte; monitores já reivindicados só voltam no próximo intervalo (*at-most-once*, de propósito, para nunca checar em dobro) |
| Tempo total? | `WORKER_TIMEOUT_SECONDS` (240); estourou → exit 3. O job do GitHub tem teto próprio de 8 min |
| Banco fora / Neon sem horas? | exit 1, sem laço infinito |
| Provedor de e-mail fora? | O alerta fica `PENDING` com espera crescente (1 min, 5 min, 15 min, 1 h, 3 h, 6 h). Como o worker só roda a cada ~15 min, a retentativa acontece na primeira rodada depois da espera. Após 7 tentativas, `FAILED` |

Códigos de saída: `0` ok (inclui rodada truncada, com aviso) · `1` falha (banco/gravação) · `2` configuração inválida ou migrations ausentes · `3` tempo total estourado · `130` cancelado.

**Segredos:** o worker não imprime `DATABASE_URL` nem `RESEND_API_KEY` (redação por valor, por padrão de URL e de `re_...`; sem *stack traces*).
O YAML só referencia `secrets.*`, no passo do worker, via `env:` (nunca em `run:`). Se suspeitar de vazamento, **gire o segredo**: senha do Neon (*Roles → Reset password*) ou chave do Resend.

## 6. Observabilidade

`GET /health` (sem segredos):

```json
{
  "status": "ok",
  "scheduler": "disabled",
  "worker": {
    "expectedEveryMinutes": 15, "lateAfterMinutes": 45, "status": "ok",
    "lastSuccessAt": "2026-10-27T04:40:20.401Z", "ageSeconds": 170,
    "lastRun": { "status": "ok", "startedAt": "2026-10-27T04:40:20.388Z", "finishedAt": "2026-10-27T04:40:20.401Z" }
  }
}
```

- `worker.status`: `ok` · `late` (sem rodada bem-sucedida há mais de `lateAfterMinutes`, padrão 3× a cadência) · `never` · `unknown`.
- **O código HTTP não depende do worker.** Um atraso do GitHub nunca faz a Render reiniciar a API; por isso o health check dela é `/health/live`.
- Na página pública, uma checagem muito mais velha que a cadência aparece como **"checagem atrasada"**, distinta de "indisponível" e "sem dados", e nunca como operacional.
- Se `lastRun.status` for `failed`, veja os logs da execução em *Actions*.

## 7. Recuperar o acesso

| Situação | Procedimento |
|---|---|
| Esqueceu a senha | No seu computador, com a URL **direct**: `npm run admin -- reset-password` (encerra todas as sessões) |
| Suspeita de comprometimento | O mesmo `reset-password`; depois gire a senha do banco no Neon e revise os logs da Render (`login failed`/`login succeeded`) |
| Bloqueado por tentativas (429) | Espere a janela (15 min) ou, no SQL Editor do Neon: `DELETE FROM login_failures;` |
| Trocar o **nome de usuário** | No SQL Editor do Neon: `DELETE FROM admin_users;` e rode `create` com o novo nome |

## 8. Checklist antes de ativar (nada foi feito)

- [ ] Repositório criado (público, ou privado com `*/30`) e `worker.yml` na branch padrão
- [ ] Neon: projeto Free, URLs pooled/direct guardadas, `db:deploy` e `admin create` rodados do seu computador
- [ ] Render: Web Service Free com as variáveis da §4.3; `/health/live` responde `ok`
- [ ] (Opcional) Site estático com `VITE_API_URL`, `VITE_ADMIN_URL`, `VITE_POLL_SECONDS=600`; `CORS_ALLOWED_ORIGIN` na API
- [ ] GitHub: secrets e variável `ALERT_DELIVERY`; execução manual verde; `/health` com `worker.status: "ok"`
- [ ] `test-send` de e-mail confirmado (`docs/ALERTS.md`)
- [ ] Lembrete para conferir o uso do Neon e o aviso de 60 dias de inatividade do GitHub

## 9. Alternativa paga (não configurada)

Se o limite gratuito incomodar, o modo anterior (processo sempre ligado com o scheduler interno, `SCHEDULER_ENABLED=true`, a partir de 30 s)
continua no código e funciona (≈ US$ 13/mês na Render, ou um VPS). Não foi configurado.

## Fontes (consultadas em 2026-10-27)

- Neon, planos e limites: https://neon.com/docs/introduction/plans
- Render, planos gratuitos: https://render.com/docs/free
- GitHub Actions, evento `schedule`: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- GitHub Actions, cobrança e minutos: https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions
- GitHub Actions, segredos: https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions
- Public Suffix List: https://publicsuffix.org/list/
- Cloudflare Pages, limites: https://developers.cloudflare.com/pages/platform/limits/
- Resend, planos e limites: https://resend.com/pricing
