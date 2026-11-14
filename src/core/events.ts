import type { StepResult } from "./types.js";

export type RunEvent =
  | { type: "run_start"; runId: string; scenario: string; env: string; correlationId: string }
  | { type: "step_start"; index: number; kind: string; title: string }
  | { type: "step_end"; index: number; result: StepResult }
  | { type: "query_pending"; key: string; dialect: string; query: string }
  | { type: "evidence"; path: string }
  | { type: "run_end"; status: string; summary: string; evidenceDir: string; durationMs: number; exitCode: number };

export type Emit = (e: RunEvent) => void;

const ICON: Record<string, string> = { passed: "✓", failed: "✗", error: "!", warning: "~", skipped: "-" };

export function reporter(agent: boolean, write: (s: string) => void = (s) => process.stdout.write(s)): Emit {
  if (agent) return (e) => write(JSON.stringify(e) + "\n");
  return (e) => {
    switch (e.type) {
      case "run_start":
        write(`\n${e.scenario} · ambiente ${e.env} · ${e.runId}\n`);
        break;
      case "step_end": {
        const r = e.result;
        write(`${ICON[r.status] ?? "?"} ${r.kind.padEnd(8)} ${r.title}: ${r.summary}${r.error ? ` (${r.error})` : ""}\n`);
        for (const c of r.checks.filter((c) => !c.ok)) {
          write(`    esperado ${c.path} ${c.expected}, veio ${JSON.stringify(c.actual)}\n`);
        }
        break;
      }
      case "query_pending":
        write(`  query nova aguardando aprovação [${e.key}]:\n${e.query.replace(/^/gm, "    ")}\n`);
        break;
      case "run_end":
        write(`${e.status.toUpperCase()} · ${e.summary}\nEvidências: ${e.evidenceDir}\n`);
        break;
    }
  };
}
