import "@testing-library/jest-dom/vitest";
import { MotionGlobalConfig } from "motion/react";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Animações do motion (entrada, saída, layout) concluem na hora nos testes: o que se testa é o estado final do DOM.
// A animação em si é verificada no navegador.
MotionGlobalConfig.skipAnimations = true;

afterEach(() => cleanup());

// jsdom não implementa <dialog>.showModal()/close() de forma completa: reproduz o essencial (atributo open + evento close).
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
