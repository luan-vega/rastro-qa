export const EXIT = { PASSED: 0, FAILED: 1, SETUP: 2, TIMEOUT: 3 } as const;

/** Problema de ambiente, configuração ou aprovação: a execução não pode começar ou continuar (exit 2). */
/**
 * Códigos estáveis para agentes decidirem o próximo passo sem interpretar texto.
 * needs_approval e query_pending sempre exigem uma pessoa; o agente deve parar e pedir.
 */
export type ErrorCode =
  | "config" | "not_found" | "needs_approval" | "query_pending" | "massa"
  | "env_not_allowed" | "session" | "secret" | "tool_missing" | "invalid_scenario" | "setup" | "timeout";

export class SetupError extends Error {
  constructor(message: string, readonly hint?: string, readonly code: ErrorCode = "setup") {
    super(message);
    this.name = "SetupError";
  }
}

/** Tempo esgotado esperando algo externo (exit 3). */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
