import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { SetupError } from "../core/errors.js";
import { buildPrompt } from "./prompts.js";
import { QuerySpecSchema, type QueryGenerator, type QueryRequest, type QuerySpec } from "./types.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export class AnthropicQueryGenerator implements QueryGenerator {
  private readonly client = new Anthropic();

  constructor(readonly model: string, private readonly effort: Effort) {}

  async generate(req: QueryRequest): Promise<QuerySpec> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      // Se o modelo recusar por política, a API refaz o pedido no modelo de reserva
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: this.effort, format: betaZodOutputFormat(QuerySpecSchema) },
      messages: [{ role: "user", content: buildPrompt(req) }],
    });
    if (response.stop_reason === "refusal") {
      throw new SetupError(`O modelo recusou gerar a query: ${response.stop_details?.explanation ?? "sem detalhe"}`);
    }
    if (!response.parsed_output) throw new SetupError("O modelo não devolveu uma query no formato esperado");
    return response.parsed_output;
  }
}
