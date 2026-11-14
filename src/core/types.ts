import type { Check } from "./assert.js";
import type { Step, StepKind } from "./scenario.js";
import type { RunContext } from "./context.js";

export type StepStatus = "passed" | "failed" | "error" | "warning" | "skipped";

export interface Screenshot { file: string; caption: string }
export interface Table { columns: string[]; rows: unknown[][] }

/** Dados que o PDF sabe apresentar. Cada plugin preenche o que fizer sentido. */
export interface StepEvidence {
  screenshots?: Screenshot[];
  calls?: { name: string; sent: string; received: string; durationMs?: number; ok: boolean }[];
  logs?: { source: string; query: string; where: string; period: string; rows: Record<string, unknown>[]; columns: string[]; queryOrigin: string };
  perf?: PerfEvidence;
  health?: HealthEvidence;
  notes?: string[];
}

export interface PerfRow { metric: string; where: string; baseline?: number; candidate: number; deltaPct?: number; rule?: string; ok: boolean }
export interface PerfEvidence {
  load?: { tool: string; threads?: number; rampSec?: number; durationSec?: number; samples: number };
  rows: PerfRow[];
  baselineRef?: string;
}

export interface HealthEvidence {
  service: string;
  monitors: { name: string; state: string }[];
  slos: { name: string; value?: number; target?: number }[];
  errorRatePct?: number;
  requests?: number;
  requestsPerSec?: number;
  links: { label: string; url: string }[];
  images: Screenshot[];
}

export interface StepResult {
  kind: StepKind;
  title: string;
  status: StepStatus;
  summary: string;
  durationMs: number;
  checks: Check[];
  evidence: StepEvidence;
  error?: string;
}

export type PluginOutcome = Omit<StepResult, "kind" | "title" | "durationMs">;

export interface StepPlugin {
  kind: StepKind;
  name: string;
  supports(step: Step): boolean;
  run(step: Step, ctx: RunContext): Promise<PluginOutcome>;
}
