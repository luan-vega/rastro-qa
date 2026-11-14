/**
 * API programática do Rastro. É a interface principal para agentes: o servidor MCP e o
 * CLI com --json devolvem exatamente estes objetos. Nada aqui imprime no terminal.
 *
 * Regra fixa: não há função para aprovar cenário, query ou baseline. Aprovação é sempre
 * de uma pessoa, pelo CLI (rastro scenario approve / query approve / perf baseline) ou por PR.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { loadProject, envConfig, type Project } from "./core/config.js";
import { findScenarioFiles, loadScenario, type Scenario } from "./core/scenario.js";
import { Approvals, type ScenarioStatus } from "./core/approval.js";
import { loadMassa, validarMassa, resumoMassa, type MassaProblema } from "./core/massa.js";
import { reviewText } from "./core/review.js";
import { runScenarioFile, type RunResult } from "./core/runner.js";
import { SetupError, TimeoutError, EXIT, type ErrorCode } from "./core/errors.js";
import type { Emit, RunEvent } from "./core/events.js";
import type { StepStatus } from "./core/types.js";
import { QueryLock } from "./ai/lock.js";
import { verifyEvidence } from "./evidence/recorder.js";
import { parseBru } from "./jmeter/bru.js";
import { generateJmx } from "./jmeter/generate.js";
import { doctorReport, type DoctorReport } from "./doctor.js";

export const API_VERSION = 1;

/** O que o agente deve fazer a seguir, sem interpretar texto livre. */
export type NextAction =
  | { kind: "ask_human"; reason: string; command: string }
  | { kind: "fix"; reason: string; hint?: string }
  | { kind: "read_evidence"; pdf: string }
  | { kind: "retry"; reason: string };

export interface ApiError { code: ErrorCode; message: string; hint?: string; exitCode: number; next: NextAction }

export function toApiError(e: unknown): ApiError {
  const err = e as Error;
  if (err instanceof TimeoutError) return { code: "timeout", message: err.message, exitCode: EXIT.TIMEOUT, next: { kind: "retry", reason: "algo externo demorou (logs ainda não indexados, API lenta)" } };
  if (err instanceof SetupError) {
    // O último comando citado na dica é a ação (ex.: "revise com X e aprove com Y" → Y).
    const cmds = [...(err.hint ?? "").matchAll(/"(rastro [^"]+)"|(?:Rode|rodar): (rastro .+)$/g)].map((m) => m[1] ?? m[2]);
    const cmd = cmds.at(-1);
    const next: NextAction = (err.code === "needs_approval" || err.code === "query_pending" || err.code === "session") && cmd
      ? { kind: "ask_human", reason: err.message, command: cmd }
      : { kind: "fix", reason: err.message, hint: err.hint };
    return { code: err.code, message: err.message, hint: err.hint, exitCode: EXIT.SETUP, next };
  }
  return { code: "setup", message: err?.message ?? String(e), exitCode: EXIT.SETUP, next: { kind: "fix", reason: err?.message ?? String(e) } };
}

const rel = (p: Project, f: string) => relative(p.root, f) || f;

// ---------- cenários ----------

export interface ScenarioInfo {
  id: string; title: string; status: ScenarioStatus; file: string;
  tags: string[]; covers: string[]; env?: string; massa: string[];
  steps: { kind: string; title: string }[];
  approvedBy?: string; approvedAt?: string;
}

/** Um arquivo inválido (ex.: rascunho quebrado) não pode impedir os outros de serem listados ou executados. */
async function scanScenarios(project: Project): Promise<{ scenarios: Scenario[]; invalid: { file: string; error: string }[] }> {
  const scenarios: Scenario[] = [];
  const invalid: { file: string; error: string }[] = [];
  for (const f of await findScenarioFiles([join(project.root, project.config.scenariosDir)])) {
    try { scenarios.push(await loadScenario(f)); } catch (e) { invalid.push({ file: rel(project, f), error: (e as Error).message }); }
  }
  return { scenarios, invalid };
}

function info(project: Project, approvals: Approvals, s: Scenario): ScenarioInfo {
  const a = approvals.get(s.meta.id);
  const status = approvals.status(s);
  return {
    id: s.meta.id, title: s.meta.title, status, file: rel(project, s.file),
    tags: s.meta.tags, covers: s.meta.covers, env: s.meta.env, massa: s.meta.massa,
    steps: s.steps.map((st) => ({ kind: st.kind, title: st.title })),
    ...(status === "aprovado" && a ? { approvedBy: a.by, approvedAt: a.at } : {}),
  };
}

