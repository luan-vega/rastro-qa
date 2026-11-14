import type { Project } from "../core/config.js";
import type { RunResult } from "../core/runner.js";
import type { Massa } from "../core/massa.js";
import type { Evidence } from "./recorder.js";
import { buildPdfHtml, renderPdf, plainSummary } from "./pdf.js";

const xml = (s: unknown) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));

export function reportMarkdown(r: RunResult): string {
  const m = r.scenario.meta;
  const lines = [
    `## ${m.id} · ${m.title} · ${r.status.toUpperCase()}`,
    `Ambiente ${r.env} · runId ${r.runId}${r.gitCommit ? ` · commit ${r.gitCommit}` : ""}`,
    "",
    ...plainSummary(r),
    "",
    "| Passo | Resultado | Detalhe |",
    "|---|---|---|",
    ...r.steps.map((s) => `| ${s.title} | ${s.status} | ${(s.error ?? s.summary).replace(/\|/g, "/")} |`),
  ];
  if (r.recorded.length) {
    const cols = Object.keys(r.recorded[0]);
    lines.push("", "### Variáveis trafegadas", `| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`,
      ...r.recorded.slice(0, 50).map((row) => `| ${cols.map((c) => String(row[c] ?? "")).join(" | ")} |`));
  }
  return lines.join("\n") + "\n";
}

export function junitXml(r: RunResult): string {
  const failures = r.steps.filter((s) => s.status === "failed").length;
  const errors = r.steps.filter((s) => s.status === "error").length;
  const time = (ms: number) => (ms / 1000).toFixed(3);
  const cases = r.steps.map((s) => {
    const inner = s.status === "failed"
      ? `<failure message="${xml(s.summary)}">${xml(s.checks.filter((c) => !c.ok).map((c) => `${c.path}: esperado ${c.expected}, veio ${JSON.stringify(c.actual)}`).join("\n"))}</failure>`
      : s.status === "error" ? `<error message="${xml(s.error)}"/>` : s.status === "skipped" ? "<skipped/>" : "";
    return `    <testcase classname="${xml(r.scenario.meta.id)}" name="${xml(`${s.kind}: ${s.title}`)}" time="${time(s.durationMs)}">${inner}</testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="${xml(`${r.scenario.meta.id} ${r.scenario.meta.title}`)}" tests="${r.steps.length}" failures="${failures}" errors="${errors}" timestamp="${r.startedAt}">\n${cases.join("\n")}\n  </testsuite>\n</testsuites>\n`;
}

export async function writeReports(project: Project, r: RunResult, massa: Massa, ev: Evidence): Promise<void> {
  const formats = project.config.evidence.formats;
  await ev.writeJson("resultado.json", ev.mask({ ...r, scenario: { meta: r.scenario.meta, hash: r.scenario.hash, file: r.scenario.file } }));
  if (formats.includes("md")) await ev.write("report.md", reportMarkdown(r));
  if (formats.includes("junit")) await ev.write("junit.xml", junitXml(r));
  if (formats.includes("pdf")) {
    const html = await buildPdfHtml(r, massa, ev);
    await ev.write("evidencia.html", html);
    await renderPdf(html, ev.path("evidencia.pdf"), `${r.scenario.meta.id} · ${r.runId}`);
  }
  const files = await ev.files();
  await ev.writeJson("manifest.json", {
    runId: r.runId, scenario: r.scenario.meta.id, scenarioHash: r.scenario.hash, env: r.env,
    status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, gitCommit: r.gitCommit,
    files,
  });
}
