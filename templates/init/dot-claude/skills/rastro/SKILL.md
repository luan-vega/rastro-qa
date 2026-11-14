---
name: rastro
description: Valida uma mudança de backend em homologação com o Rastro (tela, API Bruno, CloudWatch/Splunk, JMeter, Datadog) e entrega o PDF de evidência. Use quando pedirem para testar, validar ou gerar evidência de uma alteração, release ou PR.
---

# Validar uma mudança com o Rastro

Leia `AGENTS.md` na raiz do projeto antes de começar: ele tem as regras, o formato do cenário e os códigos de erro.

1. Chame `project_status` (MCP `rastro`). Se uma sessão estiver `ausente` ou `expirada`, peça ao usuário o `captureCommand` e espere.
2. Entenda a mudança (diff do PR ou descrição do usuário): endpoint, campos novos, evento de log.
3. Procure um cenário existente que cubra a mudança (`scenario_list`). Se não houver, escreva um com `scenario_draft`:
   - um passo `api` pela coleção Bruno com `expect` do campo novo;
   - um passo `logs` com `ai:` descrevendo o que provar no log (ou `query:` se souber a query);
   - `perf` se a mudança puder afetar tempo de resposta; `datadog` com o serviço.
   - Só registros da massa. Nunca escreva CPF/CNPJ no cenário.
4. Chame `scenario_review` e mostre o `text` ao usuário. Peça para ele rodar `approveCommand`. **Não aprove você mesmo, não edite arquivos de aprovação.**
5. Depois da aprovação: `scenario_run` com `dryRun: true`, depois sem.
6. Siga `next`:
   - `ask_human`: mostre `reason` e `command` ao usuário e pare.
   - `fix`: corrija o rascunho (`scenario_draft` com `overwrite: true`); isso exige nova aprovação.
   - `retry`: espere alguns minutos e tente de novo, no máximo duas vezes.
   - `read_evidence`: entregue o caminho do `pdf` com um resumo de 3 linhas (passos, p50/p90/p95 antes x agora, saúde do Datadog).
