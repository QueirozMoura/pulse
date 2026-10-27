/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Segundos entre atualizações da página pública (padrão 60). Em produção gratuita, recomendado 600. */
  readonly VITE_POLL_SECONDS?: string;
  /** Painel hospedado na API (mesma origem do cookie). Se definido, /admin* neste site redireciona para lá. */
  readonly VITE_ADMIN_URL?: string;
}
