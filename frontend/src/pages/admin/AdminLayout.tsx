import { useState } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { ErrorState, Skeleton } from "../../components/feedback";
import { BrandMark } from "../../components/Layouts";
import { ThemeToggle } from "../../components/ThemeToggle";
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
      <header className="site-header">
        <div className="container container--wide site-header__bar">
          <Link to="/admin" className="brand"><BrandMark />Pulse <span className="brand__sub">Painel</span></Link>
          <div className="site-header__actions">
            <Link to="/">Página pública</Link>
            <ThemeToggle />
            {state.status === "authenticated" && (
              <>
                <span className="who">{state.user.username}</span>
                <button type="button" className="btn btn--quiet" onClick={onLogout} disabled={leaving}>{leaving ? "Saindo…" : "Sair"}</button>
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
