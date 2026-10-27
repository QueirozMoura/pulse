import { useEffect, useRef } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg className="brand__mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="brand-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8e7cff" />
          <stop offset="1" stopColor="#4fd8ff" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#brand-g)" />
      <path d="M4.5 17.5h6l3-8.5 5 15 3-7h6" fill="none" stroke="#060912" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ sub, to = "/" }: { sub: string; to?: string }) {
  return (
    <Link to={to} className="brand">
      <BrandMark />
      <span className="brand__name">Pulse</span>
      <span className="brand__sub">{sub}</span>
    </Link>
  );
}

/**
 * Leva o foco ao <main> quando a rota MUDA (teclado e leitor de tela percebem a nova página). Compara com o caminho
 * anterior em vez de usar um sinalizador "primeira vez", que o StrictMode (efeitos em dobro) enganaria.
 */
export function useFocusMainOnNavigate() {
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
      <header className="topbar">
        <div className="container topbar__bar">
          <Brand sub="Status" />
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1} className="site-main container">
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container">
          <p>O estado dos sistemas é atualizado sozinho a cada 30 segundos, sem recarregar a página.</p>
          <p>Uptime é a razão entre checagens bem-sucedidas e checagens realizadas. Períodos sem checagem não entram na conta.</p>
        </div>
      </footer>
    </>
  );
}
