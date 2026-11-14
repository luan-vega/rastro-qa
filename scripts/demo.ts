// Demonstração ponta a ponta com a loja simulada: npm run demo
// Sobe o servidor falso, faz login uma vez (sessão salva), aprova o cenário de exemplo em seu nome e executa.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../src/core/config.js";
import { loadScenario } from "../src/core/scenario.js";
import { Approvals } from "../src/core/approval.js";
import { runScenarioFile } from "../src/core/runner.js";
import { reporter } from "../src/core/events.js";
import { launchOptions } from "../src/plugins/ui-playwright.js";
import { currentUser } from "../src/ai/resolve.js";
// @ts-expect-error módulo JS sem tipos
import { startMock } from "../examples/loja/mock/server.mjs";

const root = resolve(fileURLToPath(new URL("../examples/loja", import.meta.url)));
process.env.DD_API_KEY ??= "demo";
process.env.DD_APP_KEY ??= "demo";
process.env.AWS_ACCESS_KEY_ID ??= "demo";
process.env.AWS_SECRET_ACCESS_KEY ??= "demo";
process.env.RASTRO_BRU_BIN ??= resolve(root, "../../node_modules/.bin/bru");

const { server } = await startMock(4010);
try {
  const project = await loadProject(root);
  // Login uma vez, como a pessoa faria com "rastro auth capture"
  const authFile = join(root, ".rastro/auth/hml-cliente.json");
  await mkdir(join(root, ".rastro/auth"), { recursive: true });
  const browser = await chromium.launch(launchOptions(true));
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:4010/login");
  await page.click("[data-test=entrar]");
  await page.context().storageState({ path: authFile });
  await browser.close();

  const file = join(root, "scenarios/checkout-desconto.scenario.md");
  const scenario = await loadScenario(file);
  const approvals = await Approvals.load(root);
  if (approvals.status(scenario) !== "aprovado") {
    await approvals.approve(scenario, currentUser());
    console.log(`(demo) cenário ${scenario.meta.id} aprovado em nome de ${currentUser()}`);
  }
  const r = await runScenarioFile(project, file, {
    flags: { headless: true, dryRun: false, refreshQueries: false, interactive: false, viaMcp: false },
    emit: reporter(process.argv.includes("--agent")),
  });
  console.log(`PDF: ${join(r.evidenceDir, "evidencia.pdf")}`);
  process.exitCode = r.exitCode;
} finally {
  server.close();
}
