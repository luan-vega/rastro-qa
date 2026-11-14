import { getPath } from "./paths.js";

export interface Check { path: string; expected: string; actual: unknown; ok: boolean }

function num(v: unknown): number { return typeof v === "number" ? v : Number(String(v).replace(",", ".")); }

/** Compara um valor real com a expectativa escrita no cenário: "< 800", ">= 2", "exists", "/regex/", ou igualdade. */
export function matches(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "string") {
    if (expected === null) return actual === null || actual === undefined;
    if (typeof expected === "object") return JSON.stringify(actual) === JSON.stringify(expected);
    return actual === expected || String(actual) === String(expected);
  }
  const e = expected.trim();
  const cmp = e.match(/^(<=|>=|<|>|!=)\s*(-?[\d.,]+)\s*(%|ms)?$/);
  if (cmp) {
    const a = num(actual), b = num(cmp[2]);
    if (Number.isNaN(a)) return false;
    switch (cmp[1]) {
      case "<": return a < b;
      case "<=": return a <= b;
      case ">": return a > b;
      case ">=": return a >= b;
      case "!=": return a !== b;
    }
  }
  if (e === "exists") return actual !== undefined && actual !== null;
  if (e === "missing") return actual === undefined || actual === null;
  const re = e.match(/^\/(.+)\/([a-z]*)$/);
  if (re) return new RegExp(re[1], re[2]).test(String(actual));
  return String(actual) === e;
}

export function checkAll(expect: Record<string, unknown> | undefined, actual: unknown): Check[] {
  if (!expect) return [];
  return Object.entries(expect).map(([path, expected]) => {
    const value = getPath(actual, path);
    return { path, expected: typeof expected === "string" ? expected : JSON.stringify(expected), actual: value, ok: matches(value, expected) };
  });
}