export async function findScenario(dir: string, id: string): Promise<{ project: Project; scenario: Scenario }> {
  const project = await loadProject(dir);
  for (const s of (await scanScenarios(project)).scenarios) if (s.meta.id === id || s.file.endsWith(id)) return { project, scenario: s };
  throw new SetupError(`Cenário ${id} não encontrado em ${project.config.scenariosDir}`, "Liste os ids com scenario_list", "not_found");
}

export async function listScenarios(dir: string, filter: { tags?: string[]; status?: ScenarioStatus } = {}): Promise<{ scenarios: ScenarioInfo[]; invalid: { file: string; error: string }[] }> {
  const project = await loadProject(dir);
  const approvals = await Approvals.load(project.root);
  const scan = await scanScenarios(project);
  const scenarios = scan.scenarios.map((s) => info(project, approvals, s))
    .filter((s) => (!filter.tags?.length || filter.tags.some((t) => s.tags.includes(t))) && (!filter.status || s.status === filter.status));
  return { scenarios, invalid: scan.invalid };
}

export interface ScenarioReview { scenario: ScenarioInfo; text: string; massa: { registro: string; nome: string; documento: string }[]; approveCommand: string }

export async function reviewScenario(dir: string, id: string): Promise<ScenarioReview> {
  const { project, scenario } = await findScenario(dir, id);
  const approvals = await Approvals.load(project.root);
  const massa = await loadMassa(project.root, project.config.massa.file);
  let resumo: ScenarioReview["massa"] = [];
  try { resumo = resumoMassa(massa, scenario.meta.massa); } catch { /* massa incompleta aparece no texto */ }
  return {
    scenario: info(project, approvals, scenario),
    text: reviewText(scenario, approvals.status(scenario), massa, project),
    massa: resumo,
    approveCommand: `rastro scenario approve ${scenario.meta.id}`,
  };
}

export interface DraftResult { file: string; valid: boolean; error?: string; scenario?: ScenarioInfo; approveCommand: string }

/** Grava um rascunho. Ele nunca roda até uma pessoa aprovar. */
export async function draftScenario(dir: string, id: string, markdown: string, opts: { overwrite?: boolean } = {}): Promise<DraftResult> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new SetupError(`id inválido: ${id}`, "Use letras, números, _ e -", "invalid_scenario");
  const project = await loadProject(dir);
  const folder = join(project.root, project.config.scenariosDir, "rascunhos");
  const file = join(folder, `${id}.scenario.md`);
  if (existsSync(file) && !opts.overwrite) throw new SetupError(`Já existe ${rel(project, file)}`, "Escolha outro id ou passe overwrite: true", "invalid_scenario");
  await mkdir(folder, { recursive: true });
  await writeFile(file, markdown);
  const approveCommand = `rastro scenario approve ${id}`;
  try {
    const s = await loadScenario(file);
    const approvals = await Approvals.load(project.root);
    return { file: rel(project, file), valid: true, scenario: info(project, approvals, s), approveCommand: `rastro scenario approve ${s.meta.id}` };
  } catch (e) {
    return { file: rel(project, file), valid: false, error: (e as Error).message, approveCommand };
  }
}

// ---------- execução ----------

export interface RunSummary {
  ok: boolean;
  runId?: string;
  scenario: string;
  env?: string;
  status: "aprovado" | "reprovado" | "erro" | "nao_executado";
  exitCode: number;
  steps: { index: number; kind: string; title: string; status: StepStatus; summary: string; error?: string; failedChecks?: { path: string; expected: string; actual: unknown }[] }[];
  perf?: { metric: string; where: string; baseline?: number; candidate: number; deltaPct?: number; rule?: string; ok: boolean }[];
  evidenceDir?: string;
  pdf?: string;
  pendingQueries: { key: string; dialect: string; query: string }[];
  error?: ApiError;
  next?: NextAction;
}

