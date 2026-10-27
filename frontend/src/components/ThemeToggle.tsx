import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const query = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);
const explicit = (): Theme | null => {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : null;
};

/**
 * Alterna claro/escuro. Sem escolha explícita o tema segue o sistema (inclusive quando ele muda); a escolha, que
 * só grava "light" ou "dark" (nada pessoal), fica em localStorage e vale a partir do clique, nunca da montagem.
 */
export function ThemeToggle() {
  const [chosen, setChosen] = useState<Theme | null>(explicit);
  const [systemDark, setSystemDark] = useState(() => query()?.matches ?? false);

  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const theme: Theme = chosen ?? (systemDark ? "dark" : "light");
  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="btn btn--quiet theme-toggle"
      onClick={() => {
        setChosen(next);
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("pulse-theme", next);
        } catch {
          /* armazenamento indisponível: vale só nesta visita */
        }
      }}
    >
      {theme === "dark" ? "Tema claro" : "Tema escuro"}
    </button>
  );
}
