import type { QueryRequest } from "./types.js";

const DIALECT_RULES: Record<string, string> = {
  cwli: `Linguagem: CloudWatch Logs Insights.
- Comandos permitidos: fields, filter, stats, sort, limit, parse, display, dedup.
- Não coloque período na query; ele é passado pela API.
- Termine com "| limit N" (no máximo 200) quando não usar stats.
- Para percentis use stats pct(campo, 50), pct(campo, 90), pct(campo, 95) e count().`,
  spl: `Linguagem: Splunk SPL.
- Comece com "search".
- Nunca use: delete, outputlookup, collect, sendemail, script, map, rest.
- Termine com "| head N" (no máximo 200) quando não usar stats.
- Para percentis use stats p50(campo), p90(campo), p95(campo), count.`,
  "datadog-logs": `Linguagem: sintaxe de busca de logs do Datadog (ex.: service:checkout-api @correlationId:abc @payload.discountCode:*).
- Apenas a expressão de busca, sem período.`,
};

export function buildPrompt(req: QueryRequest): string {
  const lines = [
    `Você escreve uma query de logs para validar uma alteração de backend em homologação.`,
    DIALECT_RULES[req.dialect],
    ``,
    `Campos que existem nos logs (use somente estes): ${req.fields.length ? req.fields.join(", ") : "(catálogo vazio; use os nomes que aparecem no diff)"}`,
  ];
  if (req.mode === "validation") {
    lines.push(`Filtre obrigatoriamente por correlationId usando exatamente o texto {{correlationId}} (ele será substituído pelo identificador da execução, que começa com ${req.correlationId}).`);
  } else {
    lines.push(`Esta é uma query de performance: calcule p50, p90, p95, contagem e taxa de erro para a rota da alteração.`);
  }
  if (req.massaDocs.length) {
    lines.push(`Se precisar de CPF ou CNPJ, use somente estes (dados fictícios do usuário): ${req.massaDocs.join(", ")}. Nunca invente documento.`);
  }
  if (req.changeSummary) lines.push(``, `Alteração: ${req.changeSummary}`);
  if (req.diffExcerpt) lines.push(``, `Trechos do diff:`, req.diffExcerpt);
  if (Object.keys(req.captures).length) lines.push(``, `Valores capturados nesta execução: ${JSON.stringify(req.captures)}`);
  lines.push(``, `Intenção do testador: ${req.intent}`);
  if (req.previousError) lines.push(``, `A tentativa anterior falhou com: ${req.previousError}. Corrija.`);
  return lines.join("\n");
}
