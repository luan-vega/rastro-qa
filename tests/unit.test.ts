import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpfValido, cnpjValido, mascararCpf } from "../src/core/documentos.js";
import { interpolate } from "../src/core/interpolate.js";
import { matches, checkAll } from "../src/core/assert.js";
import { guardQuery } from "../src/ai/guards.js";
import { percentile, compareStats } from "../src/plugins/perf.js";
import { mask } from "../src/evidence/mask.js";
import { parseBru } from "../src/jmeter/bru.js";
import { generateJmx } from "../src/jmeter/generate.js";
import { loadScenario } from "../src/core/scenario.js";
import { Approvals } from "../src/core/approval.js";
import { validarMassa } from "../src/core/massa.js";
import { toApiError } from "../src/api.js";
import { SetupError, TimeoutError } from "../src/core/errors.js";

describe("documentos", () => {
  it("valida CPF e CNPJ (inclusive alfanumérico)", () => {
    expect(cpfValido("138.978.270-00")).toBe(true);
    expect(cpfValido("138.978.270-01")).toBe(false);
    expect(cpfValido("111.111.111-11")).toBe(false);
    expect(cnpjValido("11.222.333/0001-81")).toBe(true);
    expect(cnpjValido("11.222.333/0001-80")).toBe(false);
    expect(cnpjValido("12.ABC.345/01DE-35")).toBe(true);
  });
  it("mascara CPF", () => expect(mascararCpf("13897827000")).toBe("138.***.***-00"));
  it("aponta massa inválida", () => {
    const p = validarMassa({ a: { cpf: "138.978.270-01" }, b: { cpf: "138.978.270-00" } });
    expect(p.map((x) => x.caminho)).toEqual(["a.cpf"]);
  });
});

describe("interpolate", () => {
  const scope = { cartId: "c1", massa: { pf: { cpf: "1" } }, n: 5 };
  it("troca placeholders e mantém tipo quando é o valor inteiro", () => {
    expect(interpolate({ a: "{{cartId}}-x", b: "{{n}}", c: "{{massa.pf.cpf}}" }, scope)).toEqual({ a: "c1-x", b: 5, c: "1" });
  });
  it("erro claro para variável desconhecida", () => {
    expect(() => interpolate("{{nada}}", scope)).toThrow(/nada/);
  });
  it("segredo vem do ambiente", () => {
    process.env.RASTRO_TESTE_SEGREDO = "s3";
    expect(interpolate("{{secret:RASTRO_TESTE_SEGREDO}}", {})).toBe("s3");
  });
});

describe("assert", () => {
  it("operadores", () => {
    expect(matches(10, "< 800")).toBe(true);
    expect(matches(900, "< 800")).toBe(false);
    expect(matches("BF2026", "/^BF/")).toBe(true);
    expect(matches(undefined, "missing")).toBe(true);
    expect(matches(1, "exists")).toBe(true);
    expect(matches(201, 201)).toBe(true);
  });
  it("checkAll por caminho", () => {
    const r = checkAll({ "body.total": "> 100", status: 201 }, { status: 201, body: { total: 50 } });
    expect(r.filter((c) => !c.ok).map((c) => c.path)).toEqual(["body.total"]);
  });
});

describe("guardQuery", () => {
  const docs = new Set(["13897827000"]);
  it("exige correlationId e limit em validação", () => {
    expect(guardQuery("fields @message | limit 5", "cwli", "validation", docs)).toMatch(/correlationId/);
    expect(guardQuery("filter correlationId = '{{correlationId}}'", "cwli", "validation", docs)).toMatch(/limit/);
    expect(guardQuery("filter correlationId = '{{correlationId}}' | limit 5", "cwli", "validation", docs)).toBeNull();
  });
  it("recusa documento fora da massa e comando proibido", () => {
    expect(guardQuery("filter cpf = '529.982.247-25' and x='{{correlationId}}' | limit 5", "cwli", "validation", docs)).toMatch(/massa/);
    expect(guardQuery("filter cpf = '138.978.270-00' and x='{{correlationId}}' | limit 5", "cwli", "validation", docs)).toBeNull();
    expect(guardQuery("search index=a {{correlationId}} | delete", "spl", "validation", docs)).toMatch(/proibido/);
  });
});

