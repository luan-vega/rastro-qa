import { mascararDocumentosNoTexto } from "../core/documentos.js";

/** Mascara segredos (por nome de chave) e CPF/CNPJ (por padrão) em qualquer estrutura. */
export function mask<T>(value: T, sensitiveKeys: string[]): T {
  const keys = sensitiveKeys.map((k) => k.toLowerCase());
  const isSensitive = (k: string) => keys.some((s) => k.toLowerCase().includes(s));
  const visit = (v: unknown, key = ""): unknown => {
    if (key && isSensitive(key) && v !== null && v !== undefined && typeof v !== "object") return "***";
    if (typeof v === "string") {
      const bearer = v.replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/g, "$1***");
      return mascararDocumentosNoTexto(bearer);
    }
    if (Array.isArray(v)) return v.map((x) => visit(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, k)]));
    return v;
  };
  return visit(value) as T;
}