export async function runScenario(dir: string, id: string, opts: { env?: string; dryRun?: boolean; viaMcp?: boolean; onEvent?: Emit } = {}): Promise<RunSummary> {
  const events: RunEvent[] = [];
  const emit: Emit = (e) => { events.push(e); opts.onEvent?.(e); };
  const pending = () => events.filter((e): e is Extract<RunEvent, { type: "query_pending" }> => e.type === "query_pending").map(({ key, dialect, query }) => ({ key, dialect, query }));
  let found: Awaited<ReturnType<typeof findScenario>> | undefined;
  try {
    found = await findScenario(dir, id);
    const r = await runScenarioFile(found.project, found.scenario.file, {
      env: opts.env, explicitEnv: !!opts.env,
      flags: { headless: true, dryRun: !!opts.dryRun, refreshQueries: false, interactive: false, viaMcp: !!opts.viaMcp },
      emit,
    });
    return summarize(found.project, r, pending(), !!opts.dryRun);
  } catch (e) {
    const error = toApiError(e);
    return { ok: false, scenario: found?.scenario.meta.id ?? id, status: "nao_executado", exitCode: error.exitCode, steps: [], pendingQueries: pending(), error, next: error.next };
  }
}

function summarize(project: Project, r: RunResult, pendingQueries: RunSummary["pendingQueries"], dryRun: boolean): RunSummary {
  const pdf = join(r.evidenceDir, "evidencia.pdf");
  const perf = r.steps.flatMap((s) => s.evidence.perf?.rows ?? []);
  const stepErr = r.steps.find((s) => s.status === "error");
  const ok = r.exitCode === EXIT.PASSED;
  let next: NextAction | undefined;
  if (pendingQueries.length) next = { kind: "ask_human", reason: "há queries novas da IA aguardando aprovação", command: `rastro query approve ${pendingQueries[0].key}` };
  else if (stepErr?.error) next = toApiError(new SetupError(stepErr.error, stepErr.error.match(/(Rode: rastro .+)$/)?.[1], /auth capture/.test(stepErr.error) ? "session" : "setup")).next;
  else if (!dryRun && existsSync(pdf)) next = { kind: "read_evidence", pdf: rel(project, pdf) };
  return {
    ok, runId: r.runId, scenario: r.scenario.meta.id, env: r.env, status: r.status, exitCode: r.exitCode,
    steps: r.steps.map((s, i) => ({
      index: i + 1, kind: s.kind, title: s.title, status: s.status, summary: s.summary,
      ...(s.error ? { error: s.error } : {}),
      ...(s.checks.some((c) => !c.ok) ? { failedChecks: s.checks.filter((c) => !c.ok).map((c) => ({ path: c.path, expected: c.expected, actual: c.actual })) } : {}),
    })),
    ...(perf.length ? { perf } : {}),
    ...(dryRun ? {} : { evidenceDir: rel(project, r.evidenceDir), pdf: existsSync(pdf) ? rel(project, pdf) : undefined }),
    pendingQueries, ...(next ? { next } : {}),
  };
}

// ---------- queries da IA ----------

export interface QueryInfo { key: string; approved: boolean; approvedBy?: string; scenario: string; step: string; dialect: string; mode: string; intent: string; rationale: string; query: string; expectedFields: string[]; approveCommand?: string }

export async function listQueries(dir: string, filter: { pending?: boolean; scenario?: string } = {}): Promise<{ queries: QueryInfo[] }> {
  const project = await loadProject(dir);
  const lock = await QueryLock.load(project.root, project.config.ai.lock);
  const queries = lock.entries().map(([key, e]) => ({
    key, approved: !!e.approved, approvedBy: e.approved?.by, scenario: e.scenario, step: e.step, dialect: e.dialect, mode: e.mode,
    intent: e.intent, rationale: e.rationale, query: e.query, expectedFields: e.expectedFields,
    ...(e.approved ? {} : { approveCommand: `rastro query approve ${key}` }),
  })).filter((q) => (filter.pending === undefined || q.approved !== filter.pending) && (!filter.scenario || q.scenario === filter.scenario));
  return { queries };
}

// ---------- massa, ambiente, sessões ----------

export async function checkMassa(dir: string): Promise<{ ok: boolean; file: string; registros: string[]; problemas: MassaProblema[] }> {
  const project = await loadProject(dir);
  const massa = await loadMassa(project.root, project.config.massa.file);
  const problemas = validarMassa(massa);
  return { ok: Object.keys(massa).length > 0 && problemas.length === 0, file: project.config.massa.file, registros: Object.keys(massa), problemas };
}

