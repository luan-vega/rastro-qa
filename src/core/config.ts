import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { SetupError } from "./errors.js";

const Session = z.object({
  mode: z.enum(["storageState", "cdp", "persistent"]).default("storageState"),
  file: z.string().optional(),
  endpoint: z.string().optional(),
  userDataDir: z.string().optional(),
  maxAgeHours: z.number().default(8),
  loginUrl: z.string().optional(),
});

const Env = z.object({
  baseUrl: z.string().optional(),
  apiHosts: z.array(z.string()).default([]),
  sessions: z.record(Session).default({}),
  api: z.object({
    bruno: z.object({ env: z.string() }).partial().default({}),
    insomnia: z.object({ env: z.string() }).partial().default({}),
  }).partial().default({}),
  logs: z.object({
    cloudwatch: z.object({
      region: z.string(),
      profile: z.string().optional(),
      endpoint: z.string().optional(),
      logGroups: z.array(z.string()),
      ingestionWaitSec: z.number().default(90),
      consoleSession: z.string().optional(),
    }).optional(),
    splunk: z.object({
      url: z.string(),
      token: z.string(),
      index: z.string().optional(),
      ingestionWaitSec: z.number().default(90),
    }).optional(),
    file: z.object({ path: z.string() }).optional(),
  }).default({}),
  datadog: z.object({
    site: z.string().default("datadoghq.com"),
    apiBase: z.string().optional(),
    apiKey: z.string(),
    appKey: z.string(),
    env: z.string().optional(),
  }).optional(),
  jmeter: z.object({
    host: z.string().optional(),
    port: z.number().optional(),
    protocol: z.string().default("https"),
  }).optional(),
});

export const ConfigSchema = z.object({
  project: z.string().default("rastro"),
  defaultEnv: z.string().default("hml"),
  allowedEnvs: z.array(z.string()).default(["hml"]),
  scenariosDir: z.string().default("scenarios"),
  correlation: z.object({
    header: z.string().default("x-correlation-id"),
    prefix: z.string().default("rst"),
    injectInto: z.array(z.enum(["ui", "api"])).default(["ui", "api"]),
  }).default({}),
  approval: z.object({
    required: z.boolean().default(true),
    approvers: z.array(z.string()).default([]),
  }).default({}),
  massa: z.object({
    file: z.string().default("massa/hml.yaml"),
    maskInEvidence: z.enum(["partial", "none"]).default("partial"),
  }).default({}),
  envs: z.record(Env),
  ai: z.object({
    provider: z.enum(["anthropic", "none"]).default("anthropic"),
    model: z.string().default("claude-opus-5-5"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
    maxRetries: z.number().default(2),
    maxWindowHours: z.number().default(24),
    lock: z.string().default(".rastro/queries.lock.json"),
  }).default({}),
  secrets: z.object({
    mask: z.array(z.string()).default(["password", "senha", "token", "authorization", "apikey", "secret", "cookie"]),
  }).default({}),
  perf: z.object({
    jmeter: z.object({
      home: z.string().optional(),
      defaults: z.object({ threads: z.number(), rampSec: z.number(), durationSec: z.number() })
        .default({ threads: 10, rampSec: 30, durationSec: 300 }),
    }).default({}),
    percentiles: z.array(z.number()).default([50, 90, 95]),
    baselinesDir: z.string().default("perf/baselines"),
  }).default({}),
  evidence: z.object({
    dir: z.string().default("evidence"),
    formats: z.array(z.enum(["pdf", "md", "junit"])).default(["pdf", "md", "junit"]),
  }).default({}),
  mcp: z.object({ allowedEnvs: z.array(z.string()).default(["hml"]) }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type EnvConfig = z.infer<typeof Env>;

export interface Project {
  root: string;
  config: Config;
}

export async function loadProject(dir = process.cwd()): Promise<Project> {
  const root = resolve(dir);
  const file = join(root, "rastro.config.yaml");
  if (!existsSync(file)) {
    throw new SetupError(`Não encontrei rastro.config.yaml em ${root}`, "Rode: rastro init", "config");
  }
  const raw = YAML.parse(await readFile(file, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new SetupError(`rastro.config.yaml inválido: ${problems}`, undefined, "config");
  }
  return { root, config: parsed.data };
}

export function envConfig(project: Project, env: string, opts: { viaMcp?: boolean; explicit?: boolean } = {}): EnvConfig {
  const allowed = opts.viaMcp ? project.config.mcp.allowedEnvs : project.config.allowedEnvs;
  if (!allowed.includes(env) && !(opts.explicit && !opts.viaMcp)) {
    throw new SetupError(`Ambiente "${env}" não está liberado`, `Ambientes liberados: ${allowed.join(", ")}`, "env_not_allowed");
  }
  const cfg = project.config.envs[env];
  if (!cfg) throw new SetupError(`Ambiente "${env}" não existe em envs: do rastro.config.yaml`, undefined, "config");
  return cfg;
}
