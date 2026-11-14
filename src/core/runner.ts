import { join, relative } from "node:path";
import type { Project } from "./config.js";
import { envConfig } from "./config.js";
import { loadScenario, findScenarioFiles, type Scenario } from "./scenario.js";
import { Approvals, type ApprovalRecord } from "./approval.js";
import { loadMassa, exigirMassa } from "./massa.js";
import { RunContext, newRunId, type RunFlags } from "./context.js";
import { EXIT, SetupError, TimeoutError } from "./errors.js";
import type { Emit } from "./events.js";
import type { StepResult } from "./types.js";
import { Evidence } from "../evidence/recorder.js";
import { pluginFor } from "../plugins/index.js";
import { writeReports } from "../evidence/reports.js";

export interface RunResult {
  runId: string;
  scenario: Scenario;
  env: string;
  approval?: ApprovalRecord;
  startedAt: string;
  finishedAt: string;
  status: "aprovado" | "reprovado" | "erro";
  exitCode: number;
  steps: StepResult[];
  evidenceDir: string;
  massaUsed: string[];
  recorded: Record<string, unknown>[];
  gitCommit?: string;
}

function slugify(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "passo";
}

async function gitCommit(root: string): Promise<string | undefined> {
  try {
    const { run } = await import("../plugins/api-bruno.js");
    const r = await run("git", ["rev-parse", "--short", "HEAD"], root);
    return r.code === 0 ? r.stdout.trim() : undefined;
  } catch { return undefined; }
}

export async function runScenarioFile(project: Project, file: string, opts: { env?: string; explicitEnv?: boolean; flags: RunFlags; emit: Emit }): Promise<RunResult> {
  const scenario = await loadScenario(file);
  const envName = opts.env ?? scenario.meta.env ?? project.config.defaultEnv;
  const env = envConfig(project, envName, { viaMcp: opts.flags.viaMcp, explicit: opts.explicitEnv });

  const approvals = await Approvals.load(project.root);
  const status = approvals.status(scenario);
  if (project.config.approval.required && status !== "aprovado" && !opts.flags.dryRun) {
    throw new SetupError(
      status === "alterado" ? `O cenário ${scenario.meta.id} mudou depois de aprovado` : `O cenário ${scenario.meta.id} ainda é rascunho`,
      `Revise com "rastro scenario review ${scenario.meta.id}" e aprove com "rastro scenario approve ${scenario.meta.id}"`,
      "needs_approval",
    );
  }

  const massa = await loadMassa(project.root, project.config.massa.file);
  exigirMassa(massa, scenario.meta.massa);

  const runId = newRunId(project.config.correlation.prefix);
  const evidence = new Evidence(join(project.root, project.config.evidence.dir, runId), project.config.secrets.mask);
  const ctx = new RunContext(project, envName, env, scenario, massa, runId, evidence, opts.flags, opts.emit);
  const startedAt = new Date();
  opts.emit({ type: "run_start", runId, scenario: `${scenario.meta.id} · ${scenario.meta.title}`, env: envName, correlationId: runId });

  const steps: StepResult[] = [];
  let fatal: Error | undefined;
  for (const [i, step] of scenario.steps.entries()) {
    ctx.stepIndex = i + 1;
    ctx.stepSlug = `${String(i + 1).padStart(2, "0")}-${slugify(step.title)}`;
    opts.emit({ type: "step_start", index: i + 1, kind: step.kind, title: step.title });
    const t0 = performance.now();
    let result: StepResult;
    if (fatal || opts.flags.dryRun) {
      result = { kind: step.kind, title: step.title, status: "skipped", summary: opts.flags.dryRun ? "não executado (--dry-run)" : "não executado (erro anterior)", durationMs: 0, checks: [], evidence: {} };
    } else {
      try {
        const out = await pluginFor(step).run(step, ctx);
        result = { kind: step.kind, title: step.title, durationMs: Math.round(performance.now() - t0), ...out };
      } catch (e) {
        const err = e as Error;
        if (err instanceof SetupError || err instanceof TimeoutError) fatal = err;
        result = {
          kind: step.kind, title: step.title, status: "error", summary: "não concluído",
          durationMs: Math.round(performance.now() - t0), checks: [], evidence: {},
          error: err.message + (err instanceof SetupError && err.hint ? `. ${err.hint}` : ""),
        };
      }
    }
    steps.push(result);
    opts.emit({ type: "step_end", index: i + 1, result });
  }
  await ctx.cleanup();

  const anyError = steps.some((s) => s.status === "error");
  const anyFail = steps.some((s) => s.status === "failed");
  const exitCode = fatal instanceof TimeoutError ? EXIT.TIMEOUT : anyError ? EXIT.SETUP : anyFail ? EXIT.FAILED : EXIT.PASSED;
  const result: RunResult = {
    runId, scenario, env: envName, approval: approvals.get(scenario.meta.id),
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    status: anyError ? "erro" : anyFail ? "reprovado" : "aprovado",
    exitCode, steps, evidenceDir: evidence.dir, massaUsed: scenario.meta.massa,
    recorded: ctx.recorded, gitCommit: await gitCommit(project.root),
  };
  if (!opts.flags.dryRun) await writeReports(project, result, massa, evidence);
  const passed = steps.filter((s) => s.status === "passed" || s.status === "warning").length;
  opts.emit({
    type: "run_end", status: result.status, summary: `${passed} de ${steps.length} passos ok`,
    evidenceDir: relative(process.cwd(), evidence.dir) || evidence.dir,
    durationMs: Date.parse(result.finishedAt) - startedAt.getTime(), exitCode,
  });
  return result;
}

export async function runScenarios(project: Project, paths: string[], opts: { env?: string; explicitEnv?: boolean; tags?: string[]; flags: RunFlags; emit: Emit }): Promise<{ results: RunResult[]; exitCode: number }> {
  const explicit = paths.length > 0;
  const files = await findScenarioFiles(explicit ? paths : [join(project.root, project.config.scenariosDir)]);
  const approvals = await Approvals.load(project.root);
  const results: RunResult[] = [];
  for (const f of files) {
    let s: Scenario;
    try { s = await loadScenario(f); } catch (e) { if (explicit) throw e; continue; }
    if (opts.tags?.length && !opts.tags.some((t) => s.meta.tags.includes(t))) continue;
    // Sem caminhos explícitos, roda só o que já foi aprovado; rascunhos esperam a pessoa.
    if (!explicit && !opts.flags.dryRun && project.config.approval.required && approvals.status(s) !== "aprovado") continue;
    results.push(await runScenarioFile(project, f, opts));
  }
  if (!results.length) throw new SetupError(explicit ? "Nenhum cenário encontrado" : "Nenhum cenário aprovado para rodar", explicit ? `Procurei em: ${paths.join(", ")}` : `Veja com "rastro scenario list" e aprove com "rastro scenario approve <id>"`, explicit ? "not_found" : "needs_approval");
  return { results, exitCode: Math.max(...results.map((r) => r.exitCode)) };
}
