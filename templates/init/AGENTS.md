# Rastro neste projeto: regras para agentes

Este projeto usa o **Rastro** para validar mudanças de backend em homologação e gerar um PDF de evidência.
Você (agente) usa o Rastro pelo servidor MCP `rastro` (veja `.mcp.json`) ou pelo CLI com `--json`.

## Regras que não mudam

1. **Você não aprova nada.** Cenário, query gerada por IA, baseline de performance e login são sempre de uma pessoa.
   Quando a resposta trouxer `next.kind: "ask_human"`, pare e peça ao usuário para rodar `next.command`.
   Não edite `.rastro/approvals.json`, `.rastro/queries.lock.json` (campo `approved`) nem `perf/baselines/`.
2. **Nunca invente CPF ou CNPJ.** Use só registros de `massa/hml.yaml`, por referência: `{{massa.cliente_pf.cpf}}`.
   Se faltar um registro, peça ao usuário para incluir no arquivo de massa.
3. **Homologação.** Rode só nos ambientes de `mcp.allowedEnvs` (padrão `hml`). Nunca aponte para produção.
4. **Segredos** vêm de variáveis de ambiente (`{{secret:NOME}}`). Não escreva tokens em cenários nem em arquivos.

## Fluxo

| Passo | MCP | CLI |
|---|---|---|
| Ver o estado | `project_status` | `rastro --json scenario list`, `auth status`, `massa` |
| Escrever o cenário da mudança | `scenario_draft` | `rastro --json scenario draft <id> arquivo.md` |
| Mostrar ao usuário | `scenario_review` → mostre `text` | `rastro --json scenario review <id>` |
| **Usuário aprova** | — | `rastro scenario approve <id>` (pessoa) |
| Validar sem chamar nada | `scenario_run` com `dryRun: true` | `rastro --json run <id> --dry-run` |
| Executar | `scenario_run` | `rastro --json run <id>` |
| Ler a evidência | `evidence_get` | `rastro --json evidence get <runId>` |
| Plano de carga | `jmeter_generate` | `rastro --json jmeter generate --from-bru <arquivo.bru>` |

## Como ler a resposta de `scenario_run`

```json
{
  "ok": true, "status": "aprovado", "exitCode": 0, "runId": "rst-20261114-1701-ec89",
  "steps": [{ "index": 3, "kind": "api", "title": "Chamar a API pelo Bruno", "status": "passed", "summary": "201 · orderId 88124" }],
  "perf": [{ "metric": "p95", "where": "JMeter (cliente)", "baseline": 39, "candidate": 41, "deltaPct": 5.1, "rule": "+15%", "ok": true }],
  "pdf": "evidence/rst-20261114-1701-ec89/evidencia.pdf",
  "pendingQueries": [],
  "next": { "kind": "read_evidence", "pdf": "evidence/rst-20261114-1701-ec89/evidencia.pdf" }
}
```

- `status`: `aprovado` (tudo ok), `reprovado` (algum check falhou: mostre `failedChecks`), `erro` (ambiente/config), `nao_executado`.
- `exitCode`: 0 ok, 1 reprovado, 2 erro de preparo ou aprovação, 3 tempo esgotado.
- `steps[].status`: `passed`, `failed`, `error`, `warning` (ex.: sem baseline de performance), `skipped`.
- `error.code` quando não rodou:

| code | O que fazer |
|---|---|
| `needs_approval` | pedir ao usuário `next.command` (aprovar cenário) |
| `query_pending` | mostrar a query (`query_list`) e pedir `rastro query approve <chave>` |
| `session` | pedir ao usuário `rastro auth capture <sessão>` (login é humano) |
| `massa` | pedir o registro que falta em `massa/hml.yaml` |
| `secret` | pedir a variável de ambiente indicada em `hint` |
| `invalid_scenario` | corrigir o rascunho e chamar `scenario_draft` com `overwrite: true` |
| `env_not_allowed`, `config`, `tool_missing` | relatar ao usuário com `hint` |
| `timeout` | logs ainda não indexados; tentar de novo em alguns minutos |

## Escrevendo um cenário (`*.scenario.md`)

Frontmatter YAML e depois blocos por passo. Cada `## Título` vira o nome do passo no PDF.

```markdown
---
id: CHK-1423                 # use o id da tarefa
title: Checkout aceita cupom de desconto
covers: [LOJA-982]
tags: [checkout]
massa: [cliente_pf]          # registros de massa/hml.yaml usados
vars: { discountCode: BF2026 }
change:
  summary: POST /api/checkout passa a aceitar discountCode e grava no log checkout.order.created
impacts: { endpoints: ["POST /api/checkout"], logEvents: [checkout.order.created] }
---

@import ../flows/login.flow.md          # passos reaproveitados (login já feito)

## Chamar a API pelo Bruno
```api
tool: bruno                              # ou tool: http com method/url/headers/body
collection: ../collections/bruno/checkout
request: Criar pedido
vars: { discountCode: "{{discountCode}}", cpf: "{{massa.cliente_pf.cpf}}" }
expect: { status: 201, body.discount.code: "{{discountCode}}", durationMs: "< 800" }
capture: { orderId: body.orderId }
```

## Confirmar no CloudWatch
```logs
source: cloudwatch                       # ou splunk
ai: Ache os eventos checkout.order.created desta execução e mostre discountCode e total do payload
# ou query: | fields ... | filter correlationId like "{{correlationId}}" | limit 50
expect: { minRows: 1, fields: { payload.discountCode: "{{discountCode}}" } }
record: [correlationId, orderId, payload.discountCode, payload.total]
```

## Performance
```perf
load: { tool: jmeter, plan: ../perf/jmeter/criar-pedido.jmx, threads: 10, rampSec: 30, durationSec: 300 }
budget: { p50: "+10%", p90: "+10%", p95: "+15%", errorRate: "< 1" }
```

## Saúde no Datadog
```datadog
service: checkout-api
expect: { errorRate: "< 1" }
```
```

- Variáveis: `{{var}}`, `{{massa.<registro>.<campo>}}`, `{{correlationId}}` (id desta execução, vai no header `x-correlation-id`), capturas de passos anteriores, `{{secret:NOME}}`.
- `expect` aceita valor exato, `"< 800"`, `">= 1"`, `"!= 0"`, `exists`, `missing`, `/regex/`.
- Queries com `ai:` são geradas uma vez, passam por travas (filtro por `{{correlationId}}`, `limit`, sem comandos destrutivos, só documentos da massa) e ficam aguardando aprovação humana em `.rastro/queries.lock.json`.
