import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { StepPlugin, Screenshot } from "../core/types.js";
import type { RunContext } from "../core/context.js";
import type { Check } from "../core/assert.js";
import { matches } from "../core/assert.js";
import { getPath, globToRegExp } from "../core/paths.js";
import { SetupError } from "../core/errors.js";

interface UiState { browser?: Browser; context: BrowserContext; page: Page; responses: { url: string; status: number; body: unknown }[]; shots: number }

const states = new WeakMap<RunContext, Map<string, UiState>>();

export function launchOptions(headless: boolean) {
  const exe = process.env.RASTRO_CHROMIUM_PATH;
  return { headless, ...(exe ? { executablePath: exe } : {}) };
}

async function openSession(name: string, ctx: RunContext): Promise<UiState> {
  let perCtx = states.get(ctx);
  if (!perCtx) { perCtx = new Map(); states.set(ctx, perCtx); }
  const existing = perCtx.get(name);
  if (existing) return existing;

  const cfg = ctx.env.sessions[name];
  if (!cfg) throw new SetupError(`Sessão "${name}" não existe em envs.${ctx.envName}.sessions`);
  let browser: Browser | undefined;
  let context: BrowserContext;
  if (cfg.mode === "cdp") {
    if (!cfg.endpoint) throw new SetupError(`Sessão ${name}: modo cdp precisa de endpoint`);
    browser = await chromium.connectOverCDP(cfg.endpoint);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else if (cfg.mode === "persistent") {
    if (!cfg.userDataDir) throw new SetupError(`Sessão ${name}: modo persistent precisa de userDataDir`);
    context = await chromium.launchPersistentContext(join(ctx.project.root, cfg.userDataDir), launchOptions(ctx.flags.headless));
  } else {
    const file = join(ctx.project.root, cfg.file ?? `.rastro/auth/${name}.json`);
    if (!existsSync(file)) throw new SetupError(`Sessão ${name} ainda não foi capturada`, `Rode: rastro auth capture ${name} --env ${ctx.envName}`, "session");
    const ageH = (Date.now() - statSync(file).mtimeMs) / 3_600_000;
    if (ageH > cfg.maxAgeHours) throw new SetupError(`Sessão ${name} expirada (${ageH.toFixed(1)} h)`, `Rode: rastro auth capture ${name} --env ${ctx.envName}`, "session");
    browser = await chromium.launch(launchOptions(ctx.flags.headless));
    context = await browser.newContext({ storageState: file, baseURL: ctx.env.baseUrl });
  }

  // correlationId só nas chamadas para a API do ambiente, para não vazar o header a terceiros
  if (ctx.config.correlation.injectInto.includes("ui") && ctx.env.apiHosts.length) {
    await context.route((url) => ctx.env.apiHosts.includes(url.host) || ctx.env.apiHosts.includes(url.hostname), (route) =>
      route.continue({ headers: { ...route.request().headers(), [ctx.correlation.header]: `${ctx.correlation.id}-ui` } }));
  }
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = context.pages()[0] ?? (await context.newPage());
  const state: UiState = { browser, context, page, responses: [], shots: 0 };
  page.on("response", async (r: Response) => {
    const ct = r.headers()["content-type"] ?? "";
    let body: unknown;
    if (ct.includes("json")) { try { body = await r.json(); } catch { /* corpo indisponível */ } }
    state.responses.push({ url: r.url(), status: r.status(), body });
  });
  perCtx.set(name, state);
  ctx.onCleanup(async () => {
    await context.tracing.stop({ path: ctx.evidence.path(`ui/trace-${name}.zip`) });
    if (cfg.mode !== "cdp") await (browser ? browser.close() : context.close());
    perCtx!.delete(name);
  });
  return state;
}

function findResponse(state: UiState, glob: string) {
  const re = globToRegExp(glob);
  return [...state.responses].reverse().find((r) => re.test(r.url));
}

async function waitResponse(state: UiState, glob: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = findResponse(state, glob);
    if (r) return r;
    await state.page.waitForTimeout(200);
  }
  return undefined;
}

async function shoot(state: UiState, ctx: RunContext, caption: string): Promise<Screenshot> {
  state.shots++;
  const file = `ui/${ctx.stepSlug}-${String(state.shots).padStart(2, "0")}.png`;
  await state.page.screenshot({ path: ctx.evidence.path(file), fullPage: false });
  const hora = new Date().toLocaleTimeString("pt-BR");
  return { file, caption: `${hora} · ${caption}` };
}

