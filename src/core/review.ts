import type { Scenario, Step } from "./scenario.js";
import type { ScenarioStatus } from "./approval.js";
import type { Massa } from "./massa.js";
import type { Project } from "./config.js";
import { interpolatePartial } from "./interpolate.js";
import { mascararDocumentosNoTexto } from "./documentos.js";

function show(v: unknown, scenario: Scenario, massa: Massa): string {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return mascararDocumentosNoTexto(interpolatePartial(text, { vars: scenario.meta.vars, massa }));
}

function describeStep(step: Step, scenario: Scenario, massa: Massa, project: Project): string[] {
  const s = step.spec;
  const v = (x: unknown) => show(x, scenario, massa);
  switch (step.kind) {
    case "ui": {
      if (s.ensure) return [`Confere se o login salvo "${s.session}" ainda vale.`];
      const lines = [`Abre ${s.goto ?? "a tela"} usando o login já salvo "${s.session}".`];
      for (const a of s.do ?? []) {
        const [verb, arg] = Object.entries(a)[0] as [string, any];
        if (verb === "fill") lines.push(`  Preenche ${arg.selector} com ${v(arg.value)}.`);
        else if (verb === "click") lines.push(`  Clica em ${arg}.`);
        else lines.push(`  ${verb} ${v(arg)}`);
      }
      return lines;
    }
    case "api":
      if (s.tool === "bruno") return [`Chama a requisição "${s.request}" da coleção Bruno ${s.collection}${s.vars ? ` com ${Object.entries(s.vars).map(([k, x]) => `${k} ${v(x)}`).join(", ")}` : ""}.`];
      return [`Chama ${String(s.method ?? "GET").toUpperCase()} ${v(s.url)}${s.body ? ` com ${v(s.body)}` : ""}.`];
    case "logs":
      return [`Procura no ${s.source ?? "cloudwatch"} os registros desta execução${s.ai ? `: "${String(s.ai).trim()}"` : ""}.${s.query ? ` Query: ${v(s.query)}` : " A query é gerada pela IA e precisa ser aprovada na primeira vez."}`];
    case "perf": {
      const d = project.config.perf.jmeter.defaults;
      const l = s.load ?? {};
      const t = l.threads ?? d.threads, dur = l.durationSec ?? d.durationSec;
      return [
        l.tool === "jmeter" ? `Roda carga no JMeter: ${t} usuários por ${Math.round(dur / 60)} minuto(s) (${l.plan}).` : `Lê os tempos de ${l.jtl}.`,
        `  Mede p50, p90 e p95${s.server ? " no cliente e no servidor" : ""} e compara com a última medição salva.`,
      ];
    }
    case "datadog":
      return [`Coleta no Datadog a saúde do serviço ${s.service ?? s.apm?.service}: monitores, SLO, taxa de erro e volume${s.logs ? ", e os logs desta execução" : ""}.`];
  }
}

function describeExpect(step: Step, scenario: Scenario, massa: Massa): string[] {
  const s = step.spec;
  const v = (x: unknown) => show(x, scenario, massa);
  const out: string[] = [];
  if (step.kind === "ui") for (const e of s.expect ?? []) {
    if (e.response) out.push(`a tela recebe ${e.response.status ?? "resposta"} de ${e.response.url}`);
    if (e.visible) out.push(`aparece ${e.visible}`);
  }
  if (step.kind === "api") for (const [k, x] of Object.entries(s.expect ?? {})) out.push(`${k} ${v(x)}`);
  if (step.kind === "logs") {
    const e = s.expect ?? {};
    out.push(`pelo menos ${e.minRows ?? 1} registro(s)${e.fields ? ` com ${Object.entries(e.fields).map(([k, x]) => `${k} = ${v(x)}`).join(", ")}` : ""}`);
  }
  if (step.kind === "perf") for (const [k, x] of Object.entries(s.budget ?? {})) out.push(`${k} ${x}`);
  if (step.kind === "datadog") out.push("monitores do serviço em OK" + (s.expect?.errorRate ? ` e taxa de erro ${s.expect.errorRate}` : ""));
  return out;
}

export function reviewText(scenario: Scenario, status: ScenarioStatus, massa: Massa, project: Project): string {
  const m = scenario.meta;
  const lines = [
    `${m.id} · ${m.title}`.padEnd(60) + `status: ${status.toUpperCase()}`,
    `Ambiente: ${m.env ?? project.config.defaultEnv}`,
    "",
  ];
  if (m.change.summary) lines.push("O que mudou", `  ${m.change.summary.trim().replace(/\s+/g, " ")}`, "");
  lines.push("O que este teste faz");
  scenario.steps.forEach((st, i) => {
    const d = describeStep(st, scenario, massa, project);
    lines.push(`  ${i + 1}. ${d[0]}`, ...d.slice(1).map((x) => `     ${x.trim()}`));
  });
  const crit = scenario.steps.flatMap((st) => describeExpect(st, scenario, massa));
  if (crit.length) lines.push("", "Passa se", ...crit.map((c) => `  - ${c}`));
  if (m.massa.length) lines.push("", `Massa usada: ${m.massa.join(", ")} (dados fictícios de ${project.config.massa.file})`);
  lines.push("", status === "aprovado" ? "Já aprovado neste estado." : `Aprovar:  rastro scenario approve ${m.id}`);
  return lines.join("\n");
}
