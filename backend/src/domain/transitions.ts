export type MonitorStatus = "OPERATIONAL" | "UNAVAILABLE";

/** Falhas consecutivas necessárias para abrir um incidente. */
export const FAILURE_THRESHOLD = 2;

export interface MonitorState {
  status: MonitorStatus;
  consecutiveFailures: number;
  hasOpenIncident: boolean;
}

export interface Transition {
  status: MonitorStatus;
  consecutiveFailures: number;
  incident: "open" | "resolve" | "none";
}

/**
 * Função pura: dado o estado atual e o resultado de uma checagem,
 * decide o próximo estado e o que fazer com o incidente.
 *
 * - Sucesso: volta a operacional, zera falhas e resolve o incidente aberto (se houver).
 * - Falha: incrementa; ao atingir o limiar fica indisponível e abre incidente
 *   (apenas se ainda não houver um aberto).
 */
export function nextTransition(state: MonitorState, success: boolean): Transition {
  if (success) {
    return {
      status: "OPERATIONAL",
      consecutiveFailures: 0,
      incident: state.hasOpenIncident ? "resolve" : "none",
    };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    return {
      status: "UNAVAILABLE",
      consecutiveFailures,
      incident: state.hasOpenIncident ? "none" : "open",
    };
  }
  return { status: state.status, consecutiveFailures, incident: "none" };
}
