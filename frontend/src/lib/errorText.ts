import { ApiError } from "../api/client";
import { formatDuration } from "./format";

export interface Described {
  /** Frase curta para o título do aviso. */
  title: string;
  /** Explicação e o que fazer. */
  text: string;
  /** Erros por campo do formulário (path do contrato → mensagem). */
  fields: Record<string, string>;
  /** Erros de validação que não pertencem a um campo (path vazio ou desconhecido). */
  general: string[];
  requestId?: string;
  /** 401: a sessão acabou; a tela deve voltar ao login. */
  unauthenticated: boolean;
  /** 403 csrf: o token da sessão não confere; recarregar a sessão resolve. */
  csrf: boolean;
}

const FIELD_LABEL: Record<string, string> = { name: "Nome", url: "URL", intervalSeconds: "Intervalo", publicVisible: "Exibir na página pública" };

/** Traduz erros do contrato (API.md §6) e falhas de rede em mensagens que dizem o que houve e o que fazer. */
export function describeError(err: unknown, ctx: "login" | "admin" = "admin"): Described {
  const base: Described = { title: "Algo deu errado", text: "Tente de novo em instantes.", fields: {}, general: [], unauthenticated: false, csrf: false };
  if (!(err instanceof ApiError)) return { ...base, text: "Ocorreu um erro inesperado nesta tela. Recarregue a página e tente de novo." };
  const d: Described = { ...base, requestId: err.requestId };

  if (err.network) {
    return { ...d, title: "Sem conexão com a API", text: "Não foi possível falar com o servidor. Confira sua rede e se o backend está no ar, depois tente de novo." };
  }
  switch (err.code) {
    case "validation_error": {
      for (const i of err.issues) {
        if (i.path in FIELD_LABEL) d.fields[i.path] ??= i.message;
        else d.general.push(i.message);
      }
      return { ...d, title: "Revise os dados informados", text: "Corrija os campos indicados e envie de novo." };
    }
    case "invalid_credentials":
      return { ...d, title: "Usuário ou senha incorretos", text: "Confira os dados e tente de novo." };
    case "unauthorized":
      return { ...d, unauthenticated: true, title: "Sua sessão expirou", text: "Entre de novo para continuar." };
    case "csrf":
      return { ...d, csrf: true, title: "Verificação de segurança falhou", text: "O token de segurança desta sessão não conferiu. Atualizamos a sessão; repita a ação." };
    case "origin_not_allowed":
      return { ...d, title: "Origem não permitida pelo servidor", text: "O backend recusou esta página como origem. Em desenvolvimento, confira CORS_ALLOWED_ORIGIN no backend (deve ser exatamente a origem desta página)." };
    case "monitor_limit_reached":
      return { ...d, title: "Limite de monitores atingido", text: `${err.message}. Exclua um monitor que não use mais, ou peça ao responsável para aumentar o limite (MAX_MONITORS).` };
    case "too_many_attempts": {
      const when = err.retryAfterSeconds ? `em ${formatDuration(err.retryAfterSeconds)}` : "em alguns minutos";
      return { ...d, title: "Muitas tentativas", text: ctx === "login" ? `Por segurança, o login foi bloqueado temporariamente. Tente de novo ${when}.` : `Aguarde e tente de novo ${when}.` };
    }
    case "not_found":
      return { ...d, title: "Monitor não encontrado", text: "Ele pode ter sido excluído em outro lugar. A lista foi atualizada." };
    case "payload_too_large":
    case "unsupported_media_type":
    case "bad_request":
      return { ...d, title: "Requisição recusada", text: "O servidor não aceitou o que foi enviado. Recarregue a página e tente de novo." };
    default:
      return err.status >= 500
        ? { ...d, title: "Erro no servidor", text: "O servidor falhou ao processar o pedido. Tente de novo em instantes; se persistir, informe o código abaixo a quem administra o Pulse." }
        : { ...d, title: "Não foi possível concluir", text: err.message };
  }
}
