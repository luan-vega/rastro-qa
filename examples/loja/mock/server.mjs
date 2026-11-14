// Servidor de demonstração: uma loja com tela, API de checkout, CloudWatch Logs e Datadog simulados.
// Uso: node examples/loja/mock/server.mjs [porta]
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

export function startMock(port = 4010) {
  const logs = [];       // eventos de log da "aplicação"
  const queries = new Map();
  let orderSeq = 88123;

  const html = (body) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Loja HML</title>
<style>body{font-family:Arial,sans-serif;max-width:520px;margin:40px auto;color:#18202b}button{background:#2a5c9a;color:#fff;border:0;padding:8px 14px;border-radius:4px}
input{padding:6px;border:1px solid #9aa6b4;border-radius:3px}.row{display:flex;justify-content:space-between;border-bottom:1px dashed #ccc;padding:4px 0}.ok{color:#1f7a4d}</style></head><body>${body}</body></html>`;

  const logged = (req) => /(^|;\s*)sessao=ok/.test(req.headers.cookie ?? "");

  function readBody(req) {
    return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
  }

  function send(res, status, data, headers = {}) {
    const isStr = typeof data === "string";
    res.writeHead(status, { "content-type": isStr ? "text/html; charset=utf-8" : "application/json", ...headers });
    res.end(isStr ? data : JSON.stringify(data));
  }

  // Subconjunto do Logs Insights: filtros por igualdade/like e stats de percentil
  function runInsights(q, start, end) {
    let rows = logs.filter((l) => l._t >= start * 1000 && l._t <= end * 1000 + 999);
    for (const m of q.matchAll(/filter\s+([\w.@]+)\s*(=|like)\s*"([^"]+)"/g)) {
      rows = rows.filter((r) => {
        const v = String(get(r, m[1]) ?? "");
        return m[2] === "=" ? v === m[3] : v.includes(m[3].replace(/[%*]/g, ""));
      });
    }
    for (const m of q.matchAll(/filter\s+ispresent\(([\w.]+)\)/g)) rows = rows.filter((r) => get(r, m[1]) !== undefined);
    if (/\bstats\b/.test(q)) {
      const d = rows.map((r) => r.durationMs).sort((a, b) => a - b);
      const p = (x) => d[Math.max(0, Math.ceil((x / 100) * d.length) - 1)] ?? 0;
      const errs = rows.filter((r) => r.httpStatus >= 500).length;
      return [[["reqs", d.length], ["p50", p(50)], ["p90", p(90)], ["p95", p(95)], ["errorRate", d.length ? +(errs / d.length * 100).toFixed(2) : 0]].map(([field, value]) => ({ field, value: String(value) }))];
    }
    const fields = (q.match(/fields\s+([^|]+)/)?.[1] ?? "@timestamp, @message").split(",").map((s) => s.trim());
    return rows.slice(0, 50).map((r) => fields.map((f) => ({ field: f, value: f === "@timestamp" ? r["@timestamp"] : String(get(r, f) ?? "") })));
  }

  const get = (o, path) => path.split(".").reduce((a, k) => (a == null ? a : a[k]), o);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    // ---------- Tela ----------
    if (p === "/login") {
      if (req.method === "POST") return send(res, 302, "", { location: "/minha-conta", "set-cookie": "sessao=ok; Path=/; HttpOnly" });
      return send(res, 200, html(`<h2>Entrar</h2><form method="post"><input name="u" value="maria.teste"><button data-test="entrar">Entrar</button></form>`));
    }
    if (p === "/minha-conta") {
      if (!logged(req)) return send(res, 302, "", { location: "/login" });
      return send(res, 200, html(`<h2>Minha conta</h2><div data-test="menu-usuario">Maria Teste Silva</div>`));
    }
    if (p === "/carrinho") {
      if (!logged(req)) return send(res, 302, "", { location: "/login" });
      return send(res, 200, html(`<h3>Seu carrinho</h3><div class="row"><span>Tênis de corrida (1x)</span><span>R$ 199,90</span></div>
<p><input data-test="cupom" placeholder="Cupom"> <span id="msg"></span></p><div class="row"><b>Total</b><b id="total">R$ 199,90</b></div>
<p><button data-test="finalizar">Finalizar compra</button></p><div id="ok"></div>
<script>
document.querySelector('[data-test=finalizar]').onclick = async () => {
  const code = document.querySelector('[data-test=cupom]').value;
  const r = await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cartId: 'carrinho-teste-1', discountCode: code }) });
  const d = await r.json();
  document.getElementById('total').textContent = 'R$ ' + d.total.toFixed(2).replace('.', ',');
  document.getElementById('ok').innerHTML = '<h3 class="ok" data-test="pedido-confirmado">Pedido ' + d.orderId + ' confirmado</h3>';
};
</script>`));
    }

    // ---------- API ----------
    if (p === "/api/checkout" && req.method === "POST") {
      const t0 = Date.now();
      const body = JSON.parse((await readBody(req)) || "{}");
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 25));
      const discount = body.discountCode === "BF2026" ? 20 : 0;
      const orderId = orderSeq++;
      const total = +(199.9 - discount).toFixed(2);
      const now = new Date();
      logs.push({
        _t: now.getTime(), "@timestamp": now.toISOString().replace("T", " ").slice(0, 23),
        event: "checkout.order.created", correlationId: req.headers["x-correlation-id"] ?? "", orderId, httpStatus: 201,
        durationMs: Date.now() - t0, payload: { discountCode: body.discountCode, total, cpf: body.cpf },
      });
      return send(res, 201, { orderId, total, discount: body.discountCode ? { code: body.discountCode, value: discount } : null });
    }

    // ---------- CloudWatch Logs (protocolo JSON da AWS) ----------
    const target = req.headers["x-amz-target"];
    if (target) {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (target.endsWith("StartQuery")) {
        const id = randomBytes(8).toString("hex");
        queries.set(id, runInsights(b.queryString, b.startTime, b.endTime));
        return send(res, 200, { queryId: id }, { "content-type": "application/x-amz-json-1.1" });
      }
      if (target.endsWith("GetQueryResults")) {
        return send(res, 200, { status: "Complete", results: queries.get(b.queryId) ?? [] }, { "content-type": "application/x-amz-json-1.1" });
      }
      if (target.endsWith("StopQuery")) return send(res, 200, { success: true }, { "content-type": "application/x-amz-json-1.1" });
      return send(res, 400, { __type: "UnknownOperation" });
    }

    // ---------- Datadog ----------
    if (p === "/api/v1/validate") return send(res, 200, { valid: true });
    if (p === "/api/v1/monitor") return send(res, 200, [
      { name: "checkout-api · latência p95 acima de 800 ms", overall_state: "OK" },
      { name: "checkout-api · taxa de erro acima de 2%", overall_state: "OK" },
      { name: "checkout-api · healthcheck", overall_state: "OK" },
    ]);
    if (p === "/api/v1/slo") return send(res, 200, { data: [{ id: "slo1", name: "Disponibilidade checkout", thresholds: [{ target: 99.9 }] }] });
    if (p.startsWith("/api/v1/slo/")) return send(res, 200, { data: { overall: { sli_value: 99.96 } } });
    if (p === "/api/v1/query") {
      const q = url.searchParams.get("query") ?? "";
      const n = logs.length;
      const v = q.includes(".errors") ? 0 : n;
      return send(res, 200, { series: [{ pointlist: [[Date.now(), v]] }] });
    }
    if (p === "/api/v2/logs/events/search") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const id = (b.filter?.query ?? "").match(/correlationId:([\w-]+)/)?.[1] ?? "";
      return send(res, 200, { data: logs.filter((l) => String(l.correlationId).startsWith(id)).map((l) => ({ attributes: l })) });
    }

    send(res, 404, { erro: "não encontrado", path: p });
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, logs, port: server.address().port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMock(Number(process.argv[2] ?? 4010));
  console.log(`Loja de demonstração em http://127.0.0.1:${port}`);
}
