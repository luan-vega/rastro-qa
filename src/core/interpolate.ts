import { getPath } from "./paths.js";
import { SetupError } from "./errors.js";

export type Scope = Record<string, unknown>;

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

function lookup(expr: string, scope: Scope): unknown {
  if (expr.startsWith("secret:")) {
    const name = expr.slice("secret:".length).trim();
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new SetupError(`Segredo ${name} não definido`, `Defina a variável de ambiente ${name} ou o arquivo .env`, "secret");
    }
    return value;
  }
  if (expr.startsWith("env:")) return process.env[expr.slice(4).trim()] ?? "";
  // Procura primeiro em vars, depois em capturas, depois no escopo raiz (massa.x, correlationId, runId...)
  for (const root of [scope.vars, scope.captures, scope]) {
    const v = getPath(root, expr);
    if (v !== undefined) return v;
  }
  throw new SetupError(`Variável {{${expr}}} não encontrada`, "Declare em vars:, na massa ou capture num passo anterior");
}

/** Substitui {{...}} recursivamente. Um texto que é só um placeholder devolve o valor original (número, objeto). */
export function interpolate<T>(value: T, scope: Scope): T {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (whole) return lookup(whole[1], scope) as T;
    return value.replace(PLACEHOLDER, (_, expr: string) => {
      const v = lookup(expr, scope);
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, scope)])) as T;
  }
  return value;
}

/** Igual a interpolate, mas deixa intactos os placeholders que não existem (usado em queries do lock). */
export function interpolatePartial(text: string, scope: Scope): string {
  return text.replace(PLACEHOLDER, (m, expr: string) => {
    try {
      const v = lookup(expr, scope);
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    } catch {
      return m;
    }
  });
}
