import type { Db } from "../lib/db.js";

export interface ThrottleLimits {
  windowMinutes: number;
  maxPerIp: number;
  maxGlobal: number;
}

export interface ThrottleDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Limita força bruta com falhas registradas no banco (vale entre instâncias e restarts):
 * - por IP: maxPerIp falhas dentro da janela bloqueiam aquele IP;
 * - global: maxGlobal falhas de qualquer origem bloqueiam todos (limita ataques distribuídos).
 * O bloqueio global pode atrasar o próprio administrador durante um ataque, no máximo até a janela esvaziar.
 */
export async function checkLoginThrottle(db: Db, ip: string, limits: ThrottleLimits): Promise<ThrottleDecision> {
  const windowMs = limits.windowMinutes * 60_000;
  const since = new Date(Date.now() - windowMs);
  await db.loginFailure.deleteMany({ where: { createdAt: { lt: since } } });

  const [perIp, global] = await Promise.all([
    db.loginFailure.count({ where: { ip, createdAt: { gte: since } } }),
    db.loginFailure.count({ where: { createdAt: { gte: since } } }),
  ]);
  if (perIp < limits.maxPerIp && global < limits.maxGlobal) return { allowed: true, retryAfterSeconds: 0 };

  // Libera quando a falha mais antiga relevante sair da janela.
  const oldest = await db.loginFailure.findFirst({
    where: { createdAt: { gte: since }, ...(perIp >= limits.maxPerIp ? { ip } : {}) },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const retryMs = oldest ? oldest.createdAt.getTime() + windowMs - Date.now() : windowMs;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
}

export async function recordLoginFailure(db: Db, ip: string): Promise<void> {
  await db.loginFailure.create({ data: { ip } });
}

export async function clearLoginFailures(db: Db, ip: string): Promise<void> {
  await db.loginFailure.deleteMany({ where: { ip } });
}
