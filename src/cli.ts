#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { loadProject, envConfig } from "./core/config.js";
import { Approvals } from "./core/approval.js";
import { EXIT, SetupError } from "./core/errors.js";
import { reporter } from "./core/events.js";
import { runScenarios } from "./core/runner.js";
import { QueryLock } from "./ai/lock.js";
import { currentUser } from "./ai/resolve.js";
import { saveBaseline } from "./plugins/perf.js";
import { captureSession } from "./plugins/ui-playwright.js";
import { initProject } from "./init.js";
import { formatDoctor } from "./doctor.js";
import * as api from "./api.js";

const program = new Command();
program.name("rastro").description("Validação de backend ponta a ponta com evidências em PDF. Feito para ser chamado por agentes (MCP ou --json).").version("0.1.0")
  .option("-C, --dir <pasta>", "pasta do projeto (onde está o rastro.config.yaml)", ".")
  .option("--json", "saída em JSON (para agentes e scripts); erros também saem em JSON no stdout");

const projectDir = () => resolve(program.opts().dir);
const json = () => !!program.opts().json;

/** Imprime o resultado: JSON para agentes, texto para pessoas. */
function out(data: unknown, human: () => string) {
  process.stdout.write(json() ? JSON.stringify({ ok: true, apiVersion: api.API_VERSION, ...(data as object) }) + "\n" : human() + "\n");
}

function fail(e: unknown): never {
  const err = api.toApiError(e);
  if (json()) process.stdout.write(JSON.stringify({ ok: false, apiVersion: api.API_VERSION, error: err }) + "\n");
  else {
    process.stderr.write(`Erro: ${err.message}\n`);
    if (err.hint) process.stderr.write(`  ${err.hint}\n`);
  }
  process.exit(err.exitCode);
}

const action = <A extends unknown[]>(fn: (...a: A) => Promise<void>) => (...a: A) => fn(...a).catch(fail);

