import { LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { Notice } from "../../components/feedback";
import { HeroSignal } from "../../components/HeroSignal";
import { Brand } from "../../components/Layouts";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { describeError, type Described } from "../../lib/errorText";

export function LoginPage() {
  useDocumentTitle("Entrar — Pulse");
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/admin";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Described | null>(null);

  if (auth.state.status === "authenticated") return <Navigate to={from} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await auth.login(username.trim(), password);
      setPassword("");
      navigate(from, { replace: true });
    } catch (err) {
      setPassword("");
      setError(describeError(err, "login"));
    } finally {
      setBusy(false);
    }
  };

  const notice = auth.state.status === "anonymous" ? auth.state.notice : undefined;

  return (
    <>
      <a href="#main" className="skip-link">Ir para o conteúdo</a>
      <main id="main" tabIndex={-1} className="login">
        <aside className="login__art" aria-hidden="true">
          <div className="login__art-copy">
            <p className="login__art-title">Cada sistema sob vigilância.</p>
            <p className="login__art-text">O Pulse checa seus sistemas o tempo todo e abre um incidente quando algo cai.</p>
          </div>
          <HeroSignal tone="partial" />
        </aside>
        <div className="login__panel">
          <div className="login__card">
            <Brand sub="Painel" to="/" />
            <h1 className="login__title">Entrar no painel</h1>
            <p className="login__lead">Gerencie os sistemas que o Pulse acompanha.</p>
            {notice && <Notice tone="info">{notice}</Notice>}
            {auth.state.status === "unreachable" && (
              <Notice tone="warn" title="Não foi possível verificar a sessão">
                {describeError(auth.state.error).text}
              </Notice>
            )}
            {error && (
              <Notice tone="error" title={error.title}>
                {error.text}
                {error.requestId && <small className="notice__code"> Código: {error.requestId}</small>}
              </Notice>
            )}
            <form onSubmit={onSubmit} className="form" noValidate>
              <div className="field">
                <label htmlFor="username">Usuário</label>
                <input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="password">Senha</label>
                <input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <button type="submit" className="btn btn--primary btn--lg" disabled={busy || !username.trim() || !password}>
                <LogIn size={18} aria-hidden="true" />
                {busy ? "Entrando…" : "Entrar"}
              </button>
            </form>
            <p className="login__hint">A conta de administrador é criada pelo responsável no servidor. Não há cadastro nem recuperação por e-mail aqui.</p>
          </div>
        </div>
      </main>
    </>
  );
}
