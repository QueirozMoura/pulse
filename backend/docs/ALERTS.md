# Alertas por e-mail

O Pulse envia **um e-mail quando um incidente abre** (2 falhas consecutivas) e **outro quando ele é resolvido**, com a
duração. Nada é enviado a cada checagem enquanto o monitor continua indisponível. O provedor é o **Resend** (API HTTPS,
sem dependência nova). Não há Redis nem fila externa: a fila é uma tabela do próprio PostgreSQL.

## 1. Como funciona

```
checagem ──► transição de estado ──┬─► incidente (abre/resolve)        ┐ mesma transação:
                                   └─► alert_events (PENDING)           ┘ ou grava os dois, ou nenhum
                                                │
              dispatcher (loop próprio, fora do scheduler)
                                                │ reivindica com FOR UPDATE SKIP LOCKED + lease
                                                ▼
                                   Resend  (Idempotency-Key = pulse-alert-<id do evento>)
                                                │
                       sucesso ──► SENT        falha ──► PENDING + espera (backoff)  ──► FAILED após o limite
```

| Requisito | Como é atendido |
|---|---|
| Sem e-mail por checagem | Só **transições** geram evento. `UNIQUE(incidente, tipo)` no banco torna impossível um segundo "aberto" para o mesmo incidente |
| Não perder o aviso | O evento é gravado **na mesma transação** que abre/resolve o incidente. Reinício do processo ou provedor fora do ar não o apagam: ele fica `PENDING` até ser enviado |
| Retentativas com limite | 7 tentativas no total (a 1ª + 6 retentativas) com espera de **1 min, 5 min, 15 min, 1 h, 3 h, 6 h** (≈ 10 h 20 min no total). Depois, `FAILED` e um log de nível `error` |
| Resultado registrado | Em cada linha: `status`, `attempts`, `last_attempt_at`, `last_error_kind` (categoria), `provider_message_id`, `sent_at` |
| Sem bloquear o scheduler | O dispatcher é outro loop. Um provedor lento ou fora do ar nunca atrasa uma checagem (coberto por teste) |
| Sem duplicidade com 2 instâncias | Reivindicação com `FOR UPDATE SKIP LOCKED` e posse temporária (lease de 2 min) |
| Sem duplicidade em retentativas | O id do evento vai como `Idempotency-Key`. Se o provedor aceitar o e-mail e o processo cair antes de registrar, o reenvio usa a **mesma chave** e o Resend não entrega de novo (janela de 24 h do provedor) |
| Ordem coerente | O "resolvido" só sai depois que o "aberto" do mesmo incidente terminou (enviado ou esgotado) |
| Teto por hora | `ALERT_MAX_PER_HOUR` (30): um monitor oscilando não esgota a cota. O excedente **espera** na tabela, sem gastar tentativas |

### O que o e-mail contém (e o que nunca contém)

Contém: **nome** do monitor, horário de início (UTC), horário de fim e **duração** (no "resolvido") e a **categoria**
da falha (`dns`, `timeout`, ...). Não contém: URL, host, IP, cookie, token, mensagem de erro bruta nem stack trace.
Isso é garantido pela construção: o gerador do e-mail (`renderAlert`) recebe um tipo que **não tem campo de URL**, a
consulta do dispatcher não seleciona a URL, e testes conferem a cadeia inteira com uma URL cheia de segredos. O nome do
monitor é texto digitado por você: não ponha segredos nele (ele já aparece na página de status pública).

Exemplo (abertura):

```
Assunto: [Pulse] ALERTA: API de pagamentos está indisponível

O monitor "API de pagamentos" está INDISPONÍVEL.

Situação: incidente aberto após 2 falhas consecutivas.
Início do incidente: 2026-10-27 01:55:07 UTC
Tipo da falha: falha de resolução de DNS

Você receberá outro e-mail quando o serviço voltar ao normal. Nenhum novo alerta será enviado enquanto o incidente continuar aberto.
```

Exemplo (resolução): assunto `[Pulse] Resolvido: API de pagamentos voltou ao normal (indisponível por 12 min 30 s)`,
com `Início`, `Fim` e `Duração` no corpo.

## 2. Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `ALERT_DELIVERY` | `off` | `off`: nada é criado nem enviado. `log`: a outbox funciona e o e-mail renderizado vai **só para o log** (sem rede). `email`: envia pelo Resend |
| `ALERT_EMAIL_TO` | — | **Endereço de destino** (um só). Obrigatório com `email` |
| `ALERT_EMAIL_FROM` | — | Remetente: `alertas@seudominio.com` ou `Pulse <alertas@seudominio.com>`. Obrigatório com `email` |
| `RESEND_API_KEY` | — | Chave da API. **Segredo**: só em variável de ambiente da hospedagem ou no `.env` local (ignorado pelo git) |
| `ALERT_MAX_PER_HOUR` | `30` | Teto de e-mails por hora |

