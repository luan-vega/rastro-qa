---
id: CHK-1423
title: Checkout aceita cupom de desconto
covers: [LOJA-982]
tags: [checkout, demo]
massa: [cliente_pf]
change:
  summary: >
    POST /api/checkout passa a aceitar o campo discountCode e grava o cupom
    no evento de log checkout.order.created.
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
query: |
  fields @timestamp, correlationId, orderId, payload.discountCode, payload.total, httpStatus
  | filter event = "checkout.order.created"
  | filter correlationId like "{{correlationId}}"
  | filter ispresent(payload.discountCode)
  | sort @timestamp asc
  | limit 50
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
server:
  source: cloudwatch
  query: |
    filter event = "checkout.order.created" and correlationId like "{{correlationId}}-jm"
    | stats count() as reqs, pct(durationMs, 50) as p50, pct(durationMs, 90) as p90, pct(durationMs, 95) as p95
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
