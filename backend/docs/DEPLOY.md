# Hospedagem e operação em produção

> **Estado:** proposta. Nada foi contratado, configurado ou implantado. Os valores abaixo são de consultas feitas em
> 2026-10-27 (fontes no fim) e precisam ser reconferidos no painel antes de pagar.

## 1. O que o Pulse exige de uma hospedagem

| Requisito | Por quê |
|---|---|
| **Processo sempre ligado** (não serverless, não "dorme") | O scheduler é um loop dentro do processo; sem processo, não há checagem |
| **PostgreSQL gerenciado ou com backup** | Todo o estado (agendamento, histórico, incidentes, sessões) está no banco |
| **1 instância** (mais de uma funciona, ver §5) | Não há ganho em escalar; o gargalo é a rede, não a CPU |
| Saída HTTPS livre | As checagens são requisições de saída |
| Shell ou acesso ao banco | Criar/recuperar o administrador pela CLI (§7) |

O seu computador **não participa**: API, scheduler e banco rodam na hospedagem. Desligá-lo não interrompe nada.

## 2. Opções avaliadas

| Opção | Custo mensal | Veredito |
|---|---|---|
| **Render pago** (web service Starter + Postgres Basic-256mb) | **≈ US$ 13,30** (7 + 6 + 0,30 de 1 GB) | **Recomendada** |
| VPS Hetzner CX23 (2 vCPU, 4 GB, 40 GB) rodando tudo | € 5,99 (+ ≈ € 1,20 de backup), sem impostos | Mais barata e potente, mas **você opera** o servidor |
| Railway (Hobby) | US$ 5 + uso (RAM ≈ US$ 10/GB-mês, vCPU ≈ US$ 20/vCPU-mês, volume US$ 0,15/GB-mês) | Custo variável e difícil de prever; não recomendo |
| Render gratuito | US$ 0 | **Descartada:** o serviço dorme após 15 min sem requisição (o scheduler para) e o Postgres gratuito expira em 30 dias |

Não avaliei Fly.io, Neon, Supabase nem Oracle Cloud. Free tiers de banco que "pausam por inatividade" tendem a
conflitar com um scheduler que consulta o banco a cada 5 s, mas **isso não foi verificado**.

### Por que Render

- Sem sistema operacional para manter: patches, TLS e reinício do processo são da plataforma.
- Postgres gerenciado com **backup contínuo (PITR de 3 dias na workspace Hobby, 7 na Pro)** e exportações lógicas guardadas por 7 dias.
- Shell no painel e SSH para serviços pagos: é por onde roda a CLI do administrador.
- Pre-Deploy Command para as migrations e health check em `/health`.
- Deploy sem downtime: a instância nova sobe antes de a antiga receber `SIGTERM` (≈ 60 s depois da troca). Por isso
  o scheduler foi feito para tolerar duas instâncias ao mesmo tempo (§5).

A Hetzner vence em preço e folga de recursos. Escolha-a se aceitar operar: `docker compose` com Postgres, Caddy para TLS,
`pg_dump` agendado para fora da máquina, atualizações de segurança. A CLI do administrador seria
`docker compose exec -it api node dist/cli/admin.js create --username ...`. Não há Dockerfile no repositório
(não consegui testá-lo neste ambiente); seria o primeiro passo dessa rota.

## 3. Configuração proposta (Render)

Dois recursos na **mesma região** (necessário para a URL interna do banco), na workspace **Hobby**:

**PostgreSQL** — plano Basic-256mb, 1 GB de armazenamento (o armazenamento não pode ser reduzido depois).
Desative o acesso externo ou restrinja a lista de IPs (o padrão é `0.0.0.0/0`, protegido só por senha).

**Web Service** (Node, plano Starter, 1 instância)

| Campo | Valor |
|---|---|
| Build Command | `npm ci --include=dev && npm run build` |
| Pre-Deploy Command | `npm run db:deploy` |
| Start Command | `npm start` |
| Health Check Path | `/health` (devolve 503 se o banco cair **ou o scheduler travar**; a Render reinicia) |

> `--include=dev` é uma precaução: a Render define `NODE_ENV=production`, o que normalmente faz o `npm ci` pular
> devDependencies. Numa cópia limpa deste projeto, `NODE_ENV=production npm ci` **sem** a flag também compilou, mas só
> porque o `prisma` traz o `typescript` como dependência transitiva; não convém depender disso. O `prisma` foi movido para
> `dependencies` para o Pre-Deploy (`prisma migrate deploy`) funcionar em produção. Esta receita (install, build,
> migrations em banco vazio, `npm start`, CLI a partir de `dist/`) foi executada localmente em modo produção; **não foi
> executada na Render**.

Variáveis de ambiente:

