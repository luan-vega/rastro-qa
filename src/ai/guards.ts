import type { Dialect, QueryMode } from "./types.js";

const FORBIDDEN: Record<Dialect, RegExp[]> = {
  cwli: [],
  spl: [/\|\s*(delete|outputlookup|collect|sendemail|script|map|rest|outputcsv|tscollect)\b/i, /^\s*\|\s*rest\b/i],
  "datadog-logs": [],
};

const DOC_RE = /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|[0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}\/?[0-9A-Z]{4}-?\d{2})\b/g;

/** Devolve o motivo da recusa, ou null se a query pode rodar. */
export function guardQuery(query: string, dialect: Dialect, mode: QueryMode, massaDocs: Set<string>): string | null {
  for (const re of FORBIDDEN[dialect]) if (re.test(query)) return `comando proibido (${re.source})`;
  if (mode === "validation" && !query.includes("{{correlationId}}")) {
    return "query de validação precisa filtrar por {{correlationId}}";
  }
  const usesStats = /\bstats\b/i.test(query);
  if (dialect === "cwli" && !usesStats && !/\|\s*limit\s+\d+/i.test(query)) return 'faltou "| limit N"';
  if (dialect === "spl") {
    if (!/^\s*search\b/i.test(query)) return 'a query SPL precisa começar com "search"';
    if (!usesStats && !/\|\s*head\s+\d+/i.test(query)) return 'faltou "| head N"';
  }
  for (const m of query.matchAll(DOC_RE)) {
    const norm = m[0].toUpperCase().replace(/[.\/-]/g, "");
    if ((norm.length === 11 || norm.length === 14) && !massaDocs.has(norm)) {
      return `a query usa o documento ${m[0]}, que não está na massa informada pelo usuário`;
    }
  }
  return null;
}
