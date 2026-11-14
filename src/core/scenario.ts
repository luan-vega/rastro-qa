import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { SetupError } from "./errors.js";

export const STEP_KINDS = ["ui", "api", "logs", "perf", "datadog"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export interface Step {
  kind: StepKind;
  title: string;
  spec: Record<string, any>;
  file: string;   // arquivo de origem (para resolver caminhos relativos)
  line: number;
}

const Frontmatter = z.object({
  id: z.string(),
  title: z.string().default(""),
  covers: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  env: z.string().optional(),
  massa: z.array(z.string()).default([]),
  vars: z.record(z.any()).default({}),
  change: z.object({ summary: z.string().optional(), diff: z.string().optional() }).default({}),
  impacts: z.object({
    paths: z.array(z.string()).default([]),
    endpoints: z.array(z.string()).default([]),
    logEvents: z.array(z.string()).default([]),
  }).partial().default({}),
}).passthrough();

export type ScenarioMeta = z.infer<typeof Frontmatter>;

export interface Scenario {
  meta: ScenarioMeta;
  file: string;
  steps: Step[];
  /** sha256 do cenário e de todos os arquivos importados; muda quando qualquer um deles muda. */
  hash: string;
  sources: string[];
}

function splitFrontmatter(text: string): { fm: string; body: string; bodyLine: number } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: "", body: text, bodyLine: 1 };
  return { fm: m[1], body: text.slice(m[0].length), bodyLine: m[0].split("\n").length };
}

async function parseBody(file: string, seen: Set<string>, sources: Map<string, string>): Promise<Step[]> {
  const abs = resolve(file);
  if (seen.has(abs)) throw new SetupError(`@import circular em ${file}`, undefined, "invalid_scenario");
  seen.add(abs);
  const text = (await readFile(abs, "utf8")).replace(/\r\n/g, "\n");
  sources.set(abs, text);
  const { body, bodyLine } = splitFrontmatter(text);
  const lines = body.split("\n");
  const steps: Step[] = [];
  let title = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const imp = line.match(/^@import\s+(\S+)/);
    if (imp) {
      steps.push(...(await parseBody(join(dirname(abs), imp[1]), seen, sources)));
      continue;
    }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) { title = h[1].trim(); continue; }
    const fence = line.match(/^```(\w+)\s*$/);
    if (fence && (STEP_KINDS as readonly string[]).includes(fence[1])) {
      const start = i;
      const buf: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) buf.push(lines[i]);
      if (i >= lines.length) throw new SetupError(`Bloco \`\`\`${fence[1]} sem fechamento em ${file}:${bodyLine + start}`, undefined, "invalid_scenario");
      let spec: unknown;
      try { spec = YAML.parse(buf.join("\n")) ?? {}; } catch (e) {
        throw new SetupError(`YAML inválido no bloco ${fence[1]} em ${file}:${bodyLine + start}: ${(e as Error).message}`, undefined, "invalid_scenario");
      }
      steps.push({ kind: fence[1] as StepKind, title: title || fence[1], spec: spec as Record<string, any>, file: abs, line: bodyLine + start });
    }
  }
  seen.delete(abs);
  return steps;
}

export async function loadScenario(file: string): Promise<Scenario> {
  const abs = resolve(file);
  const text = (await readFile(abs, "utf8")).replace(/\r\n/g, "\n");
  const { fm } = splitFrontmatter(text);
  if (!fm) throw new SetupError(`${file} não tem frontmatter (--- id: ... ---)`, undefined, "invalid_scenario");
  const meta = Frontmatter.safeParse(YAML.parse(fm));
  if (!meta.success) throw new SetupError(`Frontmatter inválido em ${file}: ${meta.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, undefined, "invalid_scenario");
  const sources = new Map<string, string>();
  const steps = await parseBody(abs, new Set(), sources);
  const h = createHash("sha256");
  for (const [path, content] of [...sources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    h.update(relative(dirname(abs), path)).update("\0").update(content).update("\0");
  }
  return { meta: meta.data, file: abs, steps, hash: `sha256:${h.digest("hex")}`, sources: [...sources.keys()] };
}

/** Lista arquivos *.scenario.md a partir de caminhos (arquivos ou pastas). */
export async function findScenarioFiles(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const abs = resolve(p);
    let entries;
    try { entries = await readdir(abs, { withFileTypes: true, recursive: true }); } catch {
      out.push(abs);
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".scenario.md")) out.push(join(e.parentPath ?? (e as any).path, e.name));
    }
  }
  return [...new Set(out)].sort();
}
