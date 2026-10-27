import { useEffect, useRef, useState } from "react";

/**
 * Devolve true por `ms` depois que `signature` MUDA (nunca na primeira renderização). Serve para destacar,
 * por um instante, o card cujo estado/dado acabou de mudar numa atualização.
 */
export function useChangeFlash(signature: string, ms = 1800): boolean {
  const prev = useRef(signature);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prev.current === signature) return;
    prev.current = signature;
    setOn(true);
    const id = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(id);
  }, [signature, ms]);
  return on;
}
