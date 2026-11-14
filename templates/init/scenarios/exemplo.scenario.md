---
id: EXEMPLO-1
title: Checkout aceita cupom de desconto
tags: [checkout]
massa: [cliente_pf]
change:
  summary: >
    POST /api/checkout passa a aceitar "discountCode" e grava o cupom
    no evento de log "checkout.order.created".
vars:
  discountCode: BF2026
---

@import ../flows/login.flow.md

## Aplicar cupom pela tela
```ui
session: hml-cliente
goto: /carrinho
do:
  - fill: { selector: "[data-test=cupom]", value: "{{discountCode}}" }
  - click: "[data-test=finalizar]"
expect:
  - response: { url: "**/api/checkout", status: 201 }
  - visible: "[data-test=pedido-confirmado]"
capture:
  orderId: response("**/api/checkout").body.orderId
```

## Chamar a API pelo Bruno
```api
tool: bruno
collection: ../collections/bruno/checkout
request: Criar pedido
vars:
  discountCode: "{{discountCode}}"
  cpf: "{{massa.cliente_pf.cpf}}"
expect:
  status: 201
  body.discount.code: "{{discountCode}}"
  durationMs: "< 800"
```

## Confirmar no CloudWatch que o payload chegou
```logs
source: cloudwatch
ai: >
  Ache os eventos checkout.order.created desta execução e mostre
  o discountCode e o total que trafegaram no payload.
expect:
  minRows: 2
  fields:
    payload.discountCode: "{{discountCode}}"
record: [correlationId, orderId, payload.discountCode, payload.total, httpStatus]
```

## Performance da alteração
```perf
load:
  tool: jmeter
  plan: ../perf/jmeter/criar-pedido.jmx
  properties: { cartId: carrinho-teste-1 }   # vars do cenário já vão como propriedades
  threads: 10
  rampSec: 30
  durationSec: 300
server:
  source: cloudwatch
  ai: p50, p90 e p95 de durationMs e taxa de erro de POST /api/checkout no período, numa linha só
budget:
  p50: "+10%"
  p90: "+10%"
  p95: "+15%"
  errorRate: "< 1"
```

## Saúde no Datadog
```datadog
service: checkout-api
logs: true
expect:
  errorRate: "< 1"
```
