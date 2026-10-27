import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, csrf } from "../api/client";
import { authApi } from "../api/endpoints";
import type { SessionInfo } from "../api/types";

export type AuthState =
  | { status: "checking" }
  | { status: "authenticated"; user: SessionInfo }
  | { status: "anonymous"; notice?: string }
  /** Não deu para saber se há sessão (rede/servidor fora): não finge que está deslogado. */
  | { status: "unreachable"; error: ApiError };

interface AuthApi {
  state: AuthState;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Reconfere a sessão no servidor (também recarrega o token CSRF). */
  refresh: () => Promise<void>;
  /** Marca a sessão como encerrada (ex.: um 401 no meio de uma operação). */
  expire: (notice?: string) => void;
}

const Ctx = createContext<AuthApi | null>(null);

/**
 * Estado de sessão da área administrativa. Só é montado nas rotas /admin: a página pública não chama /auth/*.
 * O cookie é HttpOnly (o JavaScript nem enxerga); o token CSRF vive em memória no módulo `api/client`.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "checking" });

  const refresh = useCallback(async () => {
    try {
      const user = await authApi.session();
      setState({ status: "authenticated", user });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        csrf.clear();
        setState({ status: "anonymous" });
      } else {
        setState({ status: "unreachable", error: e instanceof ApiError ? e : new ApiError(0, "network_error", "Falha desconhecida") });
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const user = await authApi.login(username, password);
    setState({ status: "authenticated", user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch (e) {
      // 401 = a sessão já tinha acabado: tudo bem. Qualquer outra falha: continua logado e o chamador mostra o erro.
      if (!(e instanceof ApiError && e.status === 401)) throw e;
      csrf.clear();
    }
    setState({ status: "anonymous", notice: "Você saiu da sua conta." });
  }, []);

  const expire = useCallback((notice = "Sua sessão expirou. Entre de novo para continuar.") => {
    csrf.clear();
    setState({ status: "anonymous", notice });
  }, []);

  const value = useMemo(() => ({ state, login, logout, refresh, expire }), [state, login, logout, refresh, expire]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth fora do AuthProvider");
  return v;
}
