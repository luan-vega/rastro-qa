import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as api from "../api.js";

/**
 * Servidor MCP: a interface principal do Rastro para agentes LLM.
 *
 * Toda ferramenta devolve structuredContent (JSON estável, apiVersion 1) e o mesmo JSON em texto.
 * Erros vêm com error.code e next (o que fazer a seguir). Não existe ferramenta para aprovar
 * cenário, query ou baseline, nem para capturar login: isso é sempre de uma pessoa.
 */
export const INSTRUCTIONS = `Rastro valida mudanças de backend em homologação (tela, API via Bruno, logs no CloudWatch/Splunk, carga no JMeter, saúde no Datadog) e gera um PDF de evidência.

Fluxo para agentes:
1. project_status para ver ambiente, massa, sessões e cenários.
2. Para testar uma mudança nova: escreva o cenário com scenario_draft. Use só registros da massa (massa: [nome]) e {{massa.nome.cpf}}; nunca invente CPF/CNPJ.
3. scenario_review e mostre o texto ao usuário. Peça para ELE aprovar com o comando em approveCommand. Você não pode aprovar.
4. scenario_run (opcional dryRun: true antes). Leia status, steps e next.
5. Se next.kind = "ask_human", pare e peça ao usuário para rodar next.command (aprovar cenário/query, capturar login). Não tente contornar.
6. Se ok, entregue o caminho do pdf ao usuário e resuma steps e perf.
Códigos de erro: needs_approval, query_pending, session, massa, secret, env_not_allowed, config, not_found, invalid_scenario, tool_missing, timeout.`;

