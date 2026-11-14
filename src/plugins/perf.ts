import { createReadStream, existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { parse } from "csv-parse";
import type { StepPlugin, PerfRow } from "../core/types.js";
import type { RunContext } from "../core/context.js";
import { SetupError } from "../core/errors.js";
import { matches } from "../core/assert.js";
import { resolveQuery } from "../ai/resolve.js";
import { sourceFor } from "./sources.js";
import { run } from "./api-bruno.js";

export interface Stats { reqs: number; p50: number; p90: number; p95: number; errorRate: number }

export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.max(0, Math.ceil((q / 100) * sorted.length) - 1)];
}

/** Lê o .jtl (CSV com cabeçalho) e calcula p50, p90, p95 e taxa de erro. */
export async function statsFromJtl(file: string, label?: string): Promise<Stats> {
  const times: number[] = [];
  let errors = 0;
  for await (const r of createReadStream(file).pipe(parse({ columns: true, relax_column_count: true }))) {
    if (label && r.label !== label) continue;
    times.push(Number(r.elapsed));
    if (String(r.success) !== "true") errors++;
  }
  if (!times.length) throw new SetupError(`O arquivo ${file} não tem amostras${label ? ` com label "${label}"` : ""}`);
  times.sort((a, b) => a - b);
  return {
    reqs: times.length,
    p50: percentile(times, 50), p90: percentile(times, 90), p95: percentile(times, 95),
    errorRate: +((errors / times.length) * 100).toFixed(2),
  };
}

/** Aplica o orçamento: "+10%" é variação relativa ao baseline, "< 1" é valor absoluto. */
export function compareStats(where: string, base: Partial<Stats> | undefined, cand: Stats, budget: Record<string, string>): PerfRow[] {
  const metrics = ["p50", "p90", "p95", "errorRate"] as const;
  return metrics.filter((m) => cand[m] !== undefined && !Number.isNaN(cand[m])).map((m) => {
    const rule = budget[m];
    const b = base?.[m];
    const c = cand[m];
    const deltaPct = b ? +(((c - b) / b) * 100).toFixed(1) : undefined;
    let ok = true;
    if (rule) {
      const rel = rule.trim().match(/^\+\s*([\d.,]+)\s*%$/);
      if (rel) ok = deltaPct === undefined ? true : deltaPct <= Number(rel[1].replace(",", "."));
      else ok = matches(c, rule.replace(/%$/, "").trim());
    }
    return { metric: m, where, baseline: b, candidate: c, deltaPct, rule, ok };
  });
}

function baselineFile(ctx: RunContext) {
  return join(ctx.project.root, ctx.config.perf.baselinesDir, `${ctx.scenario.meta.id}.${ctx.envName}.json`);
}

export interface Baseline { scenario: string; env: string; runId: string; savedAt: string; savedBy: string; client?: Stats; server?: Stats }

export async function saveBaseline(root: string, baselinesDir: string, statsFile: string, by: string): Promise<string> {
  const s = JSON.parse(await readFile(statsFile, "utf8"));
  const out = join(root, baselinesDir, `${s.scenario}.${s.env}.json`);
  await mkdir(dirname(out), { recursive: true });
  const b: Baseline = { scenario: s.scenario, env: s.env, runId: s.runId, savedAt: new Date().toISOString(), savedBy: by, client: s.client, server: s.server };
  await writeFile(out, JSON.stringify(b, null, 2) + "\n");
  return out;
}

async function massaCsv(ctx: RunContext): Promise<string | undefined> {
  const records: Record<string, unknown>[] = [
    ...ctx.scenario.meta.massa.map((n) => ctx.massa[n]).filter(Boolean),
    ...(Array.isArray(ctx.massa.carga) ? ctx.massa.carga : []),
  ].filter((r) => r && typeof r === "object");
  if (!records.length) return undefined;
  const cols = [...new Set(records.flatMap((r) => Object.keys(r).filter((k) => typeof r[k] !== "object")))];
  const csv = [cols.join(","), ...records.map((r) => cols.map((c) => String(r[c] ?? "").replace(/,/g, " ")).join(","))].join("\n");
  const rel = "perf/massa.csv";
  await ctx.evidence.write(rel, csv + "\n");
  return ctx.evidence.path(rel);
}

