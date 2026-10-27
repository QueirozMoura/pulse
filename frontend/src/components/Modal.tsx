import { useEffect, useRef, type ReactNode } from "react";

/**
 * Diálogo modal com o <dialog> nativo: o navegador cuida do foco preso, do Esc e de devolver o foco a quem abriu.
 * Clicar fora NÃO fecha (evita perder um formulário preenchido sem querer).
 */
export function Modal({ open, onClose, titleId, role = "dialog", children }: { open: boolean; onClose: () => void; titleId: string; role?: "dialog" | "alertdialog"; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Foco inicial explícito (o padrão do navegador é "o primeiro elemento focável", que depende da ordem do DOM).
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      role={role}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && children}
    </dialog>
  );
}
