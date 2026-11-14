import type { StepPlugin, HealthEvidence, Screenshot } from "../core/types.js";
import type { RunContext } from "../core/context.js";
import type { Check } from "../core/assert.js";
import { matches } from "../core/assert.js";
import { SetupError } from "../core/errors.js";

export class DatadogClient {
  readonly base: string;
  readonly app: string;
  constructor(private readonly ctx: RunContext) {
    const cfg = ctx.env.datadog;
    if (!cfg) throw new SetupError(`envs.${ctx.envName}.datadog não configurado`);
    this.base = (cfg.apiBase ?? `https://api.${cfg.site}`).replace(/\/$/, "");
    this.app = `https://app.${cfg.site}`;
  }

  private headers() {
    const cfg = this.ctx.env.datadog!;
    return { "DD-API-KEY": this.ctx.resolve(cfg.apiKey), "DD-APPLICATION-KEY": this.ctx.resolve(cfg.appKey), "Content-Type": "application/json" };
  }

  async get(path: string): Promise<any> {
    const res = await fetch(this.base + path, { headers: this.headers() });
    if (!res.ok) throw new Error(`Datadog ${res.status} em ${path.split("?")[0]}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(this.base + path, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Datadog ${res.status} em ${path}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async download(url: string): Promise<Buffer | undefined> {
    for (let i = 0; i < 6; i++) {
      const res = await fetch(url);
      if (res.ok && (res.headers.get("content-type") ?? "").startsWith("image/")) return Buffer.from(await res.arrayBuffer());
      await new Promise((r) => setTimeout(r, 2000));
    }
    return undefined;
  }
}

const sumSeries = (r: any) => (r?.series ?? []).reduce((acc: number, s: any) => acc + (s.pointlist ?? []).reduce((a: number, p: [number, number | null]) => a + (p[1] ?? 0), 0), 0);

export async function serviceHealth(dd: DatadogClient, service: string, env: string, from: number, to: number) {
  const [fromS, toS] = [Math.floor(from / 1000), Math.ceil(to / 1000)];
  const monitors: any[] = await dd.get(`/api/v1/monitor?monitor_tags=${encodeURIComponent(`service:${service}`)}&tags=${encodeURIComponent(`env:${env}`)}`);
  const slosRes = await dd.get(`/api/v1/slo?tags_query=${encodeURIComponent(`service:${service}`)}`).catch(() => ({ data: [] }));
  const slos = await Promise.all((slosRes.data ?? []).map(async (s: any) => {
    const h = await dd.get(`/api/v1/slo/${s.id}/history?from_ts=${fromS}&to_ts=${toS}`).catch(() => undefined);
    return { name: s.name, value: h?.data?.overall?.sli_value, target: s.thresholds?.[0]?.target };
  }));
  const q = (m: string) => dd.get(`/api/v1/query?from=${fromS}&to=${toS}&query=${encodeURIComponent(m)}`).catch(() => undefined);
  const [hits, errors] = await Promise.all([
    q(`sum:trace.http.request.hits{service:${service},env:${env}}.as_count()`),
    q(`sum:trace.http.request.errors{service:${service},env:${env}}.as_count()`),
  ]);
  const requests = sumSeries(hits);
  const errs = sumSeries(errors);
  return {
    monitors: monitors.map((m) => ({ name: m.name, state: m.overall_state ?? "No Data" })),
    slos,
    requests,
    requestsPerSec: requests ? +(requests / Math.max(1, toS - fromS)).toFixed(1) : undefined,
    errorRatePct: requests ? +((errs / requests) * 100).toFixed(2) : undefined,
  };
}

export const datadogPlugin: StepPlugin = {
  kind: "datadog",
  name: "datadog",
  supports: () => true,

  async run(step, ctx) {
    const spec = ctx.resolve(step.spec);
    const dd = new DatadogClient(ctx);
    const env = ctx.env.datadog!.env ?? ctx.envName;
    const service: string = spec.service ?? spec.apm?.service;
    if (!service) throw new SetupError(`O passo "${step.title}" precisa de service:`);
    const from = ctx.windowStart, to = Date.now();
    const checks: Check[] = [];
    const images: Screenshot[] = [];
    const links: HealthEvidence["links"] = [];

    const health = await serviceHealth(dd, service, env, from, to);
    await ctx.evidence.writeJson("datadog/saude.json", health);
    const notOk = health.monitors.filter((m) => m.state !== "OK");
    checks.push({ path: "monitores em OK", expected: `${health.monitors.length}`, actual: health.monitors.length - notOk.length, ok: notOk.length === 0 });
    const expect = spec.expect ?? {};
    if (expect.errorRate !== undefined && health.errorRatePct !== undefined) {
      checks.push({ path: "taxa de erro (%)", expected: String(expect.errorRate), actual: health.errorRatePct, ok: matches(health.errorRatePct, String(expect.errorRate).replace("%", "").trim()) });
    }
    links.push({ label: "Serviço no APM", url: `${dd.app}/apm/entity/service:${service}?env=${env}&start=${from}&end=${to}` });

    if (spec.logs) {
      const query = `service:${service} @${ctx.correlation.header === "x-correlation-id" ? "correlationId" : ctx.correlation.header}:${ctx.correlation.id}*`;
      const res = await dd.post("/api/v2/logs/events/search", { filter: { query, from: new Date(from).toISOString(), to: new Date(to).toISOString() }, sort: "timestamp", page: { limit: 100 } });
      await ctx.evidence.writeMasked("datadog/logs.json", res.data ?? []);
      const n = (res.data ?? []).length;
      checks.push({ path: "logs da execução no Datadog", expected: `>= ${spec.logs.minRows ?? 1}`, actual: n, ok: n >= (spec.logs.minRows ?? 1) });
      links.push({ label: "Logs desta execução", url: `${dd.app}/logs?query=${encodeURIComponent(query)}&from_ts=${from}&to_ts=${to}` });
    }

    for (const [i, snap] of (spec.snapshots ?? []).entries()) {
      const title = typeof snap === "string" ? snap : snap.title;
      const metric = typeof snap === "string" ? undefined : snap.query;
      if (!metric) continue;
      const r = await dd.get(`/api/v1/graph/snapshot?metric_query=${encodeURIComponent(metric)}&start=${Math.floor(from / 1000)}&end=${Math.ceil(to / 1000)}&title=${encodeURIComponent(title)}`);
      const png = r.snapshot_url ? await dd.download(r.snapshot_url) : undefined;
      if (png) {
        const file = `datadog/snapshot-${i + 1}.png`;
        await ctx.evidence.write(file, png);
        images.push({ file, caption: title });
      }
    }
    await ctx.evidence.write("datadog/links.md", links.map((l) => `- [${l.label}](${l.url})`).join("\n") + "\n");

    const ok = checks.every((c) => c.ok);
    return {
      status: ok ? "passed" : "failed",
      summary: `${service}: ${health.monitors.length - notOk.length} de ${health.monitors.length} monitores OK` +
        (health.errorRatePct !== undefined ? ` · erro ${health.errorRatePct}%` : "") +
        (health.requests ? ` · ${health.requests} requisições` : ""),
      checks,
      evidence: { health: { service, ...health, links, images } },
    };
  },
};