async function runJmeter(ctx: RunContext, load: Record<string, any>, stepFile: string): Promise<{ jtl: string; samples?: number }> {
  const d = ctx.config.perf.jmeter.defaults;
  const plan = resolve(dirname(stepFile), load.plan ?? "");
  if (!load.plan || !existsSync(plan)) throw new SetupError(`Plano do JMeter não encontrado: ${plan}`, "Gere com: rastro jmeter generate --from-bru <arquivo.bru>", "not_found");
  const home = ctx.config.perf.jmeter.home;
  const bin = process.env.RASTRO_JMETER_BIN ?? (home ? join(home, "bin", "jmeter") : "jmeter");
  const jtl = ctx.evidence.path("perf/resultado.jtl");
  const csv = await massaCsv(ctx);
  const props: Record<string, unknown> = {
    threads: load.threads ?? d.threads,
    rampSec: load.rampSec ?? d.rampSec,
    durationSec: load.durationSec ?? d.durationSec,
    correlationId: `${ctx.correlation.id}-jm`,
    ...(ctx.env.jmeter?.host ? { host: ctx.env.jmeter.host } : {}),
    ...(ctx.env.jmeter?.port ? { port: ctx.env.jmeter.port } : {}),
    protocol: ctx.env.jmeter?.protocol ?? "https",
    ...(csv ? { massaCsv: csv } : {}),
    aggregate_rpt_pct1: 50, aggregate_rpt_pct2: 90, aggregate_rpt_pct3: 95,
    // As vars do cenário viram propriedades do JMeter (${__P(nome)} no plano)
    ...ctx.resolve(ctx.scenario.meta.vars),
    ...(load.properties ?? {}),
  };
  const args = ["-n", "-t", plan, "-l", jtl, "-e", "-o", ctx.evidence.path("perf/jmeter-dashboard"),
    "-j", ctx.evidence.path("perf/jmeter.log")];
  const propsFile = join(ctx.project.root, "perf", "jmeter", `${ctx.envName}.properties`);
  if (existsSync(propsFile)) args.push("-q", propsFile);
  for (const [k, v] of Object.entries(props)) args.push(`-J${k}=${v}`);
  const res = await run(bin, args, ctx.project.root);
  if (res.code !== 0 || !existsSync(jtl)) throw new SetupError(`JMeter terminou com código ${res.code}: ${(res.stderr || res.stdout).slice(-400)}`);
  return { jtl };
}

export const perfPlugin: StepPlugin = {
  kind: "perf",
  name: "perf",
  supports: () => true,

  async run(step, ctx) {
    const spec = ctx.resolve(step.spec);
    const load = spec.load ?? {};
    const budget: Record<string, string> = spec.budget ?? {};
    const loadStart = Date.now();

    let jtl: string;
    if (load.tool === "jmeter") jtl = (await runJmeter(ctx, load, step.file)).jtl;
    else if (load.jtl) jtl = resolve(dirname(step.file), load.jtl);
    else throw new SetupError(`O passo "${step.title}" precisa de load.tool: jmeter ou load.jtl`);
    const loadEnd = Date.now();

    const client = await statsFromJtl(jtl, load.label);
    let server: Stats | undefined;
    let serverQuery: string | undefined;
    if (spec.server) {
      const source = sourceFor(spec.server.source ?? "cloudwatch", ctx);
      if (source.dialect === "file") throw new SetupError("Percentis do servidor precisam de cloudwatch ou splunk");
      const r = await resolveQuery({ ctx, step: { ...step, spec: spec.server }, dialect: source.dialect, mode: "perf" });
      serverQuery = r.query;
      await ctx.evidence.write("perf/servidor.query.txt", r.query + "\n");
      const rows = await ctx.retryUntil(() => source.run(r.query, loadStart - 30_000, loadEnd + 60_000), (rs) => rs.length > 0, source.ingestionWaitSec);
      const best = [...rows].sort((a, b) => Number(b.reqs ?? b.count ?? 0) - Number(a.reqs ?? a.count ?? 0))[0];
      if (best) server = { reqs: Number(best.reqs ?? best.count ?? 0), p50: Number(best.p50), p90: Number(best.p90), p95: Number(best.p95), errorRate: Number(best.errorRate ?? NaN) };
    }

    const bfile = baselineFile(ctx);
    const baseline: Baseline | undefined = existsSync(bfile) ? JSON.parse(await readFile(bfile, "utf8")) : undefined;
    const rows = [
      ...compareStats("JMeter (cliente)", baseline?.client, client, budget),
      ...(server ? compareStats("Servidor", baseline?.server, server, budget) : []),
    ];
    await ctx.evidence.writeJson("perf/stats.json", { scenario: ctx.scenario.meta.id, env: ctx.envName, runId: ctx.runId, client, server, baseline: baseline ? { runId: baseline.runId, savedAt: baseline.savedAt } : null, rows, serverQuery });

    const failed = rows.filter((r) => !r.ok);
    const status = failed.length ? "failed" : baseline ? "passed" : "warning";
    const p95 = rows.find((r) => r.metric === "p95");
    const summary = `${client.reqs} amostras · p50 ${client.p50} ms · p90 ${client.p90} ms · p95 ${client.p95} ms` +
      (baseline ? ` (p95 antes ${p95?.baseline} ms, ${p95?.deltaPct !== undefined ? (p95.deltaPct >= 0 ? "+" : "") + p95.deltaPct + "%" : "?"})` : " · sem baseline para comparar");
    const notes = baseline ? [] : [`Sem baseline salvo para ${ctx.scenario.meta.id} em ${ctx.envName}. Depois de conferir esta execução, salve com: rastro perf baseline ${ctx.evidence.dir}`];
    return {
      status,
      summary,
      checks: rows.map((r) => ({ path: `${r.metric} ${r.where}`, expected: r.rule ?? "-", actual: r.candidate, ok: r.ok })),
      evidence: {
        perf: {
          load: { tool: load.tool ?? "jtl", threads: load.threads, rampSec: load.rampSec, durationSec: load.durationSec, samples: client.reqs },
          rows,
          baselineRef: baseline ? `${baseline.runId} (salvo em ${baseline.savedAt.slice(0, 10)} por ${baseline.savedBy})` : undefined,
        },
        notes,
      },
    };
  },
};
