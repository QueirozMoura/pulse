import { Link } from "react-router-dom";
import { EmptyState } from "../components/feedback";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function NotFound() {
  useDocumentTitle("Página não encontrada — Pulse");
  return (
    <EmptyState title="Página não encontrada">
      O endereço não existe. <Link to="/">Voltar ao status dos sistemas</Link>.
    </EmptyState>
  );
}
