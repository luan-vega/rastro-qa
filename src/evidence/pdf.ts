import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import type { RunResult } from "../core/runner.js";
import type { StepResult, PerfRow } from "../core/types.js";
import { resumoMassa, type Massa } from "../core/massa.js";
import { barsBeforeAfter } from "./charts.js";
import { launchOptions } from "../plugins/ui-playwright.js";
import type { Evidence } from "./recorder.js";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const ms = (v?: number) => (v === undefined || Number.isNaN(v) ? "-" : `${Math.round(v)} ms`);
const pct = (v?: number) => (v === undefined ? "-" : `${v >= 0 ? "+" : ""}${String(v).replace(".", ",")}%`);
const dt = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

const STATUS_PILL: Record<string, string> = { passed: "OK", failed: "FALHOU", error: "ERRO", warning: "ATENÇÃO", skipped: "NÃO EXECUTADO" };
const pill = (s: string) => `<span class="pill ${s}">${STATUS_PILL[s] ?? s}</span>`;

async function img(ev: Evidence, rel: string): Promise<string> {
  const p = ev.path(rel);
  if (!existsSync(p)) return "";
  return `data:image/png;base64,${(await readFile(p)).toString("base64")}`;
}

/** Resumo em linguagem simples, montado só a partir dos resultados (sem IA, sem números inventados). */
export function plainSummary(r: RunResult): string[] {
  const out: string[] = [];
  const m = r.scenario.meta;
  const change = m.change.summary?.trim();
  out.push(`${change ? `A alteração testada: ${change.replace(/\s+/g, " ")}` : `Cenário testado: ${m.title}.`} O teste rodou em ${r.env === "hml" ? "homologação" : r.env}.`);
  const ui = r.steps.filter((s) => s.kind === "ui" && s.status !== "skipped");
  const api = r.steps.filter((s) => s.kind === "api");
  const logs = r.steps.filter((s) => s.kind === "logs");
  const perf = r.steps.find((s) => s.kind === "perf");
  const dd = r.steps.find((s) => s.kind === "datadog");
  const did: string[] = [];
  if (ui.length) did.push("pela tela");
  if (api.length) did.push("chamando a API diretamente");
  if (did.length) out.push(`Exercitamos a alteração ${did.join(" e ")}${r.massaUsed.length ? ", com dados de teste fictícios" : ""}.`);
  if (logs.length) {
    const ok = logs.every((s) => s.status === "passed");
    const n = logs.reduce((a, s) => a + (s.evidence.logs?.rows.length ?? 0), 0);
    out.push(ok ? `Os registros nos logs confirmam que os dados chegaram ao backend (${n} registro(s) encontrados para esta execução).` : `Os logs não confirmaram a alteração como esperado; veja a seção de logs.`);
  }
  if (dd?.evidence.health) {
    const h = dd.evidence.health;
    const okMon = h.monitors.filter((x) => x.state === "OK").length;
    out.push(`No Datadog, ${okMon} de ${h.monitors.length} monitores do serviço ${h.service} ficaram em OK${h.errorRatePct !== undefined ? `, com taxa de erro de ${String(h.errorRatePct).replace(".", ",")}%` : ""}.`);
  }
  if (perf?.evidence.perf) {
    const p95 = perf.evidence.perf.rows.find((x) => x.metric === "p95");
    if (p95?.baseline !== undefined) {
      out.push(`Na carga, o p95 foi de ${ms(p95.baseline)} antes para ${ms(p95.candidate)} agora (${pct(p95.deltaPct)})${p95.rule ? `, ${p95.ok ? "dentro" : "fora"} do limite de ${p95.rule}` : ""}.`);
    } else if (p95) {
      out.push(`Na carga, o p95 foi de ${ms(p95.candidate)}. Ainda não há medição anterior salva para comparar.`);
    }
  }
  return out;
}

