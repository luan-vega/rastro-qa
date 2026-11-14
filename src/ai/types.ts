import { z } from "zod/v4";

export const DIALECTS = ["cwli", "spl", "datadog-logs"] as const;
export type Dialect = (typeof DIALECTS)[number];

/** validation: confirmar a alteração nesta execução. perf: percentis numa janela. */
export type QueryMode = "validation" | "perf";

export const QuerySpecSchema = z.object({
  query: z.string().describe("A query completa, pronta para executar"),
  expectedFields: z.array(z.string()).describe("Campos que a query devolve e que provam a alteração"),
  rationale: z.string().describe("Uma ou duas frases explicando por que esta query encontra a alteração"),
});
export type QuerySpec = z.infer<typeof QuerySpecSchema>;

export interface QueryRequest {
  dialect: Dialect;
  mode: QueryMode;
  intent: string;
  changeSummary?: string;
  diffExcerpt?: string;
  fields: string[];
  correlationId: string;
  captures: Record<string, unknown>;
  massaDocs: string[];
  previousError?: string;
}

export interface QueryGenerator {
  readonly model: string;
  generate(req: QueryRequest): Promise<QuerySpec>;
}