- **Desativar em desenvolvimento:** o padrão já é `off`. Para ver o fluxo sem enviar nada use `ALERT_DELIVERY=log`.
- Com `ALERT_DELIVERY=email` faltando destino, remetente ou chave, o processo **não inicia** (falha explícita).
- O dispatcher roda onde roda o scheduler (`SCHEDULER_ENABLED=true`), porque é ele quem cria os eventos.
- Habilitar os alertas **não** gera alertas retroativos: incidentes já abertos antes não têm evento.
- Pausar um monitor com incidente aberto não envia nada; excluir um monitor descarta os alertas pendentes dele.

### Provedor (Resend)

Plano gratuito consultado em 2026-10-27: **3.000 e-mails/mês e 100/dia** (Pro: US$ 20/mês por 50.000), fonte
https://resend.com/pricing. A documentação que consultei **não informa** se o remetente precisa ser de um domínio
verificado: o `test-send` abaixo mostra isso na prática (um `401/403` ou `422` aparece como `unauthorized`/`rejected`).
Um alerta por abertura e outro por resolução ficam muito abaixo da cota; o `ALERT_MAX_PER_HOUR` protege dos casos de oscilação.

## 3. Verificar um envio real de forma controlada

**A suíte de testes nunca envia e-mail.** Ela usa um provedor falso e um servidor HTTP local; além disso o `vitest.config.ts`
zera `ALERT_DELIVERY`, `RESEND_API_KEY` e os endereços no ambiente dos testes, então chaves exportadas no seu shell não
são usadas. O caminho real é manual e em três degraus, do mais seguro ao mais completo:

**Degrau 1 — fluxo completo sem enviar nada (`log`).**
```bash
ALERT_DELIVERY=log npm run dev
```
Faça login, cadastre um monitor apontando para `https://nao-existe.invalid` (intervalo 30 s) e, depois de ~1 min, procure no log
`alert email (log only, NOT sent)` com o assunto e o corpo renderizados. Corrija a URL (`PATCH`) para ver o de resolução.

**Degrau 2 — um único e-mail de teste pelo provedor real.**
```bash
export ALERT_DELIVERY=email ALERT_EMAIL_TO=voce@exemplo.com ALERT_EMAIL_FROM='Pulse <alertas@seudominio.com>'
read -rs RESEND_API_KEY && export RESEND_API_KEY      # digite a chave sem eco; não fica no histórico
npm run alerts -- test-send                # simulação: mostra remetente/destino e NÃO envia
npm run alerts -- test-send --confirm      # envia exatamente 1 e-mail, assunto "[Pulse] E-mail de TESTE"
```
Falhas aparecem como categoria (`unauthorized (HTTP 401)` = chave errada; `rejected (HTTP 422)` = remetente/destino recusado).
O `test-send` não usa a outbox e não toca no banco.

**Degrau 3 — pipeline real com raio de explosão limitado.** Em um banco **de teste** (não o de produção):
1. `ALERT_DELIVERY=email` com o seu endereço e `ALERT_MAX_PER_HOUR=3` (limite de segurança).
2. Cadastre **um** monitor em `https://nao-existe.invalid` com intervalo de 30 s. Em ~1 min chega **um** "ALERTA". Deixe-o
   falhar por mais alguns minutos: **nenhum** e-mail adicional deve chegar.
3. Edite a URL para `https://example.com`. Chega **um** "Resolvido" com a duração.
4. `npm run alerts -- status` deve mostrar `SENT 2`, `PENDING 0`, `FAILED 0`. Exclua o monitor de teste.
Total esperado: 2 e-mails.

## 4. Operação

```bash
npm run alerts -- status            # contagens por estado e os 10 eventos mais recentes com problema (sem segredos)
```
Em produção: `node dist/cli/alerts.js status` (e `test-send`) no shell do serviço, como a CLI do administrador.

Eventos `FAILED` (provedor fora por mais de ~10 h, chave inválida, destino recusado) ficam na tabela e no log
(`alert permanently failed`). Depois de corrigir a causa, para reenviá-los:

```sql
UPDATE alert_events
SET status = 'PENDING', attempts = 0, locked_until = NULL, next_attempt_at = (now() AT TIME ZONE 'UTC')
WHERE status = 'FAILED';
```
Cuidado: são avisos antigos, que chegarão agora; e se o provedor chegou a aceitar o e-mail há mais de 24 h, a
Idempotency-Key já expirou e o destinatário pode receber o aviso em duplicidade.

Logs úteis (JSON): `alert sent`, `alert delivery failed, will retry` (com `errorKind`, `httpStatus`, `retryInSeconds`),
`alert permanently failed`, `alert delivery bookkeeping failed`.

## 5. Limitações

- **Um único destinatário** e um único provedor.
- **Se o Pulse estiver fora do ar, ninguém avisa** (e se o e-mail falhar por horas, o `FAILED` só aparece no log/CLI).
  Mantenha um monitor externo gratuito em `/health`.
- **Entrega "pelo menos uma vez" com deduplicação do provedor.** Sem a janela de 24 h do Resend a garantia seria só do banco.
- Remetente/destino mal configurados só aparecem na primeira tentativa real: rode o `test-send --confirm` antes de depender dos alertas.
- Mensagens chegam em UTC e em português; sem personalização por monitor.
- Entregabilidade (spam, SPF/DKIM do seu domínio) é responsabilidade da configuração do domínio no provedor.
