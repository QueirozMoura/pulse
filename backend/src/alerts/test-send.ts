import type { EmailTransport } from "./transports.js";

export type TestSendOutcome = "dry-run" | "sent" | "failed";

/**
 * Envia UM e-mail de teste, fora da outbox, só quando `confirm` é verdadeiro. Sem confirmação apenas descreve
 * o que faria. É o caminho controlado para validar a chave, o remetente e o destino com o provedor real.
 */
export async function runTestSend(opts: {
  transport: EmailTransport;
  to: string;
  from: string;
  confirm: boolean;
  print: (line: string) => void;
  now?: () => Date;
}): Promise<TestSendOutcome> {
  const at = (opts.now ?? (() => new Date()))().toISOString();
  opts.print(`Remetente: ${opts.from}`);
  opts.print(`Destino:   ${opts.to}`);
  if (!opts.confirm) {
    opts.print("Nada foi enviado (simulação). Para enviar UM e-mail de teste, repita com --confirm.");
    return "dry-run";
  }
  const result = await opts.transport.send({
    to: opts.to,
    from: opts.from,
    subject: "[Pulse] E-mail de TESTE (não é um incidente)",
    text: `Este é um e-mail de teste do Pulse, enviado em ${at}.\nNenhum monitor está com problema. Se você o recebeu, o envio de alertas está configurado corretamente.`,
    html: `<p>Este é um e-mail de <b>teste</b> do Pulse, enviado em ${at}.</p><p>Nenhum monitor está com problema. Se você o recebeu, o envio de alertas está configurado corretamente.</p>`,
    idempotencyKey: `pulse-test-${at}-${Math.random().toString(36).slice(2, 10)}`,
  });
  if (result.ok) {
    opts.print(`Enviado. id no provedor: ${result.messageId ?? "(não informado)"}`);
    return "sent";
  }
  opts.print(`Falhou: ${result.kind}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}`);
  return "failed";
}
