import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";


const HTML_HEADERS: Record<string, string> = {
  "cache-control": "no-cache",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

/**
 * Serve o build do frontend (mesma origem da API). Necessário no plano gratuito: sites em onrender.com, netlify.app etc.
 * estão na Public Suffix List, então frontend e API em hosts diferentes são "cross-site" e o cookie de sessão
 * (SameSite=Strict) não seria enviado. Mesma origem = cookie e CSRF funcionam sem afrouxar nada.
 */
export function registerStatic(app: FastifyInstance, dir: string): void {
  const root = resolve(dir);
  if (!existsSync(join(root, "index.html"))) throw new Error(`STATIC_DIR sem index.html: ${root}`);

  app.register(fastifyStatic, {
    root,
    wildcard: false, // não captura rotas desconhecidas: elas caem no 404 JSON
    index: false,
    setHeaders: (res, path) => {
      if (path.endsWith(".html")) for (const [k, v] of Object.entries(HTML_HEADERS)) res.header(k, v);
      else if (path.includes("/assets/")) res.header("cache-control", "public, max-age=31536000, immutable");
      else res.header("cache-control", "public, max-age=3600");
    },
  });

  const sendIndex = (reply: FastifyReply) => {
    for (const [k, v] of Object.entries(HTML_HEADERS)) reply.header(k, v);
    return reply.type("text/html; charset=utf-8").sendFile("index.html");
  };
  app.get("/", (_req, reply) => sendIndex(reply));
  app.get("/s/:id", (_req, reply) => sendIndex(reply));
  app.get("/admin", (_req, reply) => sendIndex(reply));
  app.get("/admin/*", (_req, reply) => sendIndex(reply));
}
