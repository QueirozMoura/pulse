import { Outlet, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { PublicLayout } from "./components/Layouts";
import { NotFound } from "./pages/NotFound";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { LoginPage } from "./pages/admin/LoginPage";
import { MonitorsPage } from "./pages/admin/MonitorsPage";
import { MonitorPage } from "./pages/public/MonitorPage";
import { StatusPage } from "./pages/public/StatusPage";

export function App() {
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
