# Desenvolvendo o Rastro

Guia para agentes que alteram este repositório. Para **usar** o Rastro num projeto, veja `templates/init/AGENTS.md`.

- TypeScript ESM (NodeNext), Node 20+. `npm run typecheck`, `npm test`, `npm run build`.
- `src/api.ts` é a interface para agentes: o MCP (`src/mcp/server.ts`) e o CLI com `--json` só embrulham essas funções. Mudou o formato? Aumente `API_VERSION`.
- Erros que param a execução são `SetupError(mensagem, dica, code)`. Use um `ErrorCode` de `src/core/errors.ts`; o agente decide pelo código, não pelo texto.
- Nunca crie ferramenta MCP ou função na API que aprove cenário, query ou baseline, ou que capture login. Isso é sempre humano.
- Textos para o usuário em português simples. Nada de CPF/CNPJ, tokens ou segredos em evidência sem passar por `src/evidence/mask.ts`.
- Plugins de passo ficam em `src/plugins/` e implementam `StepPlugin` (`src/core/types.ts`).
- `tests/mcp.e2e.test.ts` roda tudo pelo MCP contra `examples/loja/mock/server.mjs`; mantenha-o passando.
