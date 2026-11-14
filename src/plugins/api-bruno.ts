import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { StepPlugin } from "../core/types.js";
import { checkAll } from "../core/assert.js";
import { SetupError } from "../core/errors.js";
import { describe, summarizeBody } from "./api-http.js";

export function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd, env: env ?? process.env });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e: NodeJS.ErrnoException) => rej(e.code === "ENOENT" ? new SetupError(`Comando "${cmd}" não encontrado`, cmd === "bru" ? "Instale com: npm i -g @usebruno/cli" : undefined, "tool_missing") : e));
    p.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}

/** O reporter JSON do Bruno mudou de formato entre versões: aceita objeto ou lista de iterações. */
export function brunoResults(report: any): any[] {
  const iterations = Array.isArray(report) ? report : [report];
  return iterations.flatMap((it) => it?.results ?? []);
}

export const brunoPlugin: StepPlugin = {
  kind: "api",
  name: "bruno",
  supports: (step) => step.spec.tool === "bruno",

  async run(step, ctx) {
    const spec = ctx.resolve(step.spec);
    if (!spec.collection) throw new SetupError(`O passo "${step.title}" precisa de collection:`);
    const collection = resolve(dirname(step.file), spec.collection);
    const brunoEnv = spec.env ?? ctx.env.api?.bruno?.env;
    const reportRel = `api/${ctx.stepSlug}.bruno.json`;
    const vars: Record<string, unknown> = { ...(spec.vars ?? {}), correlationId: `${ctx.correlation.id}-api` };

    const args = ["run"];
    if (spec.request) args.push(spec.request.endsWith(".bru") ? spec.request : `${spec.request}.bru`);
    if (brunoEnv) args.push("--env", brunoEnv);
    for (const [k, v] of Object.entries(vars)) args.push("--env-var", `${k}=${v}`);
    args.push("--reporter-json", ctx.evidence.path(reportRel));

    await mkdir(dirname(ctx.evidence.path(reportRel)), { recursive: true });
    const t0 = performance.now();
    const proc = await run(process.env.RASTRO_BRU_BIN ?? "bru", args, collection);
    const wallMs = Math.round(performance.now() - t0);
    let report: any;
    try { report = JSON.parse(await readFile(ctx.evidence.path(reportRel), "utf8")); } catch {
      throw new SetupError(`O Bruno não gerou relatório (código ${proc.code}): ${(proc.stderr || proc.stdout).slice(-400)}`);
    }
    // O relatório pode ter o token de autenticação; regrava mascarado
    await ctx.evidence.writeMasked(reportRel, report);

    const results = brunoResults(report);
    if (!results.length) throw new SetupError(`O Bruno não executou nenhuma requisição em ${collection}`);
    const last = results[results.length - 1];
    const res = last.response ?? {};
    const durationMs = res.responseTime ?? wallMs;
    const actual = { status: res.status, body: res.data, headers: res.headers ?? {}, durationMs };
    ctx.capture(spec.capture, actual);

    const checks = checkAll(spec.expect, actual);
    // Testes escritos dentro da própria coleção também contam
    for (const t of [...(last.testResults ?? []), ...(last.assertionResults ?? [])]) {
      checks.push({ path: `bruno: ${t.description ?? t.lhsExpr ?? "teste"}`, expected: "pass", actual: t.status, ok: t.status === "pass" });
    }
    if (last.error) checks.push({ path: "bruno: erro", expected: "nenhum", actual: last.error, ok: false });
    const ok = checks.every((c) => c.ok);
    const name = spec.request ?? last.test?.filename ?? "requisição";
    return {
      status: ok ? "passed" : "failed",
      summary: `Bruno "${name}" → ${res.status} em ${durationMs} ms`,
      checks,
      evidence: {
        calls: [{
          name: `Bruno "${name}"`,
          sent: ctx.evidence.mask(describe(spec.vars)),
          received: `${res.status}${ctx.evidence.mask(summarizeBody(res.data))}`,
          durationMs,
          ok,
        }],
      },
    };
  },
};
