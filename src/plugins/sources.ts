import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, StopQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { fromIni } from "@aws-sdk/credential-providers";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunContext } from "../core/context.js";
import type { Dialect } from "../ai/types.js";
import { SetupError } from "../core/errors.js";
import { getPath, globToRegExp } from "../core/paths.js";

export type Row = Record<string, unknown>;

export interface LogSource {
  name: string;
  dialect: Dialect | "file";
  where: string;
  ingestionWaitSec: number;
  run(query: string, from: number, to: number): Promise<Row[]>;
  /** Roda com limite pequeno só para checar a sintaxe. Devolve a mensagem de erro ou null. */
  dryRun?(query: string, from: number, to: number): Promise<string | null>;
}

export function cloudwatchSource(ctx: RunContext): LogSource {
  const cfg = ctx.env.logs.cloudwatch;
  if (!cfg) throw new SetupError(`envs.${ctx.envName}.logs.cloudwatch não configurado`);
  const client = new CloudWatchLogsClient({
    region: cfg.region,
    ...(cfg.profile ? { credentials: fromIni({ profile: cfg.profile }) } : {}),
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
  });
  const exec = async (query: string, from: number, to: number): Promise<Row[]> => {
    const { queryId } = await client.send(new StartQueryCommand({
      logGroupNames: cfg.logGroups,
      startTime: Math.floor(from / 1000),
      endTime: Math.ceil(to / 1000),
      queryString: query,
    }));
    const deadline = Date.now() + 120_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, Number(process.env.RASTRO_CW_POLL_MS ?? 1500)));
      const out = await client.send(new GetQueryResultsCommand({ queryId }));
      if (out.status === "Complete") {
        return (out.results ?? []).map((r) => Object.fromEntries(r.filter((f) => f.field !== "@ptr").map((f) => [f.field!, f.value])));
      }
      if (out.status !== "Running" && out.status !== "Scheduled") throw new Error(`CloudWatch: consulta terminou com ${out.status}`);
      if (Date.now() > deadline) {
        await client.send(new StopQueryCommand({ queryId })).catch(() => undefined);
        throw ctx.timeout("CloudWatch: consulta passou de 2 minutos");
      }
    }
  };
  return {
    name: "cloudwatch",
    dialect: "cwli",
    where: `CloudWatch Logs Insights · ${cfg.region} · ${cfg.logGroups.join(", ")}`,
    ingestionWaitSec: cfg.ingestionWaitSec,
    run: exec,
    async dryRun(query, from, to) {
      try { await exec(query.replace(/\|\s*limit\s+\d+\s*$/i, "") + " | limit 1", from, to); return null; } catch (e) { return (e as Error).message; }
    },
  };
}

export function splunkSource(ctx: RunContext): LogSource {
  const cfg = ctx.env.logs.splunk;
  if (!cfg) throw new SetupError(`envs.${ctx.envName}.logs.splunk não configurado`);
  const exec = async (spl: string, from: number, to: number): Promise<Row[]> => {
    const token = ctx.resolve(cfg.token);
    const body = new URLSearchParams({
      search: /^\s*(search|\|)/.test(spl) ? spl : `search ${spl}`,
      earliest_time: String(Math.floor(from / 1000)),
      latest_time: String(Math.ceil(to / 1000)),
      output_mode: "json",
    });
    const res = await fetch(`${cfg.url}/services/search/v2/jobs/export`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
    const text = await res.text();
    if (!res.ok) throw new Error(`Splunk ${res.status}: ${text.slice(0, 300)}`);
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.result).map((e) => e.result as Row);
  };
  return {
    name: "splunk",
    dialect: "spl",
    where: `Splunk · ${cfg.index ?? cfg.url}`,
    ingestionWaitSec: cfg.ingestionWaitSec,
    run: exec,
    async dryRun(q, from, to) { try { await exec(`${q} | head 1`, from, to); return null; } catch (e) { return (e as Error).message; } },
  };
}

/**
 * Fonte local para desenvolvimento e testes: um arquivo NDJSON de logs.
 * A "query" é um objeto YAML { where: { campo: "valor ou glob" }, limit }.
 */
export function fileSource(ctx: RunContext): LogSource {
  const cfg = ctx.env.logs.file;
  if (!cfg) throw new SetupError(`envs.${ctx.envName}.logs.file não configurado`);
  return {
    name: "file",
    dialect: "file",
    where: `arquivo local ${cfg.path}`,
    ingestionWaitSec: 5,
    async run(query, from, to) {
      const q = JSON.parse(query) as { where?: Record<string, string>; limit?: number };
      let text = "";
      try { text = await readFile(join(ctx.project.root, cfg.path), "utf8"); } catch { return []; }
      const rows = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
      return rows.filter((r) => {
        const t = Date.parse(String(r["@timestamp"] ?? r.timestamp ?? ""));
        if (!Number.isNaN(t) && (t < from || t > to)) return false;
        return Object.entries(q.where ?? {}).every(([k, v]) => {
          const actual = getPath(r, k);
          if (v === "*") return actual !== undefined && actual !== null;
          return globToRegExp(String(v)).test(String(actual));
        });
      }).slice(0, q.limit ?? 200);
    },
  };
}

export function sourceFor(name: string, ctx: RunContext): LogSource {
  switch (name) {
    case "cloudwatch": return cloudwatchSource(ctx);
    case "splunk": return splunkSource(ctx);
    case "file": return fileSource(ctx);
    default: throw new SetupError(`Fonte de logs desconhecida: ${name}`);
  }
}
