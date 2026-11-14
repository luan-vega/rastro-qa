import type { StepPlugin } from "../core/types.js";
import type { Check } from "../core/assert.js";
import { matches } from "../core/assert.js";
import { getPath } from "../core/paths.js";
import { resolveQuery } from "../ai/resolve.js";
import { sourceFor, type Row } from "./sources.js";

function fmt(ms: number) {
  return new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const logsPlugin: StepPlugin = {
  kind: "logs",
  name: "logs",
  supports: () => true,

  async run(step, ctx) {
    const source = sourceFor(step.spec.source ?? "cloudwatch", ctx);
    const from = ctx.windowStart;
    let query: string;
    let origin: string;
    if (source.dialect === "file") {
      query = JSON.stringify(ctx.resolve(step.spec.query ?? {}));
      origin = "cenário";
    } else {
      const r = await resolveQuery({
        ctx, step, dialect: source.dialect, mode: "validation",
        dryRun: source.dryRun ? (q) => source.dryRun!(q, from, ctx.windowEnd()) : undefined,
      });
      query = r.query;
      origin = r.origin === "cenário" ? "escrita no cenário" : `gerada pela IA e aprovada por ${r.entry?.approved?.by} em ${r.entry?.approved?.at?.slice(0, 10)}`;
    }
    const slug = `logs/${ctx.stepSlug}`;
    await ctx.evidence.write(`${slug}.query.txt`, query + "\n");

    const expect = ctx.resolve(step.spec.expect ?? {});
    const minRows: number = expect.minRows ?? 1;
    const fields: Record<string, unknown> = expect.fields ?? {};
    const matching = (rows: Row[]) => rows.filter((r) => Object.entries(fields).every(([k, v]) => matches(getPath(r, k), v)));

    const rows = await ctx.retryUntil(
      () => source.run(query, from, ctx.windowEnd()),
      (rs) => matching(rs).length >= minRows,
      step.spec.waitSec ?? source.ingestionWaitSec,
    );
    const to = ctx.windowEnd();
    const masked = ctx.evidence.mask(rows);
    await ctx.evidence.writeJson(`${slug}.results.json`, masked);

    const record: string[] = step.spec.record ?? Object.keys(rows[0] ?? {});
    const table = masked.map((r) => Object.fromEntries(record.map((c) => [c, getPath(r, c)])));
    if (table.length) {
      const csv = [record.join(","), ...table.map((r) => record.map((c) => JSON.stringify(r[c] ?? "")).join(","))].join("\n");
      await ctx.evidence.write(`${slug}.variaveis.csv`, csv + "\n");
    }
    ctx.recorded.push(...table);

    const hits = matching(rows).length;
    const checks: Check[] = [{ path: "linhas que batem", expected: `>= ${minRows}`, actual: hits, ok: hits >= minRows }];
    if (expect.maxRows !== undefined) checks.push({ path: "linhas", expected: `<= ${expect.maxRows}`, actual: rows.length, ok: rows.length <= expect.maxRows });
    const ok = checks.every((c) => c.ok);
    const fieldDesc = Object.entries(fields).map(([k, v]) => `${k} = ${v}`).join(", ");
    return {
      status: ok ? "passed" : "failed",
      summary: `${source.name} · ${rows.length} registro(s)${fieldDesc ? `, ${hits} com ${fieldDesc}` : ""}`,
      checks,
      evidence: {
        logs: {
          source: source.name, query, where: source.where,
          period: `${fmt(from)} a ${fmt(to)}`,
          rows: table, columns: record, queryOrigin: origin,
        },
      },
    };
  },
};