export async function doctor(dir: string, env?: string): Promise<DoctorReport> {
  return doctorReport(dir, env);
}

export interface SessionStatus { name: string; mode: string; status: "ok" | "ausente" | "expirada" | "externa"; ageHours?: number; maxAgeHours: number; captureCommand?: string }

export async function authStatus(dir: string, env?: string): Promise<{ env: string; sessions: SessionStatus[] }> {
  const project = await loadProject(dir);
  const envName = env ?? project.config.defaultEnv;
  const cfg = envConfig(project, envName, { explicit: !!env });
  const sessions = Object.entries(cfg.sessions).map(([name, s]): SessionStatus => {
    const captureCommand = `rastro auth capture ${name} --env ${envName}`;
    if (s.mode !== "storageState") return { name, mode: s.mode, status: "externa", maxAgeHours: s.maxAgeHours };
    const f = join(project.root, s.file ?? `.rastro/auth/${name}.json`);
    if (!existsSync(f)) return { name, mode: s.mode, status: "ausente", maxAgeHours: s.maxAgeHours, captureCommand };
    const ageHours = +((Date.now() - statSync(f).mtimeMs) / 3_600_000).toFixed(2);
    return ageHours <= s.maxAgeHours
      ? { name, mode: s.mode, status: "ok", ageHours, maxAgeHours: s.maxAgeHours }
      : { name, mode: s.mode, status: "expirada", ageHours, maxAgeHours: s.maxAgeHours, captureCommand };
  });
  return { env: envName, sessions };
}

// ---------- JMeter ----------

export async function jmeterGenerate(dir: string, opts: { fromBru: string; out?: string; csvColumns?: string[]; expectedStatus?: string; overwrite?: boolean }): Promise<{ file: string; method: string; url: string; properties: string[] }> {
  const project = await loadProject(dir).catch(() => undefined);
  const root = project?.root ?? resolve(dir);
  const src = resolve(root, opts.fromBru);
  if (!src.startsWith(root)) throw new SetupError("fromBru precisa estar dentro do projeto", undefined, "invalid_scenario");
  if (!existsSync(src)) throw new SetupError(`Arquivo ${opts.fromBru} não encontrado`, undefined, "not_found");
  const req = parseBru(await readFile(src, "utf8"));
  const out = resolve(root, opts.out ?? join("perf", "jmeter", basename(src).replace(/\.bru$/, ".jmx").replace(/\s+/g, "-").toLowerCase()));
  if (!out.startsWith(root)) throw new SetupError("out precisa estar dentro do projeto", undefined, "invalid_scenario");
  if (existsSync(out) && !opts.overwrite) throw new SetupError(`${relative(root, out)} já existe`, "Passe overwrite: true para substituir", "invalid_scenario");
  const xml = generateJmx(req, { csvColumns: opts.csvColumns ?? ["cpf", "nome"], expectedStatus: opts.expectedStatus ?? "2\\d\\d" });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, xml);
  const properties = [...new Set([...xml.matchAll(/__P\((\w+)/g)].map((m) => m[1]))];
  return { file: relative(root, out), method: req.method.toUpperCase(), url: req.url, properties };
}

// ---------- evidências ----------

export async function getEvidence(dir: string, runId: string, opts: { includeReport?: boolean } = {}): Promise<{ runId: string; dir: string; pdf?: string; verified: boolean; problems: string[]; result: unknown; report?: string }> {
  if (!/^[\w-]+$/.test(runId)) throw new SetupError(`runId inválido: ${runId}`, undefined, "not_found");
  const project = await loadProject(dir);
  const evDir = join(project.root, project.config.evidence.dir, runId);
  const resFile = join(evDir, "resultado.json");
  if (!existsSync(resFile)) throw new SetupError(`Execução ${runId} não encontrada`, undefined, "not_found");
  const v = await verifyEvidence(evDir);
  const pdf = join(evDir, "evidencia.pdf");
  return {
    runId, dir: rel(project, evDir), pdf: existsSync(pdf) ? rel(project, pdf) : undefined,
    verified: v.ok, problems: v.problems,
    result: JSON.parse(await readFile(resFile, "utf8")),
    ...(opts.includeReport ? { report: await readFile(join(evDir, "report.md"), "utf8") } : {}),
  };
}

export async function verify(dir: string): Promise<{ ok: boolean; problems: string[] }> {
  return verifyEvidence(resolve(dir));
}
