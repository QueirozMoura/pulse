export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const unauthorized = () => new AppError(401, "unauthorized", "Autenticação necessária");
export const forbidden = (code = "forbidden", message = "Acesso negado") => new AppError(403, code, message);
export const notFound = (message = "Não encontrado") => new AppError(404, "not_found", message);