type Json = Record<string, unknown>;
const ok = (data: object) => {
  const body: Json = { ok: true, apiVersion: api.API_VERSION, ...data };
  return { structuredContent: body, content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
};
const failure = (e: unknown) => {
  const body: Json = { ok: false, apiVersion: api.API_VERSION, error: api.toApiError(e) };
  return { isError: true, structuredContent: body, content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
};
/** Embrulha a chamada: exceções viram { ok: false, error } em vez de derrubar o servidor. */
const safe = <A>(fn: (a: A) => Promise<object>) => async (a: A) => { try { return ok(await fn(a)); } catch (e) { return failure(e); } };

const READ = { readOnlyHint: true, openWorldHint: false } as const;

export function buildMcpServer(dir: string): McpServer {
  const server = new McpServer({ name: "rastro", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool("project_status", {
    title: "Estado do projeto",
    description: "Ponto de partida. Mostra ambiente padrão, massa (só os nomes dos registros), sessões de login, cenários com estado de aprovação e queries aguardando aprovação.",
    inputSchema: { env: z.string().optional() },
    annotations: READ,
  }, safe(async ({ env }: { env?: string }) => {
    const [scenarios, massa, auth, queries] = await Promise.all([
      api.listScenarios(dir), api.checkMassa(dir), api.authStatus(dir, env).catch((e) => ({ error: api.toApiError(e) })), api.listQueries(dir, { pending: true }),
    ]);
    return {
      env: "env" in auth ? auth.env : env,
      massa: { ok: massa.ok, registros: massa.registros, problemas: massa.problemas.length },
      sessions: "sessions" in auth ? auth.sessions : auth,
      scenarios: scenarios.scenarios.map(({ id, title, status, tags }) => ({ id, title, status, tags })),
      invalidScenarios: scenarios.invalid,
      pendingQueries: queries.queries.map(({ key, scenario, step }) => ({ key, scenario, step })),
    };
  }));

  server.registerTool("scenario_list", {
    title: "Listar cenários",
    description: "Lista os cenários com estado de aprovação (aprovado, rascunho, alterado), passos e tags. Só cenários 'aprovado' rodam.",
    inputSchema: { tags: z.array(z.string()).optional(), status: z.enum(["aprovado", "rascunho", "alterado"]).optional() },
    annotations: READ,
  }, safe(({ tags, status }: { tags?: string[]; status?: "aprovado" | "rascunho" | "alterado" }) => api.listScenarios(dir, { tags, status })));

  server.registerTool("scenario_review", {
    title: "Revisar cenário",
    description: "Texto em linguagem simples do que o cenário faz, para mostrar ao usuário antes de ele aprovar. Devolve approveCommand, que o USUÁRIO deve rodar.",
    inputSchema: { id: z.string() },
    annotations: READ,
  }, safe(({ id }: { id: string }) => api.reviewScenario(dir, id)));

  server.registerTool("scenario_draft", {
    title: "Criar rascunho de cenário",
    description: "Grava um .scenario.md em scenarios/rascunhos/ como rascunho e valida a sintaxe. Ele só roda depois que o usuário aprovar. Use apenas registros da massa do usuário (frontmatter massa: [...]) e referencie documentos com {{massa.<registro>.cpf}}.",
    inputSchema: {
      id: z.string().regex(/^[A-Za-z0-9_-]+$/),
      markdown: z.string().describe("Conteúdo completo do .scenario.md, com frontmatter (id, title, massa, vars, impacts) e blocos ```ui/api/logs/perf/datadog"),
      overwrite: z.boolean().optional().describe("Substitui um rascunho seu com o mesmo id"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, safe(({ id, markdown, overwrite }: { id: string; markdown: string; overwrite?: boolean }) => api.draftScenario(dir, id, markdown, { overwrite })));

  server.registerTool("scenario_run", {
    title: "Executar cenário",
    description: "Executa um cenário APROVADO num ambiente liberado para MCP (mcp.allowedEnvs, padrão hml). Chama a API real do ambiente. Devolve status, passos, percentis, pdf e next. Use dryRun: true para só validar.",
    inputSchema: { id: z.string(), env: z.string().optional(), dryRun: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ id, env, dryRun }: { id: string; env?: string; dryRun?: boolean }) => {
    const r = await api.runScenario(dir, id, { env, dryRun, viaMcp: true });
    const body: Json = { apiVersion: api.API_VERSION, ...r };
    return { isError: !!r.error, structuredContent: body, content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
  });

  server.registerTool("query_list", {
    title: "Listar queries da IA",
    description: "Queries de log geradas pela IA e congeladas no lock, com estado de aprovação. As pendentes têm approveCommand para o usuário.",
    inputSchema: { pending: z.boolean().optional(), scenario: z.string().optional() },
    annotations: READ,
  }, safe(({ pending, scenario }: { pending?: boolean; scenario?: string }) => api.listQueries(dir, { pending, scenario })));

  server.registerTool("massa_check", {
    title: "Conferir massa",
    description: "Confere os CPF/CNPJ fictícios do arquivo de massa do usuário (dígitos verificadores). Não devolve os documentos, só os nomes dos registros e os problemas.",
    inputSchema: {},
    annotations: READ,
  }, safe(async () => {
    const r = await api.checkMassa(dir);
    return { ...r, problemas: r.problemas.map(({ caminho, motivo }) => ({ caminho, motivo })) };
  }));

  server.registerTool("auth_status", {
    title: "Sessões de login",
    description: "Estado das sessões de login reaproveitadas pela automação de tela. Sessão ausente ou expirada: peça ao usuário para rodar captureCommand.",
    inputSchema: { env: z.string().optional() },
    annotations: READ,
  }, safe(({ env }: { env?: string }) => api.authStatus(dir, env)));

  server.registerTool("doctor", {
    title: "Diagnóstico",
    description: "Confere ferramentas (Bruno, JMeter, Chromium), massa, sessões, Datadog e IA do ambiente.",
    inputSchema: { env: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(({ env }: { env?: string }) => api.doctor(dir, env)));

  server.registerTool("jmeter_generate", {
    title: "Gerar plano JMeter",
    description: "Gera um .jmx a partir de uma requisição .bru da coleção, com threads/rampa/duração por propriedade e massa via CSV. O cenário que usar o plano precisa ser aprovado pelo usuário.",
    inputSchema: {
      fromBru: z.string().describe("Caminho do .bru relativo ao projeto"),
      out: z.string().optional(), csvColumns: z.array(z.string()).optional(), expectedStatus: z.string().optional(), overwrite: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, safe((a: { fromBru: string; out?: string; csvColumns?: string[]; expectedStatus?: string; overwrite?: boolean }) => api.jmeterGenerate(dir, a)));

  server.registerTool("evidence_get", {
    title: "Ler evidência",
    description: "Resultado completo de uma execução (runId): passos, percentis, saúde, caminho do PDF e se o manifest confere.",
    inputSchema: { runId: z.string().regex(/^[\w-]+$/), includeReport: z.boolean().optional() },
    annotations: READ,
  }, safe(({ runId, includeReport }: { runId: string; includeReport?: boolean }) => api.getEvidence(dir, runId, { includeReport })));

  return server;
}

export async function startMcpServer(dir: string) {
  await buildMcpServer(dir).connect(new StdioServerTransport());
}