function perfTable(rows: PerfRow[]): string {
  const name: Record<string, string> = { p50: "p50", p90: "p90", p95: "p95", errorRate: "Taxa de erro" };
  return `<table><thead><tr><th>Medida</th><th>Onde</th><th class="num">Antes</th><th class="num">Agora</th><th class="num">Variação</th><th class="num">Limite</th><th>Resultado</th></tr></thead><tbody>${rows.map((r) => {
    const f = (v?: number) => (r.metric === "errorRate" ? (v === undefined ? "-" : `${String(v).replace(".", ",")}%`) : ms(v));
    return `<tr><td>${name[r.metric]}</td><td>${esc(r.where)}</td><td class="num">${f(r.baseline)}</td><td class="num">${f(r.candidate)}</td><td class="num">${pct(r.deltaPct)}</td><td class="num">${esc(r.rule ?? "-")}</td><td>${pill(r.ok ? "passed" : "failed")}</td></tr>`;
  }).join("")}</tbody></table>`;
}

export async function buildPdfHtml(r: RunResult, massa: Massa, ev: Evidence): Promise<string> {
  const m = r.scenario.meta;
  const okSteps = r.steps.filter((s) => s.status === "passed" || s.status === "warning").length;
  const badge = r.status === "aprovado" ? "APROVADO" : r.status === "reprovado" ? "REPROVADO" : "COM ERRO";
  let n = 0;
  const h2 = (t: string) => `<h2><span class="n">${++n}</span>${esc(t)}</h2>`;
  const parts: string[] = [];

  parts.push(`<div class="top"><div><div class="k">Evidência de teste · ${esc(r.env === "hml" ? "Homologação" : r.env)}</div><h1>${esc(m.title || m.id)}</h1>
    <div class="cap">Cenário ${esc(m.id)}${m.covers.length ? ` · ${esc(m.covers.join(", "))}` : ""}</div></div>
    <div class="badge ${r.status}">${badge}<small>${okSteps} de ${r.steps.length} passos ok</small></div></div>
  <div class="meta">
    <div><span>Data da execução</span>${dt(r.startedAt)} a ${new Date(r.finishedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</div>
    <div><span>Ambiente</span>${esc(r.env)}</div>
    <div><span>Versão do repositório</span>${esc(r.gitCommit ?? "-")}</div>
    <div><span>Cenário aprovado por</span>${r.approval ? `${esc(r.approval.by)} em ${dt(r.approval.at)}` : "não aprovado"}</div>
    <div><span>Identificador</span><code>${esc(r.runId)}</code></div>
  </div>`);

  parts.push(h2("Resumo"), `<div class="resumo">${plainSummary(r).map((p) => `<p>${esc(p)}</p>`).join("")}</div>`);

  parts.push(h2("O que foi verificado"), `<table><thead><tr><th>Passo</th><th>O que aconteceu</th><th>Resultado</th></tr></thead><tbody>${r.steps.map((s) =>
    `<tr><td>${esc(s.title)}</td><td>${esc(s.summary)}${s.error ? `<div class="err">${esc(s.error)}</div>` : ""}${s.checks.filter((c) => !c.ok).map((c) => `<div class="err">Esperado ${esc(c.path)} ${esc(c.expected)}, veio ${esc(JSON.stringify(c.actual))}</div>`).join("")}</td><td>${pill(s.status)}</td></tr>`).join("")}</tbody></table>`);

  if (r.massaUsed.length) {
    const linhas = resumoMassa(massa, r.massaUsed);
    parts.push(h2("Dados de teste usados"), `<p class="explica">Dados fictícios informados pelo usuário no arquivo de massa. Os documentos aparecem mascarados.</p>
      <table><thead><tr><th>Registro</th><th>Nome</th><th>Documento</th></tr></thead><tbody>${linhas.map((l) => `<tr><td>${esc(l.registro)}</td><td>${esc(l.nome)}</td><td><code>${esc(l.documento)}</code></td></tr>`).join("")}</tbody></table>`);
  }

  const shots = r.steps.flatMap((s) => s.evidence.screenshots ?? []);
  const calls = r.steps.flatMap((s) => s.evidence.calls ?? []);
  if (shots.length || calls.length) {
    parts.push(`<div class="brk"></div>`, h2("Passo a passo na tela e na API"));
    if (shots.length) {
      const imgs = await Promise.all(shots.map(async (s, i) => `<figure><img src="${await img(ev, s.file)}"><figcaption>Print ${i + 1} · ${esc(s.caption)}</figcaption></figure>`));
      parts.push(`<div class="shots">${imgs.join("")}</div>`);
    }
    if (calls.length) {
      parts.push(`<table><thead><tr><th>Chamada</th><th>Enviado</th><th>Recebido</th><th class="num">Tempo</th><th>Resultado</th></tr></thead><tbody>${calls.map((c) =>
        `<tr><td>${esc(c.name)}</td><td>${esc(c.sent)}</td><td>${esc(c.received)}</td><td class="num">${ms(c.durationMs)}</td><td>${pill(c.ok ? "passed" : "failed")}</td></tr>`).join("")}</tbody></table>`);
    }
  }

  for (const s of r.steps.filter((x) => x.evidence.logs)) {
    const l = s.evidence.logs!;
    const nome = l.source === "cloudwatch" ? "CloudWatch" : l.source === "splunk" ? "Splunk" : "logs";
    parts.push(h2(`Prova no ${nome}: ${s.title}`), `<p class="explica">Buscamos os registros desta execução pelo identificador enviado em cada chamada. ${l.rows.length ? `Foram encontrados ${l.rows.length} registro(s); a tabela mostra as variáveis que trafegaram no payload.` : "Nenhum registro foi encontrado."}</p>
      <div class="shot"><div class="bar">${esc(l.where)}</div><div class="body">
        <pre class="q">${esc(l.query)}</pre>
        <div class="info"><span>Período: ${esc(l.period)}</span><span>Registros: ${l.rows.length}</span></div>
        ${l.rows.length ? `<table class="logs"><thead><tr>${l.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${l.rows.slice(0, 25).map((row) => `<tr>${l.columns.map((c) => `<td>${esc(typeof row[c] === "object" ? JSON.stringify(row[c]) : row[c])}</td>`).join("")}</tr>`).join("")}</tbody></table>` : ""}
      </div></div>
      <p class="cap">Print montado pelo Rastro a partir do resultado da consulta. Query ${esc(l.queryOrigin)}.</p>`);
  }

  for (const s of r.steps.filter((x) => x.evidence.health)) {
    const h = s.evidence.health!;
    const okMon = h.monitors.filter((x) => x.state === "OK").length;
    const tiles = [
      ["Monitores", `${okMon} de ${h.monitors.length}`, okMon === h.monitors.length ? "todos em OK" : "há monitores fora de OK"],
      ...h.slos.slice(0, 1).map((x) => ["SLO", x.value !== undefined ? `${String(x.value).replace(".", ",")}%` : "-", x.target ? `meta ${x.target}%` : x.name]),
      ["Taxa de erro", h.errorRatePct !== undefined ? `${String(h.errorRatePct).replace(".", ",")}%` : "-", "no período do teste"],
      ["Requisições", h.requestsPerSec !== undefined ? `${String(h.requestsPerSec).replace(".", ",")}/s` : "-", h.requests ? `${h.requests} no período` : ""],
    ];
    const images = await Promise.all(h.images.map(async (x) => `<figure><img src="${await img(ev, x.file)}"><figcaption>${esc(x.caption)}</figcaption></figure>`));
    parts.push(`<div class="brk"></div>`, h2(`Saúde do serviço no Datadog: ${h.service}`),
      `<div class="tiles">${tiles.map(([a, b, c]) => `<div class="tile"><span>${esc(a)}</span><b>${esc(b)}</b><small>${esc(c)}</small></div>`).join("")}</div>`,
      h.monitors.length ? `<table><thead><tr><th>Monitor</th><th>Estado no período</th></tr></thead><tbody>${h.monitors.map((x) => `<tr><td>${esc(x.name)}</td><td>${pill(x.state === "OK" ? "passed" : "failed")} ${esc(x.state)}</td></tr>`).join("")}</tbody></table>` : "",
      images.length ? `<div class="shots">${images.join("")}</div>` : "",
      h.links.length ? `<p class="cap">${h.links.map((x) => `${esc(x.label)}: ${esc(x.url)}`).join("<br>")}</p>` : "");
  }

  for (const s of r.steps.filter((x) => x.evidence.perf)) {
    const p = s.evidence.perf!;
    const groups = (where: string) => ["p50", "p90", "p95"].map((k) => p.rows.find((x) => x.metric === k && x.where === where)).filter(Boolean).map((x) => ({ label: x!.metric, before: x!.baseline, after: x!.candidate }));
    const wheres = [...new Set(p.rows.map((x) => x.where))];
    parts.push(`<div class="brk"></div>`, h2("Performance: antes x agora"),
      `<p class="explica">${p.load ? `${esc(p.load.tool === "jmeter" ? "O JMeter" : "A carga")} gerou ${p.load.samples} chamadas${p.load.threads ? ` com ${p.load.threads} usuários simultâneos` : ""}${p.load.durationSec ? ` por ${Math.round(p.load.durationSec / 60)} min` : ""}. ` : ""}O p50 é o tempo da chamada típica; o p90 e o p95 mostram as mais lentas (9 em cada 10 e 19 em cada 20 foram mais rápidas que esse valor).${p.baselineRef ? ` Comparação com a medição ${esc(p.baselineRef)}.` : " Ainda não existe medição anterior salva; esta execução pode virar a referência."}</p>`,
      perfTable(p.rows),
      `<div class="cols">${wheres.map((w) => `<div><h3>${esc(w)}</h3>${barsBeforeAfter(groups(w))}</div>`).join("")}</div>`,
      ...(s.evidence.notes ?? []).map((x) => `<p class="cap">${esc(x)}</p>`));
  }

  if (r.recorded.length && !r.steps.some((s) => s.evidence.logs)) {
    // nada: as variáveis já aparecem na seção de logs
  }

  parts.push(h2("Anexo técnico"), `<table><tbody>
    <tr><td>correlationId</td><td><code>${esc(r.runId)}</code></td></tr>
    <tr><td>Cenário</td><td><code>${esc(r.scenario.meta.id)} · ${esc(r.scenario.hash.slice(0, 19))}…</code></td></tr>
    ${r.steps.filter((s) => s.evidence.logs).map((s) => `<tr><td>Query: ${esc(s.title)}</td><td><code>${esc(s.evidence.logs!.query)}</code></td></tr>`).join("")}
    <tr><td>Arquivos</td><td>Lista completa com sha256 em <code>manifest.json</code>, na mesma pasta deste PDF.</td></tr>
  </tbody></table>`);

  const css = await readFile(new URL("../../templates/evidencia.css", import.meta.url), "utf8");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>${css}</style></head><body>${parts.join("\n")}</body></html>`;
}

export async function renderPdf(html: string, out: string, footer: string) {
  const browser = await chromium.launch(launchOptions(true));
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path: out, format: "A4", printBackground: true,
      margin: { top: "14mm", bottom: "16mm", left: "14mm", right: "14mm" },
      displayHeaderFooter: true, headerTemplate: "<span></span>",
      footerTemplate: `<div style="font-size:7px;width:100%;text-align:center;color:#5a6573;font-family:Arial">${esc(footer)} · página <span class="pageNumber"></span> de <span class="totalPages"></span></div>`,
    });
  } finally {
    await browser.close();
  }
}
