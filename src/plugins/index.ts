import type { StepPlugin } from "../core/types.js";
import type { Step } from "../core/scenario.js";
import { SetupError } from "../core/errors.js";
import { httpPlugin } from "./api-http.js";
import { brunoPlugin } from "./api-bruno.js";
import { playwrightPlugin } from "./ui-playwright.js";
import { logsPlugin } from "./logs.js";
import { perfPlugin } from "./perf.js";
import { datadogPlugin } from "./datadog.js";

export const plugins: StepPlugin[] = [httpPlugin, brunoPlugin, playwrightPlugin, logsPlugin, perfPlugin, datadogPlugin];

export function pluginFor(step: Step): StepPlugin {
  const p = plugins.find((p) => p.kind === step.kind && p.supports(step));
  if (!p) throw new SetupError(`Nenhum plugin para o bloco ${step.kind}${step.spec.tool ? ` (tool: ${step.spec.tool})` : ""}`, step.kind === "api" ? "Use tool: bruno ou tool: http" : undefined);
  return p;
}
