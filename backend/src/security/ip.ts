import { isIP } from "node:net";

type Cidr4 = readonly [base: number, bits: number];

const ip4 = (s: string): number =>
  s.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);

const BLOCKED_V4: Cidr4[] = (
  [
    ["0.0.0.0", 8], // "this network"
    ["10.0.0.0", 8], // privado
    ["100.64.0.0", 10], // CGNAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local (inclui metadados de nuvem 169.254.169.254)
    ["172.16.0.0", 12], // privado
    ["192.0.0.0", 24], // IETF
    ["192.0.2.0", 24], // documentação
    ["192.168.0.0", 16], // privado
    ["198.18.0.0", 15], // benchmark
    ["198.51.100.0", 24], // documentação
    ["203.0.113.0", 24], // documentação
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reservado + broadcast
  ] as const
).map(([b, bits]) => [ip4(b), bits] as const);

function isPublicV4(addr: string): boolean {
  const n = ip4(addr);
  return !BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

/** Expande um IPv6 textual para 8 grupos de 16 bits. Aceita "::" e sufixo IPv4. */
function expandV6(addr: string): number[] | null {
  let a = addr.toLowerCase().split("%")[0]!;
  const lastColon = a.lastIndexOf(":");
  const tail = a.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const n = ip4(tail);
    a = `${a.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.length === 8 && nums.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? nums : null;
}

const v4FromGroups = (hi: number, lo: number): string =>
  `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPublicV6(addr: string): boolean {
  const g = expandV6(addr);
  if (!g) return false; // na dúvida, bloqueia
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];

  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return false; // ::1
  // ::ffff:a.b.c.d (IPv4-mapped) e ::a.b.c.d (compat): vale a regra do IPv4 embutido
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return isPublicV4(v4FromGroups(g6, g7));
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPublicV4(v4FromGroups(g6, g7)); // NAT64 64:ff9b::/96
  }
  if (g0 === 0x2002) return isPublicV4(v4FromGroups(g1, g2)); // 6to4
  if (g0 === 0x2001 && g1 === 0) return false; // Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentação
  if ((g0 & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  return true;
}

/** true somente para endereços IP globalmente roteáveis. Entrada que não é IP → false. */
export function isPublicIp(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, "");
  switch (isIP(host)) {
    case 4:
      return isPublicV4(host);
    case 6:
      return isPublicV6(host);
    default:
      return false;
  }
}
