/**
 * Ponta a ponta pelo MCP, como um agente usaria: loja simulada, Bruno real, Playwright real,
 * SDK da AWS contra o CloudWatch simulado e Datadog simulado. JMeter só se RASTRO_JMETER_BIN existir;
 * sem ele o passo de performance é removido da cópia do cenário.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { loadScenario } from "../src/core/scenario.js";
import { Approvals } from "../src/core/approval.js";
import { launchOptions } from "../src/plugins/ui-playwright.js";
// @ts-expect-error módulo JS sem tipos
import { startMock } from "../examples/loja/mock/server.mjs";

const repo = resolve(import.meta.dirname, "..");
const jmeter = process.env.RASTRO_JMETER_BIN && existsSync(process.env.RASTRO_JMETER_BIN);
let dir: string, server: any, client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: r.structuredContent as any };
}

beforeAll(async () => {
  process.env.DD_API_KEY ??= "teste"; process.env.DD_APP_KEY ??= "teste";
  process.env.AWS_ACCESS_KEY_ID ??= "teste"; process.env.AWS_SECRET_ACCESS_KEY ??= "teste";
  process.env.RASTRO_BRU_BIN ??= join(repo, "node_modules/.bin/bru");
  process.env.RASTRO_CW_POLL_MS = "200";
  const mock = await startMock(0);
  server = mock.server;
  dir = await mkdtemp(join(tmpdir(), "rastro-e2e-"));
  await cp(join(repo, "examples/loja"), dir, {
    recursive: true,
    filter: (src) => !/[\\/](evidence|\.rastro|mock|baselines)([\\/]|$)/.test(src.slice(join(repo, "examples/loja").length)),
  });
  for (const f of ["rastro.config.yaml", "collections/bruno/checkout/environments/local.bru"]) {
    const p = join(dir, f);
    await writeFile(p, (await readFile(p, "utf8")).replaceAll("4010", String(mock.port)));
  }
  if (!jmeter) {
    const p = join(dir, "scenarios/checkout-desconto.scenario.md");
    await writeFile(p, (await readFile(p, "utf8")).replace(/## Performance da alteração\n```perf[\s\S]*?```\n/, ""));
  }
  // Login uma vez, como a pessoa faria com "rastro auth capture"
  await mkdir(join(dir, ".rastro/auth"), { recursive: true });
  const browser = await chromium.launch(launchOptions(true));
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${mock.port}/login`);
  await page.click("[data-test=entrar]");
  await page.context().storageState({ path: join(dir, ".rastro/auth/hml-cliente.json") });
  await browser.close();

  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "teste", version: "0" });
  await Promise.all([buildMcpServer(dir).connect(a), client.connect(b)]);
}, 60_000);

afterAll(async () => {
  await client?.close();
  server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("MCP para agentes", () => {
  it("não oferece ferramenta de aprovação e explica o fluxo", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["project_status", "scenario_draft", "scenario_run", "evidence_get", "jmeter_generate"]));
    expect(names.some((n) => /approve|aprov|capture|baseline/.test(n))).toBe(false);
    expect(client.getInstructions()).toMatch(/Você não pode aprovar/);
  });

  it("project_status mostra cenário em rascunho, massa e sessão", async () => {
    const { data } = await call("project_status");
    expect(data.ok).toBe(true);
    expect(data.scenarios).toContainEqual(expect.objectContaining({ id: "CHK-1423", status: "rascunho" }));
    expect(data.massa).toMatchObject({ ok: true, registros: ["cliente_pf", "carga"] });
    expect(data.sessions[0]).toMatchObject({ name: "hml-cliente", status: "ok" });
    expect(JSON.stringify(data)).not.toContain("138.978.270-00");
  });

  it("recusa rodar cenário não aprovado e diz o que pedir à pessoa", async () => {
    const { isError, data } = await call("scenario_run", { id: "CHK-1423" });
    expect(isError).toBe(true);
    expect(data.error.code).toBe("needs_approval");
    expect(data.next).toEqual({ kind: "ask_human", reason: expect.any(String), command: "rastro scenario approve CHK-1423" });
  });

  it("recusa ambiente fora de mcp.allowedEnvs", async () => {
    const { data } = await call("scenario_run", { id: "CHK-1423", env: "prod" });
    expect(["env_not_allowed", "config"]).toContain(data.error.code);
  });

  it("grava rascunho válido e inválido", async () => {
    const good = await call("scenario_draft", { id: "NOVO-1", markdown: "---\nid: NOVO-1\ntitle: Novo\nmassa: [cliente_pf]\n---\n## Chamar\n```api\ntool: http\nurl: http://x\n```\n" });
    expect(good.data).toMatchObject({ ok: true, valid: true, approveCommand: "rastro scenario approve NOVO-1" });
    expect(good.data.scenario.status).toBe("rascunho");
    const bad = await call("scenario_draft", { id: "NOVO-2", markdown: "sem frontmatter" });
    expect(bad.data).toMatchObject({ ok: true, valid: false });
    expect((await call("scenario_draft", { id: "NOVO-1", markdown: "x" })).data.error.code).toBe("invalid_scenario");
  });

  it("depois da aprovação humana, roda e entrega o PDF", async () => {
    const s = await loadScenario(join(dir, "scenarios/checkout-desconto.scenario.md"));
    await (await Approvals.load(dir)).approve(s, "pessoa-de-teste");
    const { isError, data } = await call("scenario_run", { id: "CHK-1423" });
    expect(data.error).toBeUndefined();
    expect(isError).toBe(false);
    expect(data.status).toBe("aprovado");
    expect(data.steps.every((x: any) => ["passed", "warning"].includes(x.status))).toBe(true);
    expect(data.next).toEqual({ kind: "read_evidence", pdf: expect.stringMatching(/evidencia\.pdf$/) });
    expect(existsSync(join(dir, data.pdf))).toBe(true);
    if (jmeter) expect(data.perf.map((p: any) => p.metric)).toEqual(expect.arrayContaining(["p50", "p90", "p95"]));

    const ev = await call("evidence_get", { runId: data.runId });
    expect(ev.data).toMatchObject({ ok: true, verified: true });
  }, 120_000);
});
