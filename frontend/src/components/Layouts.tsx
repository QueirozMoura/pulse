import { useEffect, useRef } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";

export function BrandMark() {
  return (
    <svg className="brand__mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="var(--brand)" />
      <path d="M4 17h6l3-8 5 15 3-7h7" fill="none" stroke="var(--brand-ink)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Leva o foco ao <main> quando a rota MUDA (teclado e leitor de tela percebem a nova página). Compara com o caminho
 * anterior em vez de usar um sinalizador "primeira vez", que o StrictMode (efeitos em dobro) enganaria.
 */
function useFocusMainOnNavigate() {
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    main.current?.focus({ preventScroll: false });
    window.scrollTo?.(0, 0);
  }, [pathname]);
  return main;
}

export function PublicLayout() {
  const main = useFocusMainOnNavigate();
  return (
    <>
      <a href="#main" className="skip-link">Ir para o conteúdo</a>
      <header className="site-header">
        <div className="container site-header__bar">
          <Link to="/" className="brand"><BrandMark />Pulse <span className="brand__sub">Status</span></Link>
          <div className="site-header__actions"><ThemeToggle /></div>
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1} className="site-main container">
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container">
          <p>Estado dos sistemas atualizado automaticamente a cada 30 segundos, sem recarregar a página.</p>
          <p>Uptime = checagens bem-sucedidas ÷ checagens realizadas. Períodos sem checagem não entram na conta.</p>
        </div>
      </footer>
    </>
  );
}
