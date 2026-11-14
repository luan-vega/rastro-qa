# Rastro

Validação de backend ponta a ponta, feita para ser chamada por **agentes LLM** (MCP ou CLI com `--json`) e aprovada por **pessoas**.

Um cenário em Markdown descreve a mudança e o Rastro, em homologação:

- usa a tela com um **login já feito** (sessão salva do Playwright, Chrome aberto via CDP ou perfil persistente);
- chama a API pela **coleção Bruno** (ou HTTP direto);
- prova no **CloudWatch** ou **Splunk** que o payload chegou, registrando as variáveis que trafegaram;
- roda carga no **JMeter** (plano gerado da coleção Bruno) e compara **p50, p90 e p95** com a medição anterior;
- coleta a **saúde no Datadog** (monitores, SLO, taxa de erro);
- gera um **PDF simples** com prints e explicações, com hash de cada arquivo.

Uma IA (Claude) pode escrever as queries de log a partir de uma frase. Toda query nova passa por travas e espera aprovação humana.

## Regras de segurança

| Regra | Como é garantida |
|---|---|
| Cenário só roda depois de aprovado por uma pessoa | hash do cenário e dos imports em `.rastro/approvals.json`; qualquer mudança volta para "alterado" |
| Agente nunca aprova | não existe ferramenta MCP de aprovação; `approve` pede confirmação no terminal |
| Massa de dados é do usuário | CPF/CNPJ fictícios em `massa/hml.yaml`, validados; a IA não pode usar documento fora da massa |
| Ambiente de homologação | MCP só roda nos ambientes de `mcp.allowedEnvs` (padrão `hml`) |
| Evidência sem dado sensível | segredos, tokens e documentos mascarados; `manifest.json` com sha256 |

## Instalação

```bash
npm i -g rastro-qa            # Node 20+
npx playwright install chromium
npm i -g @usebruno/cli        # chamadas de API
# JMeter 5.6+: defina perf.jmeter.home no config ou RASTRO_JMETER_BIN
```

## Começo rápido (pessoa)

```bash
rastro init                         # config, massa, cenário, coleção Bruno, plano JMeter, .mcp.json e AGENTS.md
# preencha massa/hml.yaml com CPF/CNPJ fictícios e ajuste rastro.config.yaml
rastro doctor                       # confere Bruno, JMeter, Chromium, sessões, Datadog
rastro auth capture hml-cliente     # faz login uma vez; a sessão fica salva fora do git
rastro scenario review EXEMPLO-1    # o que o cenário faz, em português simples
rastro scenario approve EXEMPLO-1
rastro run                          # roda os aprovados e gera evidence/<runId>/evidencia.pdf
rastro perf baseline evidence/<runId>   # usa essa execução como "antes" das próximas
```

## Uso por agentes

`rastro init` cria `.mcp.json`, `AGENTS.md` e a skill `.claude/skills/rastro`. Com isso um agente (Claude Code ou outro cliente MCP) já encontra o servidor:

```json
{ "mcpServers": { "rastro": { "command": "npx", "args": ["-y", "rastro-qa", "mcp"] } } }
```

| Ferramenta MCP | Para quê |
|---|---|
| `project_status` | ponto de partida: ambiente, massa, sessões, cenários, queries pendentes |
| `scenario_list`, `scenario_review` | ver cenários e o texto para o usuário aprovar |
| `scenario_draft` | gravar um cenário novo como rascunho (precisa de aprovação humana) |
| `scenario_run` | executar (ou `dryRun`) e receber status, passos, percentis, PDF e `next` |
| `query_list` | queries geradas pela IA e se estão aprovadas |
| `evidence_get` | resultado completo de uma execução e se o manifest confere |
| `massa_check`, `auth_status`, `doctor` | diagnóstico |
| `jmeter_generate` | plano `.jmx` a partir de uma requisição `.bru` |

Toda resposta é JSON estável (`apiVersion: 1`, em `structuredContent`). Quando algo não roda vem `error.code` e `next`:

```json
{ "ok": false, "error": { "code": "needs_approval", "message": "O cenário CHK-1423 ainda é rascunho" },
  "next": { "kind": "ask_human", "command": "rastro scenario approve CHK-1423" } }
```

O mesmo vale para o CLI: qualquer comando com `--json` imprime um único objeto JSON no stdout (erros inclusive). `rastro run --json --agent` também manda eventos NDJSON no stderr durante a execução. A API também pode ser importada: `import { api } from "rastro-qa"`.

Detalhes do formato de cenário e dos códigos de erro: [templates/init/AGENTS.md](templates/init/AGENTS.md).

## Comandos

| Comando | |
|---|---|
| `rastro init` | cria o projeto modelo |
| `rastro scenario list \| review <id> \| draft <id> <arquivo> \| approve <id>` | cenários (`approve` é só para pessoas) |
| `rastro run [cenários] [--env] [--tags] [--dry-run] [--agent]` | executa os aprovados |
| `rastro query list \| approve <chave>` | queries da IA |
| `rastro perf baseline <pasta>` | salva a medição de referência |
| `rastro jmeter generate --from-bru <arquivo.bru>` | gera o plano de carga |
| `rastro evidence get <runId> \| verify <pasta>` | evidências |
| `rastro auth status \| capture <sessão>` | sessões de login |
| `rastro massa`, `rastro doctor`, `rastro mcp` | |

Códigos de saída: `0` passou, `1` reprovado, `2` erro de preparo ou falta de aprovação, `3` tempo esgotado.

## Demonstração

`examples/loja` tem uma loja simulada (tela, API, CloudWatch e Datadog falsos) para ver tudo funcionando sem acesso a nada:

```bash
npm install
RASTRO_JMETER_BIN=/caminho/jmeter/bin/jmeter npm run demo
```

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test                     # unitários + ponta a ponta pelo MCP (JMeter opcional via RASTRO_JMETER_BIN)
npm run build
```

Licença Apache-2.0.
