import type { StepPlugin } from "../core/types.js";
import { checkAll } from "../core/assert.js";
import { SetupError } from "../core/errors.js";

/** Chamada HTTP direta, sem coleção. Útil para APIs simples e para testes locais. */
export const httpPlugin: StepPlugin = {
  kind: "api",
  name: "http",
  supports: (step) => step.spec.tool === "http",

  async run(step, ctx) {
    const spec = ctx.resolve(step.spec);
    const method = String(spec.method ?? "GET").toUpperCase();
    if (!spec.url) throw new SetupError(`O passo "${step.title}" precisa de url:`);
    const url = /^https?:/.test(spec.url) ? spec.url : new URL(spec.url, ctx.env.baseUrl).toString();
    const headers: Record<string, string> = { ...(spec.headers ?? {}) };
    if (ctx.config.correlation.injectInto.includes("api")) headers[ctx.correlation.header] = `${ctx.correlation.id}-api`;
    let body: string | undefined;
    if (spec.body !== undefined) {
      body = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
      headers["content-type"] ??= "application/json";
    }

    const t0 = performance.now();
    const res = await fetch(url, { method, headers, body });
    const durationMs = Math.round(performance.now() - t0);
    const text = await res.text();
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* corpo não é JSON */ }

    const slug = `api/${ctx.stepSlug}`;
    await ctx.evidence.writeMasked(`${slug}.request.json`, { method, url, headers, body: body ? safeJson(body) : undefined });
    await ctx.evidence.writeMasked(`${slug}.response.json`, { status: res.status, headers: Object.fromEntries(res.headers), body: data });

    const actual = { status: res.status, body: data, headers: Object.fromEntries(res.headers), durationMs };
    ctx.capture(spec.capture, actual);
    const checks = checkAll(spec.expect, actual);
    const ok = checks.every((c) => c.ok);
    return {
      status: ok ? "passed" : "failed",
      summary: `${method} ${new URL(url).pathname} → ${res.status} em ${durationMs} ms`,
      checks,
      evidence: {
        calls: [{
          name: spec.name ?? `${method} ${new URL(url).pathname}`,
          sent: ctx.evidence.mask(describe(spec.body)),
          received: `${res.status}${summarizeBody(data)}`,
          durationMs,
          ok,
        }],
      },
    };
  },
};

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }

export function describe(body: unknown): string {
  if (body === undefined || body === null) return "sem corpo";
  if (typeof body !== "object") return String(body).slice(0, 80);
  return Object.entries(body as Record<string, unknown>).slice(0, 4).map(([k, v]) => `${k} ${typeof v === "object" ? "…" : v}`).join(" · ");
}

export function summarizeBody(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const keys = Object.entries(data as Record<string, unknown>).filter(([, v]) => typeof v !== "object").slice(0, 3);
  return keys.length ? " · " + keys.map(([k, v]) => `${k} ${v}`).join(" · ") : "";
}