| Variável | Valor | Observação |
|---|---|---|
| `NODE_ENV` | `production` | Cookie `Secure` + `__Host-`; admin tem que estar atrás de HTTPS |
| `DATABASE_URL` | URL **interna** do Postgres | Segredo; só no painel |
| `TRUST_PROXY_HOPS` | `1` | **Confirme** com um login de teste que `req.ip` é o seu IP e não o do proxy (veja o log `login failed`) |
| `CORS_ALLOWED_ORIGIN` | origem do frontend | Quando o frontend existir |
| `SESSION_COOKIE_SAMESITE` | `strict` | Exige frontend no mesmo site (subdomínios do mesmo domínio) |
| `ALERT_DELIVERY` | `email` | Alertas por e-mail ([ALERTS.md](ALERTS.md)). Com `email`, exige as três abaixo |
| `ALERT_EMAIL_TO` | seu e-mail | Destino dos alertas |
| `ALERT_EMAIL_FROM` | `Pulse <alertas@seudominio.com>` | Remetente aceito pelo Resend |
| `RESEND_API_KEY` | chave do Resend | **Segredo**; só no painel da Render |
| `HOST` | `0.0.0.0` | |
| demais | padrões | `MAX_MONITORS=100`, `CHECK_RETENTION_DAYS=30`, `CHECK_TIMEOUT_MS=10000`, `MIN_INTERVAL_SECONDS=30` |

## 4. Custo e dimensionamento

**Custo fixo estimado: ≈ US$ 13,30/mês** (Starter US$ 7 + Basic-256mb US$ 6 + 1 GB a US$ 0,30), mais impostos. Workspace Hobby
custa US$ 0 e inclui 5 GB de banda (excedente US$ 0,15/GB). A saída do Pulse é pequena (só cabeçalhos das checagens e
JSON da página de status).

Medidas feitas neste repositório (PostgreSQL 18 local, não na Render):

| Medida | Valor |
|---|---|
| Uma checagem no banco (linha + índice) | **≈ 168 bytes** |
| 1 monitor a cada 30 s, retenção de 30 dias | 86.400 linhas ≈ **14 MB** |
| 1 monitor a cada 60 s, retenção de 30 dias | ≈ 7 MB |
| Memória do processo (API + scheduler, ocioso) | **≈ 156 MB** |
| Um hash de senha (login) | ≈ 164 ms e pico de ≈ 64 MiB |

Conclusões: o Starter (512 MB) comporta o processo com folga mesmo durante um login. Em 1 GB de banco cabem
**≈ 65 monitores a 30 s** (ou ≈ 130 a 60 s) com 30 dias de retenção. O padrão `MAX_MONITORS=100` a 30 s precisaria de
≈ 1,4 GB: aumente o armazenamento, reduza `CHECK_RETENTION_DAYS` ou use intervalos maiores. A retenção apaga o excedente
automaticamente (a cada hora, em lotes).

**Não testado:** a capacidade de escrita do Basic-256mb (0,1 vCPU). 100 monitores a 30 s são ≈ 3,3 gravações por segundo,
provavelmente confortável, mas comece com poucos monitores e observe antes de crescer.

## 5. Como o scheduler continua rodando (e o que acontece nas falhas)

- O loop mora no processo da API. Não depende de visitas. Enquanto o serviço estiver de pé, checa.
- O agendamento fica no banco (`next_check_at`). **Reinício:** o que venceu é checado uma vez, sem rajada de reposição.
- **Deploy com sobreposição** ou mais de uma instância: cada monitor é reivindicado por uma só instância
  (`FOR UPDATE SKIP LOCKED`, provado em teste com duas instâncias e janela de corrida forçada).
- **Checagem lenta:** ocupa só a própria vaga. Há `SCHEDULER_CONCURRENCY` (10) vagas e cada checagem tem timeout total de
  `CHECK_TIMEOUT_MS`. O intervalo mínimo aceito é sempre maior que o timeout.
- **Banco fora:** o processo não cai. Registra o erro, tenta no próximo ciclo (5 s) e `/health` passa a responder 503.
- **Queda no meio de uma checagem:** a checagem é perdida, **nunca repetida**. Há um buraco de no máximo um intervalo.
- **Resultados obsoletos** (monitor pausado, excluído ou com URL alterada durante a checagem, ou resultado que chega depois
  de um mais novo) não alteram estado nem abrem/fecham incidentes.
- `SIGTERM`: para de reivindicar e espera as checagens em andamento (≤ timeout), dentro dos 30 s padrão da Render.

## 6. Limitações que permanecem

1. **Ponto único de falha.** Se a Render ou a região cair, ninguém monitora, e o Pulse não se avisa. Recomendo um monitor
   externo gratuito apontado para `/health` (retorna 503 também com o scheduler travado). Os alertas por e-mail avisam
   dos incidentes **dos seus sites**, não de uma queda do próprio Pulse.
2. **Um único ponto de observação.** As checagens saem da região da Render; um problema de rota entre ela e o seu
   site pode parecer indisponibilidade.
3. **Buracos no histórico** em reinícios/deploys; o uptime é `checagens bem-sucedidas ÷ checagens feitas`, então
   períodos sem checagem não contam como queda nem como disponibilidade (a API expõe o tamanho da amostra).