/** Comandos de aprovação são só para pessoas: recusam rodar sem terminal, a menos que --yes seja passado por alguém. */
async function confirmHuman(what: string, yes?: boolean) {
  if (yes) return;
  if (!process.stdin.isTTY) throw new SetupError(`${what} exige uma pessoa no terminal`, "Rode este comando você mesmo (ou passe --yes se for você rodando um script)", "needs_approval");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${what}? [s/N] `);
  rl.close();
  if (!/^s(im)?$/i.test(answer.trim())) throw new SetupError("Cancelado", undefined, "needs_approval");
}

program.command("init").description("cria rastro.config.yaml, massa, cenário, coleção Bruno e plano JMeter de exemplo")
  .action(action(async () => {
    const created = await initProject(projectDir());
    out({ created }, () => created.map((f) => `criado ${f}`).join("\n") +
      "\n\nPróximos passos: preencha massa/hml.yaml, ajuste rastro.config.yaml e rode: rastro scenario review EXEMPLO-1");
  }));

const scenario = program.command("scenario").description("cenários: listar, revisar, criar rascunho e aprovar");
scenario.command("list").option("-t, --tags <tags>").option("-s, --status <status>", "aprovado | rascunho | alterado")
  .action(action(async (o: { tags?: string; status?: any }) => {
    const r = await api.listScenarios(projectDir(), { tags: o.tags?.split(","), status: o.status });
    out(r, () => r.scenarios.map((s) => `${s.status.toUpperCase().padEnd(9)} ${s.id.padEnd(14)} ${s.title}`).join("\n") || "Nenhum cenário.");
  }));
scenario.command("review <id>").description("mostra em linguagem simples o que o cenário vai fazer")
  .action(action(async (id: string) => {
    const r = await api.reviewScenario(projectDir(), id);
    out(r, () => r.text);
  }));
scenario.command("draft <id> <arquivo>").description("grava um .scenario.md como rascunho (precisa de aprovação para rodar)")
  .option("--overwrite")
  .action(action(async (id: string, file: string, o: { overwrite?: boolean }) => {
    const { readFile } = await import("node:fs/promises");
    const r = await api.draftScenario(projectDir(), id, await readFile(file === "-" ? 0 as any : file, "utf8"), o);
    out(r, () => r.valid ? `Rascunho em ${r.file}. Para aprovar: ${r.approveCommand}` : `Rascunho em ${r.file}, mas inválido: ${r.error}`);
    if (!r.valid) process.exit(EXIT.SETUP);
  }));
scenario.command("approve <id>").description("[pessoa] aprova o cenário no estado atual (grava o hash)")
  .option("--by <nome>", "quem aprova", currentUser())
  .option("--yes", "não perguntar (use só quando for você rodando)")
  .action(action(async (id: string, o: { by: string; yes?: boolean }) => {
    const { project, scenario } = await api.findScenario(projectDir(), id);
    const approvers = project.config.approval.approvers;
    if (approvers.length && !approvers.includes(o.by)) throw new SetupError(`${o.by} não está em approval.approvers`, undefined, "needs_approval");
    await confirmHuman(`Aprovar ${scenario.meta.id} como ${o.by}`, o.yes);
    const rec = await (await Approvals.load(project.root)).approve(scenario, o.by);
    out({ id: scenario.meta.id, approval: rec }, () => `Aprovado ${scenario.meta.id} por ${rec.by} (${rec.hash.slice(0, 19)}…)`);
  }));

program.command("massa").description("confere CPF e CNPJ do arquivo de massa")
  .action(action(async () => {
    const r = await api.checkMassa(projectDir());
    out(r, () => r.ok ? `Massa ok: ${r.registros.length} registro(s) em ${r.file}` :
      r.problemas.length ? r.problemas.map((p) => `✗ ${p.caminho}: ${p.valor} (${p.motivo})`).join("\n") : `${r.file} vazio ou ausente`);
    if (!r.ok) process.exit(EXIT.SETUP);
  }));

program.command("run [caminhos...]").description("executa cenários aprovados e gera as evidências")
  .option("-e, --env <ambiente>", "ambiente (padrão: defaultEnv do config)")
  .option("-t, --tags <tags>", "só cenários com estas tags (separadas por vírgula)")
  .option("--agent", "eventos NDJSON durante a execução (com --json, só o resumo final)")
  .option("--headed", "mostra o navegador")
  .option("--dry-run", "valida cenário e config sem executar")
  .option("--refresh-queries", "pede queries novas à IA em vez de usar o lock")
  .action(action(async (paths: string[], o: any) => {
    const project = await loadProject(projectDir());
    if (json()) {
      // Um resumo por cenário, no mesmo formato do MCP.
      // Sem caminhos: só os aprovados (rascunhos esperam a pessoa).
      const files = paths.length ? paths : (await api.listScenarios(projectDir(), { tags: o.tags?.split(","), status: o.dryRun ? undefined : "aprovado" })).scenarios.map((s) => s.id);
      if (!files.length) throw new SetupError("Nenhum cenário aprovado para rodar", 'Veja com "rastro scenario list" e aprove com "rastro scenario approve <id>"', "needs_approval");
      const runs = [];
      for (const f of files) runs.push(await api.runScenario(projectDir(), f, { env: o.env, dryRun: !!o.dryRun, onEvent: o.agent ? (e) => process.stderr.write(JSON.stringify(e) + "\n") : undefined }));
      const exitCode = Math.max(0, ...runs.map((r) => r.exitCode));
      process.stdout.write(JSON.stringify({ ok: exitCode === 0, apiVersion: api.API_VERSION, exitCode, runs }) + "\n");
      process.exit(exitCode);
    }
    const { exitCode } = await runScenarios(project, paths, {
      env: o.env, explicitEnv: !!o.env, tags: o.tags?.split(","),
      flags: { headless: !o.headed, dryRun: !!o.dryRun, refreshQueries: !!o.refreshQueries, interactive: !o.agent && process.stdin.isTTY === true, viaMcp: false },
      emit: reporter(!!o.agent),
    });
    process.exit(exitCode);
  }));

const query = program.command("query").description("queries geradas pela IA (lock)");
query.command("list").option("--pending", "só as que aguardam aprovação")
  .action(action(async (o: { pending?: boolean }) => {
    const r = await api.listQueries(projectDir(), { pending: o.pending ? true : undefined });
    out(r, () => r.queries.map((e) => `[${e.key}] ${e.approved ? `aprovada por ${e.approvedBy}` : "AGUARDANDO APROVAÇÃO"} · ${e.scenario} · ${e.step} · ${e.dialect}\n  intenção: ${e.intent}\n  motivo: ${e.rationale}\n${e.query.replace(/^/gm, "    ")}\n`).join("\n") || "Nenhuma query no lock.");
  }));
query.command("approve <chave>").description("[pessoa] aprova uma query gerada pela IA")
  .option("--by <nome>", "quem aprova", currentUser())
  .option("--yes", "não perguntar (use só quando for você rodando)")
  .action(action(async (key: string, o: { by: string; yes?: boolean }) => {
    const project = await loadProject(projectDir());
    const lock = await QueryLock.load(project.root, project.config.ai.lock);
    await confirmHuman(`Aprovar a query ${key} como ${o.by}`, o.yes);
    const e = await lock.approve(key, o.by);
    out({ key, step: e.step, approved: e.approved }, () => `Query ${key} (${e.step}) aprovada por ${o.by}`);
  }));

const perf = program.command("perf").description("performance");
perf.command("baseline <pastaEvidencia>").description("[pessoa] usa os percentis de uma execução como referência para as próximas")
  .option("--by <nome>", "quem aprova", currentUser())
  .option("--yes", "não perguntar (use só quando for você rodando)")
  .action(action(async (dir: string, o: { by: string; yes?: boolean }) => {
    const project = await loadProject(projectDir());
    await confirmHuman(`Usar ${dir} como baseline de performance`, o.yes);
    const file = await saveBaseline(project.root, project.config.perf.baselinesDir, join(resolve(dir), "perf", "stats.json"), o.by);
    out({ file }, () => `Baseline salvo em ${file}`);
  }));

const jmeter = program.command("jmeter").description("plano de carga do JMeter");
jmeter.command("generate").description("gera um .jmx a partir de uma requisição do Bruno")
  .requiredOption("--from-bru <arquivo>", "arquivo .bru")
  .option("-o, --out <arquivo>", "destino do .jmx")
  .option("--csv <colunas>", "colunas da massa usadas como variáveis (ex.: cpf,nome)", "cpf,nome")
  .option("--status <regex>", "status esperado", "2\\d\\d")
  .option("--overwrite")
  .action(action(async (o: any) => {
    const r = await api.jmeterGenerate(projectDir(), { fromBru: resolve(o.fromBru), out: o.out && resolve(o.out), csvColumns: o.csv ? o.csv.split(",").filter(Boolean) : [], expectedStatus: o.status, overwrite: o.overwrite });
    out(r, () => `Plano gerado: ${r.file} (${r.method} ${r.url})\nPropriedades: ${r.properties.join(", ")}\nRevise o arquivo e aprove o cenário que o usa antes de rodar a carga.`);
  }));

const evidence = program.command("evidence").description("evidências");
evidence.command("get <runId>").description("resultado de uma execução")
  .action(action(async (runId: string) => {
    const r = await api.getEvidence(projectDir(), runId, { includeReport: !json() });
    out(r, () => `${r.report}\nPDF: ${r.pdf ?? "não gerado"} · ${r.verified ? "íntegra" : "manifest não confere"}`);
  }));
evidence.command("verify <pasta>").description("confere os hashes do manifest")
  .action(action(async (dir: string) => {
    const r = await api.verify(dir);
    out(r, () => r.ok ? "Evidência íntegra: todos os arquivos batem com o manifest." : r.problems.join("\n"));
    process.exit(r.ok ? 0 : 1);
  }));

const auth = program.command("auth").description("sessões de login reaproveitadas pela automação de tela");
auth.command("status").option("-e, --env <ambiente>")
  .action(action(async (o: { env?: string }) => {
    const r = await api.authStatus(projectDir(), o.env);
    out(r, () => r.sessions.map((s) => `${s.status.padEnd(9)} ${s.name}${s.ageHours !== undefined ? ` (${s.ageHours} h de ${s.maxAgeHours} h)` : ""}${s.captureCommand ? ` · ${s.captureCommand}` : ""}`).join("\n") || "Nenhuma sessão configurada.");
  }));
auth.command("capture <sessao>").option("-e, --env <ambiente>")
  .description("[pessoa] abre o navegador para você fazer login; a sessão fica salva para os próximos testes")
  .action(action(async (name: string, o: { env?: string }) => {
    const project = await loadProject(projectDir());
    const envName = o.env ?? project.config.defaultEnv;
    const env = envConfig(project, envName, { explicit: !!o.env });
    const cfg = env.sessions[name];
    if (!cfg) throw new SetupError(`Sessão "${name}" não existe em envs.${envName}.sessions`, undefined, "config");
    if (cfg.mode !== "storageState") throw new SetupError(`A sessão ${name} usa modo ${cfg.mode}; captura só se aplica a storageState`, undefined, "config");
    if (!process.stdin.isTTY) throw new SetupError("O login precisa ser feito por uma pessoa no navegador", `Peça para rodar: rastro auth capture ${name} --env ${envName}`, "session");
    const file = join(project.root, cfg.file ?? `.rastro/auth/${name}.json`);
    await mkdir(dirname(file), { recursive: true });
    await captureSession(cfg.loginUrl ?? env.baseUrl ?? "about:blank", file, async () => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      await rl.question("Faça o login no navegador e pressione Enter aqui. ");
      rl.close();
    });
    out({ session: name, file }, () => `Sessão salva em ${file} (não vai para o git).`);
  }));

program.command("doctor").description("confere ferramentas e acessos").option("-e, --env <ambiente>")
  .action(action(async (o: { env?: string }) => {
    const r = await api.doctor(projectDir(), o.env);
    if (json()) process.stdout.write(JSON.stringify({ apiVersion: api.API_VERSION, ...r }) + "\n");
    else console.log(formatDoctor(r));
    process.exit(r.ok ? 0 : EXIT.SETUP);
  }));

program.command("mcp").description("inicia o servidor MCP (stdio) para agentes LLM")
  .action(action(async () => {
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer(projectDir());
  }));

program.parseAsync().catch(fail);