export const playwrightPlugin: StepPlugin = {
  kind: "ui",
  name: "playwright",
  supports: () => true,

  async run(step, ctx) {
    const spec = ctx.resolve(step.spec);
    const sessionName = spec.session;
    if (!sessionName) throw new SetupError(`O passo "${step.title}" precisa de session:`);
    const state = await openSession(sessionName, ctx);
    const { page } = state;
    const timeout = (spec.timeoutSec ?? 30) * 1000;
    page.setDefaultTimeout(timeout);
    const screenshots: Screenshot[] = [];
    const checks: Check[] = [];

    // Fluxo de login: confere se a sessão ainda vale
    if (spec.ensure) {
      if (spec.ensure.goto) await page.goto(spec.ensure.goto);
      const ok = spec.ensure.visible ? await page.locator(spec.ensure.visible).first().isVisible({ timeout: 5000 }).catch(() => false) : true;
      checks.push({ path: `sessão ${sessionName}`, expected: "logada", actual: ok ? "logada" : "expirada", ok });
      if (!ok) throw new SetupError(`A sessão ${sessionName} não está mais logada`, `Rode: rastro auth capture ${sessionName} --env ${ctx.envName}`, "session");
      return { status: "passed", summary: `sessão ${sessionName} válida`, checks, evidence: {} };
    }

    if (spec.goto) await page.goto(spec.goto);
    for (const action of spec.do ?? []) {
      const [verb, arg] = Object.entries(action)[0] as [string, any];
      switch (verb) {
        case "click": await page.locator(arg).first().click(); break;
        case "fill": await page.locator(arg.selector).first().fill(String(arg.value)); break;
        case "press": await page.keyboard.press(arg); break;
        case "select": await page.locator(arg.selector).first().selectOption(String(arg.value)); break;
        case "goto": await page.goto(arg); break;
        case "wait": await page.waitForTimeout(Number(arg) * 1000); break;
        case "waitFor": await page.locator(arg).first().waitFor(); break;
        case "screenshot": screenshots.push(await shoot(state, ctx, String(arg))); break;
        default: throw new SetupError(`Ação de tela desconhecida: ${verb}`);
      }
    }

    for (const exp of spec.expect ?? []) {
      if (exp.response) {
        const r = await waitResponse(state, exp.response.url, timeout);
        const status = r?.status;
        checks.push({ path: `resposta ${exp.response.url}`, expected: String(exp.response.status ?? "recebida"), actual: status ?? "nenhuma", ok: !!r && (exp.response.status === undefined || matches(status, exp.response.status)) });
      } else if (exp.visible) {
        const ok = await page.locator(exp.visible).first().isVisible({ timeout }).catch(() => false)
          || await page.locator(exp.visible).first().waitFor({ timeout }).then(() => true).catch(() => false);
        checks.push({ path: `visível ${exp.visible}`, expected: "visível", actual: ok ? "visível" : "não apareceu", ok });
      } else if (exp.text) {
        const content = await page.locator(exp.text.selector ?? "body").first().innerText().catch(() => "");
        checks.push({ path: `texto ${exp.text.selector ?? "body"}`, expected: exp.text.contains, actual: content.slice(0, 120), ok: content.includes(exp.text.contains) });
      }
    }

    for (const [name, expr] of Object.entries<string>(spec.capture ?? {})) {
      const m = expr.match(/^response\((["'])(.+?)\1\)\.?(.*)$/);
      if (m) {
        const r = findResponse(state, m[2]);
        ctx.captures[name] = r ? getPath({ status: r.status, body: r.body }, m[3]) : undefined;
      } else if (expr.startsWith("text:")) {
        ctx.captures[name] = (await page.locator(expr.slice(5)).first().innerText()).trim();
      }
    }

    screenshots.push(await shoot(state, ctx, spec.caption ?? step.title));
    const ok = checks.every((c) => c.ok);
    const captured = Object.keys(spec.capture ?? {}).map((k) => `${k} ${ctx.captures[k]}`).join(", ");
    return {
      status: ok ? "passed" : "failed",
      summary: `${step.title}${captured ? ` (${captured})` : ""}`,
      checks,
      evidence: { screenshots },
    };
  },
};

/** rastro auth capture: abre o navegador, a pessoa faz login, e o storageState é salvo. */
export async function captureSession(url: string, file: string, waitForEnter: () => Promise<void>) {
  const browser = await chromium.launch(launchOptions(false));
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await waitForEnter();
  await context.storageState({ path: file });
  await browser.close();
}