4. **Segurança de rede:** `SSRF` é tratado na aplicação (ver README); a Render não oferece firewall de saída para bloquear a rede interna.
5. Rate limit só no login. Rotas públicas têm `Cache-Control: public, max-age=10`; para absorver tráfego alto ponha um CDN
   na frente (pendência).

## 7. Administrador em produção

A conta é criada **dentro do ambiente que tem acesso ao banco de produção**. A senha nunca vai em argumento, variável de
ambiente nem no repositório: é digitada num prompt sem eco (ou lida do stdin).

### Criar o primeiro administrador (Render)

1. Faça o primeiro deploy e confirme que `GET /health` responde `200` (isso garante que as migrations rodaram).
2. Abra o serviço no painel → aba **Shell** (ou `render ssh <serviço>` depois de cadastrar sua chave SSH).
3. Confirme que o ambiente do shell enxerga o banco, **sem imprimir o segredo**:
   ```bash
   test -n "$DATABASE_URL" && echo "DATABASE_URL definida" || echo "ausente"
   ```
   A documentação da Render não afirma que as variáveis do serviço estão disponíveis no shell. Se estiver ausente,
   cole a URL **interna** do painel: `export DATABASE_URL='postgresql://...'` (a sessão encerra no próximo deploy).
4. Crie a conta (pede a senha duas vezes, sem eco):
   ```bash
   node dist/cli/admin.js create --username seu-usuario
   ```
5. Teste o login a partir do seu computador e confirme o cookie `__Host-pulse_session` com `Secure` e `HttpOnly`.

Sessões de shell/SSH fecham a cada deploy ou manutenção. Isso não afeta o administrador já criado.

### Recuperar o acesso

| Situação | Procedimento |
|---|---|
| Esqueceu a senha | No shell: `node dist/cli/admin.js reset-password`. Troca a senha e **encerra todas as sessões** |
| Suspeita de comprometimento | O mesmo `reset-password`; depois troque a senha do banco no painel e revise os logs de `login failed`/`login succeeded` |
| Bloqueado por tentativas (429) | Espere a janela (15 min) ou, no shell do banco: `DELETE FROM login_failures;` |
| Quer trocar o **nome de usuário** | No banco: `DELETE FROM admin_users;` (apaga as sessões em cascata) e rode `create` com o novo nome |
| Sem acesso ao shell da Render | No painel do Postgres, libere **temporariamente** o seu IP (`/32`) na lista de acesso externo e, no seu computador: `DATABASE_URL='<URL externa com ?sslmode=require>' npm run admin -- reset-password`. Remova o IP depois |

A CLI compilada (`node dist/cli/admin.js`) existe depois de `npm run build` em qualquer máquina que tenha as dependências instaladas
e a `DATABASE_URL`; foi testada a partir de `dist/` em modo produção.

## 8. Checklist antes do primeiro deploy (nada disto foi feito)

- [ ] Você aprova o custo (≈ US$ 13,30/mês) e a região.
- [ ] Criar o Postgres; desativar/restringir acesso externo.
- [ ] Criar o web service com os campos da §3; copiar a URL interna.
- [ ] Primeiro deploy → `/health` 200 → criar o administrador (§7).
- [ ] Confirmar `TRUST_PROXY_HOPS` (IP real nos logs de login).
- [ ] Alertas: configurar as variáveis `ALERT_*`/`RESEND_API_KEY` e rodar `node dist/cli/alerts.js test-send --confirm` no shell
      (um e-mail de teste) antes de depender deles; depois o degrau 3 de [ALERTS.md](ALERTS.md) num banco de teste.
- [ ] Cadastrar um monitor de teste (ver README → "Cadastrando monitores em produção" abaixo) e ver o histórico andar.
- [ ] Monitor externo no `/health` e um teste de restauração de backup (PITR cria uma instância nova; valide antes de trocar).

## Fontes (consultadas em 2026-10-27)

- Render, planos gratuitos e limites: https://render.com/docs/free
- Render, preços (Starter US$ 7, Basic-256mb US$ 6, armazenamento US$ 0,30/GB) — via resumo de busca da página de preços e do artigo
  https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses (a tabela de preços não renderizou na consulta
  direta, e há menção a uma mudança de planos em 1º de agosto de 2026: **reconfirme em https://render.com/pricing**)
- Resend, planos e limites: https://resend.com/pricing e https://resend.com/docs/api-reference/emails/send-email
- Render, backups/PITR: https://render.com/docs/postgresql-backups
- Render, shell/SSH: https://render.com/docs/ssh
- Render, deploys, Pre-Deploy e desligamento: https://render.com/docs/deploys
- Render, acesso externo ao Postgres: https://render.com/docs/postgresql-creating-connecting
- Hetzner Cloud: https://www.hetzner.com/cloud/cost-optimized/ (preços sem impostos)
- Railway: https://railway.com/pricing
