import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { loadProject, envConfig } from "./core/config.js";
import { loadMassa, validarMassa } from "./core/massa.js";
import { run } from "./plugins/api-bruno.js";
import { launchOptions } from "./plugins/ui-playwright.js";

type Line = [ok: boolean | "aviso", label: string, detail: string];

export interface DoctorCheck { name: string; status: "ok" | "aviso" | "falha"; detail: string }
export interface DoctorReport { ok: boolean; env: string; checks: DoctorCheck[] }

async function cmd(bin: string, args: string[], cwd: string): Promise<string | undefined> {
  try {
    const r = await run(bin, args, cwd);
    return r.code === 0 ? (r.stdout || r.stderr).trim().split("\n").find((l) => /\d+\.\d+/.test(l)) ?? "ok" : undefined;
  } catch { return undefined; }
}

export async function doctorReport(dir: string, envArg?: string): Promise<DoctorReport> {
  const lines: Line[] = [];
  const project = await loadProject(dir);
  lines.push([true, "rastro.config.yaml", project.root]);
  const envName = envArg ?? project.config.defaultEnv;
  const env = envConfig(project, envName, { explicit: !!envArg });

  const massa = await loadMassa(project.root, project.config.massa.file);
  const problemas = validarMassa(massa);
  lines.push([Object.keys(massa).length ? problemas.length === 0 : "aviso", "massa", Object.keys(massa).length ? (problemas.length ? problemas.map((p) => p.caminho).join(", ") + " inválido(s)" : `${Object.keys(massa).length} registro(s) válidos`) : `${project.config.massa.file} vazio ou ausente`]);

  const bru = await cmd(process.env.RASTRO_BRU_BIN ?? "bru", ["--version"], project.root);
  lines.push([bru ? true : "aviso", "Bruno CLI", bru ?? "não encontrado (npm i -g @usebruno/cli)"]);
  const jm = project.config.perf.jmeter.home ? join(project.config.perf.jmeter.home, "bin", "jmeter") : "jmeter";
  const jmv = await cmd(process.env.RASTRO_JMETER_BIN ?? jm, ["--version"], project.root);
  lines.push([jmv ? true : "aviso", "JMeter", jmv ? "encontrado" : "não encontrado (configure perf.jmeter.home)"]);

  try {
    const b = await chromium.launch(launchOptions(true));
    await b.close();
    lines.push([true, "Chromium (Playwright)", "ok"]);
  } catch (e) {
    lines.push([false, "Chromium (Playwright)", `${(e as Error).message.split("\n")[0]} (rode: npx playwright install chromium)`]);
  }

  for (const [name, s] of Object.entries(env.sessions)) {
    if (s.mode !== "storageState") { lines.push([true, `sessão ${name}`, `modo ${s.mode}`]); continue; }
    const f = join(project.root, s.file ?? `.rastro/auth/${name}.json`);
    if (!existsSync(f)) { lines.push(["aviso", `sessão ${name}`, `não capturada (rastro auth capture ${name})`]); continue; }
    const h = (Date.now() - statSync(f).mtimeMs) / 3_600_000;
    lines.push([h <= s.maxAgeHours ? true : "aviso", `sessão ${name}`, `capturada há ${h.toFixed(1)} h (máx. ${s.maxAgeHours} h)`]);
  }

  if (env.logs.cloudwatch) lines.push([true, "CloudWatch", `${env.logs.cloudwatch.region} · ${env.logs.cloudwatch.logGroups.length} log group(s)${env.logs.cloudwatch.profile ? ` · perfil ${env.logs.cloudwatch.profile}` : ""}`]);
  if (env.datadog) {
    try {
      const key = env.datadog.apiKey.replace(/^\{\{\s*secret:(\w+)\s*\}\}$/, (_, n) => process.env[n] ?? "");
      const base = env.datadog.apiBase ?? `https://api.${env.datadog.site}`;
      const r = await fetch(`${base}/api/v1/validate`, { headers: { "DD-API-KEY": key } });
      lines.push([r.ok, "Datadog", r.ok ? "chave válida" : `HTTP ${r.status}`]);
    } catch (e) { lines.push([false, "Datadog", (e as Error).message]); }
  }
  const ai = project.config.ai;
  lines.push([ai.provider === "none" || process.env.ANTHROPIC_API_KEY ? true : "aviso", "IA", ai.provider === "none" ? "desligada" : process.env.ANTHROPIC_API_KEY ? `${ai.model}` : "ANTHROPIC_API_KEY não definida (queries só do cenário ou do lock)"]);

  return {
    ok: lines.every(([ok]) => ok !== false), env: envName,
    checks: lines.map(([ok, name, detail]) => ({ name, detail, status: ok === true ? "ok" : ok === "aviso" ? "aviso" : "falha" })),
  };
}

export function formatDoctor(r: DoctorReport): string {
  return r.checks.map((c) => `${c.status === "ok" ? "✓" : c.status === "aviso" ? "~" : "✗"} ${c.name.padEnd(24)} ${c.detail}`).join("\n");
}
