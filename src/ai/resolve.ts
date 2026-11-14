import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import type { RunContext } from "../core/context.js";
import type { Step } from "../core/scenario.js";
import { SetupError } from "../core/errors.js";
import { interpolatePartial } from "../core/interpolate.js";
import { documentosDaMassa } from "../core/massa.js";
import { guardQuery } from "./guards.js";
import { lockKey, QueryLock, type LockEntry } from "./lock.js";
import { AnthropicQueryGenerator } from "./anthropic.js";
import type { Dialect, QueryGenerator, QueryMode } from "./types.js";

export interface ResolvedQuery { query: string; origin: "cenário" | "lock" | "ia"; key?: string; entry?: LockEntry }

let generatorOverride: QueryGenerator | undefined;
/** Permite trocar o gerador (testes, outros provedores). */
export function setQueryGenerator(g: QueryGenerator | undefined) { generatorOverride = g; }

function generator(ctx: RunContext): QueryGenerator {
  if (generatorOverride) return generatorOverride;
  if (ctx.config.ai.provider === "none") throw new SetupError("IA desligada (ai.provider: none); escreva a query no cenário com query:");
  return new AnthropicQueryGenerator(ctx.config.ai.model, ctx.config.ai.effort);
}

export function currentUser(): string {
  return process.env.RASTRO_USER || userInfo().username;
}

async function askApproval(entry: LockEntry, key: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write(`\nQuery nova gerada pela IA [${key}] para "${entry.step}":\n${entry.query.replace(/^/gm, "  ")}\nMotivo: ${entry.rationale}\n`);
  const answer = await rl.question("Aprovar esta query? [s/N] ");
  rl.close();
  return /^s(im)?$/i.test(answer.trim());
}

/**
 * Devolve a query a executar, nesta ordem: escrita no cenário, congelada no lock, ou gerada pela IA.
 * Query gerada pela IA só roda depois de aprovada por uma pessoa.
 */
export async function resolveQuery(opts: {
  ctx: RunContext;
  step: Step;
  dialect: Dialect;
  mode: QueryMode;
  fields?: string[];
  dryRun?: (query: string) => Promise<string | null>;
}): Promise<ResolvedQuery> {
  const { ctx, step, dialect, mode } = opts;
  const scope = ctx.scope();
  if (typeof step.spec.query === "string") {
    return { query: interpolatePartial(step.spec.query, scope), origin: "cenário" };
  }
  const intent: string | undefined = step.spec.ai;
  if (!intent) throw new SetupError(`O passo "${step.title}" precisa de query: ou ai:`);

  const lock = await QueryLock.load(ctx.project.root, ctx.config.ai.lock);
  const key = lockKey({ scenario: ctx.scenario.meta.id, step: step.title, dialect, intent });
  let entry = ctx.flags.refreshQueries ? undefined : lock.get(key);
  let origin: ResolvedQuery["origin"] = "lock";

  if (!entry) {
    origin = "ia";
    const massaDocs = documentosDaMassa(ctx.massa);
    const gen = generator(ctx);
    let previousError: string | undefined;
    for (let attempt = 0; attempt <= ctx.config.ai.maxRetries; attempt++) {
      const spec = await gen.generate({
        dialect, mode, intent,
        changeSummary: ctx.scenario.meta.change.summary,
        fields: opts.fields ?? step.spec.fields ?? [],
        correlationId: ctx.runId,
        captures: ctx.captures,
        massaDocs: [...massaDocs],
        previousError,
      });
      // O modelo às vezes devolve o valor concreto; guardamos sempre o placeholder
      const templ = spec.query.split(ctx.runId).join("{{correlationId}}");
      await ctx.evidence.appendJsonl("ai/prompts.jsonl", { attempt, step: step.title, dialect, intent, model: gen.model, response: spec });
      let problem = guardQuery(templ, dialect, mode, massaDocs);
      if (!problem && opts.dryRun) problem = await opts.dryRun(interpolatePartial(templ, scope));
      if (!problem) {
        entry = {
          scenario: ctx.scenario.meta.id, step: step.title, dialect, mode, intent,
          query: templ, expectedFields: spec.expectedFields, rationale: spec.rationale,
          model: gen.model, createdAt: new Date().toISOString(),
        };
        await lock.put(key, entry);
        break;
      }
      previousError = problem;
    }
    if (!entry) throw new SetupError(`A IA não gerou uma query válida para "${step.title}": ${previousError}`);
  }

  if (!entry.approved) {
    ctx.emit({ type: "query_pending", key, dialect, query: entry.query });
    if (ctx.flags.interactive && (await askApproval(entry, key))) {
      entry = await lock.approve(key, currentUser());
    } else {
      throw new SetupError(`Query [${key}] aguardando aprovação`, `Revise com "rastro query list" e aprove com "rastro query approve ${key}"`, "query_pending");
    }
  }
  return { query: interpolatePartial(entry.query, scope), origin, key, entry };
}