describe("perf", () => {
  it("percentis e comparação com baseline", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    const rows = compareStats("cliente", { p50: 100, p90: 200, p95: 300, errorRate: 0 }, { reqs: 10, p50: 105, p90: 250, p95: 300, errorRate: 0 }, { p50: "+10%", p90: "+10%", p95: "+10%", errorRate: "< 1" });
    expect(rows.find((r) => r.metric === "p50")?.ok).toBe(true);
    expect(rows.find((r) => r.metric === "p90")?.ok).toBe(false);
  });
});

describe("mask", () => {
  it("esconde segredos, bearer e documentos", () => {
    const m = mask({ authorization: "Bearer abc.def", password: "x", body: "cpf 138.978.270-00" }, ["password", "authorization"]);
    const s = JSON.stringify(m);
    expect(s).not.toContain("abc.def");
    expect(s).not.toContain("270-00\"");
    expect(s).not.toContain("\"x\"");
  });
});

describe("jmeter", () => {
  it("gera plano a partir do .bru", () => {
    const req = parseBru(`post {\n  url: {{baseApi}}/api/checkout\n  body: json\n}\n\nheaders {\n  x-correlation-id: {{correlationId}}\n}\n\nbody:json {\n  {"cartId": "{{cartId}}", "cpf": "{{cpf}}"}\n}\n`);
    expect(req.method.toLowerCase()).toBe("post");
    const xml = generateJmx(req, { csvColumns: ["cpf"], expectedStatus: "201" });
    expect(xml).toContain("${__P(cartId)}");
    expect(xml).toContain("${cpf}");
    expect(xml).toContain("${__P(correlationId)}-${__threadNum}");
    expect(xml).toContain("<stringProp name=\"HTTPSampler.path\">/api/checkout</stringProp>");
  });
});

describe("cenário e aprovação", () => {
  it("hash muda quando o cenário ou um import muda, e a aprovação cai", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rastro-"));
    await mkdir(join(dir, "flows"));
    await writeFile(join(dir, "flows/a.flow.md"), "## Abrir\n```ui\nsession: s\nactions: [goto /]\n```\n");
    const file = join(dir, "x.scenario.md");
    await writeFile(file, "---\nid: X-1\ntitle: Teste\n---\n@import flows/a.flow.md\n\n## Chamar\n```api\ntool: http\nurl: http://x\n```\n");
    const s1 = await loadScenario(file);
    expect(s1.steps.map((s) => s.kind)).toEqual(["ui", "api"]);
    const ap = await Approvals.load(dir);
    expect(ap.status(s1)).toBe("rascunho");
    await ap.approve(s1, "luan");
    expect(ap.status(s1)).toBe("aprovado");
    await writeFile(join(dir, "flows/a.flow.md"), "## Abrir\n```ui\nsession: s\nactions: [goto /outra]\n```\n");
    const s2 = await loadScenario(file);
    expect(ap.status(s2)).toBe("alterado");
  });
});

describe("erros para agentes", () => {
  it("needs_approval vira ask_human com o comando", () => {
    const e = toApiError(new SetupError("rascunho", 'Revise com "rastro scenario review X" e aprove com "rastro scenario approve X"', "needs_approval"));
    expect(e.code).toBe("needs_approval");
    expect(e.next).toMatchObject({ kind: "ask_human" });
    expect(e.exitCode).toBe(2);
  });
  it("timeout vira retry", () => {
    expect(toApiError(new TimeoutError("demorou")).next.kind).toBe("retry");
  });
});
