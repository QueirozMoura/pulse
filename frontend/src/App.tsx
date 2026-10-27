import { useEffect } from "react";
import { Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { PublicLayout } from "./components/Layouts";
import { NotFound } from "./pages/NotFound";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { LoginPage } from "./pages/admin/LoginPage";
import { MonitorsPage } from "./pages/admin/MonitorsPage";
import { MonitorPage } from "./pages/public/MonitorPage";
import { StatusPage } from "./pages/public/StatusPage";

/**
 * URL do painel quando ele NÃO está na mesma origem deste site (VITE_ADMIN_URL). No plano gratuito os hosts de sites
 * estáticos e a API ficam em sites diferentes (cross-site), onde o cookie de sessão SameSite=Strict não é enviado; por isso
 * o painel é servido pela própria API. Aqui só levamos o administrador até lá. Só aceita https:// (ou http em localhost).
 */
function adminRedirectTarget(path: string): string | null {
  const raw = import.meta.env.VITE_ADMIN_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) return null;
    return u.origin + path;
  } catch {
    return null;
  }
}

function ExternalAdmin({ to }: { to: string }) {
  useEffect(() => void window.location.replace(to), [to]);
  return <p className="site-main container">Abrindo o painel administrativo… <a href={to}>Clique aqui se não abrir.</a></p>;
}

export function App() {
  const { pathname } = useLocation();
  const external = pathname.startsWith("/admin") ? adminRedirectTarget(pathname) : null;
  if (external) return <ExternalAdmin to={external} />;
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<StatusPage />} />
        <Route path="s/:id" element={<MonitorPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      {/* A sessão só é consultada nas rotas /admin: visitantes da página pública não disparam chamadas de autenticação. */}
      <Route path="admin" element={<AuthProvider><Outlet /></AuthProvider>}>
        <Route path="login" element={<LoginPage />} />
        <Route element={<AdminLayout />}>
          <Route index element={<MonitorsPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
