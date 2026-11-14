// Gráficos SVG simples para o PDF. Todos em escala linear a partir de zero.

const INK = "#18202b", MUT = "#5a6573", LINE = "#dde2e8", BEFORE = "#9aa6b4", AFTER = "#b4530f";

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * exp * 4 >= v)! * exp;
  return Math.ceil(v / step) * step;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Barras agrupadas antes x depois para p50/p90/p95. */
export function barsBeforeAfter(groups: { label: string; before?: number; after: number }[], unit = "ms"): string {
  const W = 400, H = 250, L = 44, R = 8, T = 34, B = 30;
  const max = niceMax(Math.max(...groups.flatMap((g) => [g.before ?? 0, g.after])) * 1.1);
  const ph = H - T - B, pw = W - L - R;
  const y = (v: number) => T + ph - (v / max) * ph;
  const out = [`<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans, Arial, sans-serif">`];
  for (let i = 0; i <= 4; i++) {
    const t = (max / 4) * i;
    out.push(`<line x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="${LINE}"/><text x="${L - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${MUT}">${Math.round(t)}</text>`);
  }
  out.push(`<text x="${L - 6}" y="${T - 10}" text-anchor="end" font-size="10" fill="${MUT}">${unit}</text>`);
  const gw = pw / groups.length, bw = 30;
  groups.forEach((g, i) => {
    const cx = L + gw * i + gw / 2;
    const bars: [number | undefined, string, number][] = [[g.before, BEFORE, cx - bw - 3], [g.after, AFTER, cx + 3]];
    for (const [v, c, x] of bars) {
      if (v === undefined) continue;
      out.push(`<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw}" height="${(T + ph - y(v)).toFixed(1)}" fill="${c}" rx="2"/>`);
      out.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${(y(v) - 5).toFixed(1)}" text-anchor="middle" font-size="11" fill="${INK}">${Math.round(v)}</text>`);
    }
    out.push(`<text x="${cx.toFixed(1)}" y="${H - B + 18}" text-anchor="middle" font-size="12" font-weight="600" fill="${INK}">${esc(g.label)}</text>`);
  });
  out.push(`<rect x="${L}" y="6" width="12" height="12" fill="${BEFORE}"/><text x="${L + 18}" y="16" font-size="11" fill="${INK}">Antes</text>`);
  out.push(`<rect x="${L + 80}" y="6" width="12" height="12" fill="${AFTER}"/><text x="${L + 98}" y="16" font-size="11" fill="${INK}">Esta execução</text>`);
  out.push("</svg>");
  return out.join("");
}
