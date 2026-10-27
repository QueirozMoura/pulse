import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// scrypt (OWASP: N=2^17,r=8,p=1 ou equivalente). 2^16 com r=8 ≈ 64 MiB e ~100-200 ms por hash.
const PARAMS = { N: 2 ** 16, r: 8, p: 1 } as const;
const KEYLEN = 32;
const MAXMEM = 256 * 1024 * 1024;

function derive(password: string, salt: Buffer, o: { N: number; r: number; p: number }): Promise<Buffer> {
  const opts: ScryptOptions = { N: o.N, r: o.r, p: o.p, maxmem: MAXMEM };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Formato: scrypt$N$r$p$salt(base64)$hash(base64). Os parâmetros ficam no hash, permitindo evoluí-los. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, saltB64, hashB64] = stored.split("$");
  if (kind !== "scrypt" || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every(Number.isInteger) || params.N > 2 ** 20) return false;
  const actual = await derive(password, Buffer.from(saltB64, "base64"), params);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;
/** Hash descartável: verificar contra ele quando o usuário não existe iguala o tempo de resposta. */
export function getDummyHash(): Promise<string> {
  return (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
