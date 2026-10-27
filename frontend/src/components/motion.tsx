import { domMax, LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/**
 * Animações por transform/opacity e por layout (reordenar cards quando um sistema muda de estado).
 * `reducedMotion="user"` respeita prefers-reduced-motion: movimentos de transformação são desligados.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
