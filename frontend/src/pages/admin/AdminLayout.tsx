import { ExternalLink, LogOut } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { ErrorState, Skeleton } from "../../components/feedback";
import { Brand } from "../../components/Layouts";
import { describeError } from "../../lib/errorText";

/** Rotas /admin/*: confere a sessão no servidor antes de mostrar qualquer coisa. */
export function AdminLayout() {
  const auth = useAuth();
  const location = useLocation();
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const { state } = auth;

  const onLogout = async () => {
    setLeaving(true);
    setLogoutError(null);
    try {
      await auth.logout();
    } catch (e) {
      const d = describeError(e);
      setLogoutError(`${d.title}. ${d.text} Sua sessão continua aberta.`);
    } finally {
      setLeaving(false);
    }
  };

  if (state.status === "anonymous") return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;

  return (
    <>
      <a href="#main" className="skip-link">Ir para o conteúdo</a>
      <header className="topbar">
        <div className="container container--wide topbar__bar">
          <Brand sub="Painel" to="/admin" />
          <div className="topbar__actions">
            <Link to="/" className="topbar__link">
              Página pública <ExternalLink size={14} aria-hidden="true" />
            </Link>
            {state.status === "authenticated" && (
              <>
                <span className="who" title="Usuário conectado">{state.user.username}</span>
                <button type="button" className="btn btn--ghost btn--sm" onClick={onLogout} disabled={leaving}>
                  <LogOut size={15} aria-hidden="true" />
                  {leaving ? "Saindo…" : "Sair"}
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="site-main container container--wide">
        {logoutError && <div className="stack"><ErrorState title="Não foi possível sair">{logoutError}</ErrorState></div>}
        {state.status === "checking" && <Skeleton lines={4} label="Verificando sua sessão" />}
        {state.status === "unreachable" && (
          <ErrorState title="Não foi possível verificar sua sessão" onRetry={() => void auth.refresh()}>
            {describeError(state.error).text}
          </ErrorState>
        )}
        {state.status === "authenticated" && <Outlet />}
      </main>
    </>
  );
}
