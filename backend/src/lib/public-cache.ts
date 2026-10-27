/**
 * Cache em memória das respostas públicas, por TTL. Existe para poupar o banco: no plano gratuito do Neon cada consulta
 * acorda a computação (e ela só suspende depois de 5 min parada), então muitas visitas poderiam gastar as horas do mês.
 * - TTL 0 = desligado (padrão). Só guarda resultados bem-sucedidos e não vazios (um 404 nunca entra).
 * - Qualquer mudança feita no painel chama `clear()`: o administrador vê o efeito na hora.
 * - Por processo: com a API adormecendo e acordando, o cache recomeça vazio, o que é seguro.
 */
export class PublicCache {
  private readonly entries = new Map<string, { until: number; value: unknown }>();
  constructor(
    readonly ttlSeconds: number,
    private readonly maxEntries = 200,
  ) {}

  get enabled(): boolean {
    return this.ttlSeconds > 0;
  }

  async wrap<T>(key: string, produce: () => Promise<T>, cacheable: (v: T) => boolean = () => true): Promise<T> {
    if (!this.enabled) return produce();
    const hit = this.entries.get(key);
    if (hit && hit.until > Date.now()) return hit.value as T;
    const value = await produce();
    if (cacheable(value)) {
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { until: Date.now() + this.ttlSeconds * 1000, value });
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
