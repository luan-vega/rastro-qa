import { randomBytes } from "node:crypto";
import type { Project, EnvConfig } from "./config.js";
import type { Scenario } from "./scenario.js";
import type { Massa } from "./massa.js";
import type { Emit } from "./events.js";
import { Evidence } from "../evidence/recorder.js";
import { interpolate, type Scope } from "./interpolate.js";
import { getPath } from "./paths.js";
import { TimeoutError } from "./errors.js";

export interface RunFlags {
  headless: boolean;
  dryRun: boolean;
  refreshQueries: boolean;
  /** Pergunta no terminal para aprovar queries novas. Falso em CI, --agent e MCP. */
  interactive: boolean;
  viaMcp: boolean;
}

export function newRunId(prefix: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${prefix}-${stamp}-${randomBytes(2).toString("hex")}`;
}

export class RunContext {
  readonly captures: Record<string, unknown> = {};
  readonly recorded: Record<string, unknown>[] = [];
  readonly windowStart: number;
  stepIndex = 0;
  stepSlug = "";
  private cleanups: (() => Promise<void>)[] = [];

  constructor(
    readonly project: Project,
    readonly envName: string,
    readonly env: EnvConfig,
    readonly scenario: Scenario,
    readonly massa: Massa,
    readonly runId: string,
    readonly evidence: Evidence,
    readonly flags: RunFlags,
    readonly emit: Emit,
  ) {
    // A janela começa um pouco antes, para tolerar diferença de relógio com os logs
    this.windowStart = Date.now() - 2 * 60_000;
  }

  get config() { return this.project.config; }
  get correlation() { return { header: this.config.correlation.header, id: this.runId }; }

  windowEnd(): number { return Date.now() + 60_000; }

  scope(): Scope {
    return {
      vars: this.scenario.meta.vars,
      captures: this.captures,
      massa: this.massa,
      correlationId: this.runId,
      runId: this.runId,
      env: this.envName,
      baseUrl: this.env.baseUrl,
    };
  }

  resolve<T>(value: T): T { return interpolate(value, this.scope()); }

  /** capture: { nome: "body.orderId" } lido de `source`. */
  capture(spec: Record<string, string> | undefined, source: unknown): void {
    if (!spec) return;
    for (const [name, path] of Object.entries(spec)) this.captures[name] = getPath(source, path);
  }

  onCleanup(fn: () => Promise<void>) { this.cleanups.push(fn); }

  async cleanup() {
    for (const fn of this.cleanups.reverse()) {
      try { await fn(); } catch { /* limpeza não derruba a execução */ }
    }
    this.cleanups = [];
  }

  sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  /** Repete `fn` até `until` aceitar o resultado ou o tempo acabar (atraso de ingestão de logs). */
  async retryUntil<T>(fn: () => Promise<T>, until: (r: T) => boolean, maxWaitSec: number, firstDelayMs = 2000): Promise<T> {
    const deadline = Date.now() + maxWaitSec * 1000;
    let delay = firstDelayMs;
    let last = await fn();
    while (!until(last)) {
      if (Date.now() + delay > deadline) return last;
      await this.sleep(delay);
      delay = Math.min(delay * 2, 15_000);
      last = await fn();
    }
    return last;
  }

  timeout(message: string): TimeoutError { return new TimeoutError(message); }
}
