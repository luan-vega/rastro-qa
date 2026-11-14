// Validação e máscara de CPF e CNPJ (inclui o CNPJ alfanumérico da Receita, a partir de jul/2026).

export function cpfValido(cpf: string): boolean {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === +d[9] && dv(10) === +d[10];
}

export function cnpjValido(cnpj: string): boolean {
  const c = cnpj.toUpperCase().replace(/[.\/-]/g, "");
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || /^(.)\1{13}$/.test(c)) return false;
  const v = (ch: string) => ch.charCodeAt(0) - 48;
  const dv = (n: number) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = pesos.reduce((s, p, i) => s + v(c[i]) * p, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === +c[12] && dv(13) === +c[13];
}

const CPF_RE = /\b(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})\b/g;
const CNPJ_RE = /\b([0-9A-Z]{2})\.?([0-9A-Z]{3})\.?([0-9A-Z]{3})\/?([0-9A-Z]{4})-?(\d{2})\b/g;

export function mascararCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, "");
  return `${d.slice(0, 3)}.***.***-${d.slice(9)}`;
}

export function mascararCnpj(cnpj: string): string {
  const c = cnpj.toUpperCase().replace(/[.\/-]/g, "");
  return `${c.slice(0, 2)}.***.***/${c.slice(8, 12)}-${c.slice(12)}`;
}

/** Mascara CPFs e CNPJs válidos que aparecerem dentro de um texto livre. */
export function mascararDocumentosNoTexto(texto: string): string {
  return texto
    .replace(CNPJ_RE, (m) => (cnpjValido(m) ? mascararCnpj(m) : m))
    .replace(CPF_RE, (m) => (cpfValido(m) ? mascararCpf(m) : m));
}
