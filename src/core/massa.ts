import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { cnpjValido, cpfValido, mascararCnpj, mascararCpf } from "./documentos.js";
import { SetupError } from "./errors.js";

export type Massa = Record<string, any>;

export interface MassaProblema { caminho: string; valor: string; motivo: string }

export async function loadMassa(root: string, file: string): Promise<Massa> {
  const abs = join(root, file);
  if (!existsSync(abs)) return {};
  return (YAML.parse(await readFile(abs, "utf8")) ?? {}) as Massa;
}

/** Procura campos cpf/cnpj (em qualquer nível) e confere os dígitos verificadores. */
export function validarMassa(massa: Massa): MassaProblema[] {
  const problemas: MassaProblema[] = [];
  const visit = (v: unknown, caminho: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${caminho}[${i}]`));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const p = caminho ? `${caminho}.${k}` : k;
        const key = k.toLowerCase();
        if (key === "cpf" && typeof x === "string" && !cpfValido(x)) problemas.push({ caminho: p, valor: x, motivo: "CPF com dígito verificador inválido" });
        else if (key === "cnpj" && typeof x === "string" && !cnpjValido(x)) problemas.push({ caminho: p, valor: x, motivo: "CNPJ com dígito verificador inválido" });
        else visit(x, p);
      }
    }
  };
  visit(massa, "");
  return problemas;
}

/** Todos os documentos (CPF/CNPJ) da massa, normalizados, para o guarda da IA. */
export function documentosDaMassa(massa: Massa): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown, key = "") => {
    if (Array.isArray(v)) return v.forEach((x) => visit(x));
    if (v && typeof v === "object") return Object.entries(v).forEach(([k, x]) => visit(x, k.toLowerCase()));
    if ((key === "cpf" || key === "cnpj") && typeof v === "string") out.add(v.toUpperCase().replace(/[.\/-]/g, ""));
  };
  visit(massa);
  return out;
}

export function exigirMassa(massa: Massa, nomes: string[]): void {
  const faltando = nomes.filter((n) => !(n in massa));
  if (faltando.length) {
    throw new SetupError(`Registros de massa não encontrados: ${faltando.join(", ")}`, "Preencha o arquivo de massa (massa/hml.yaml) com dados fictícios", "massa");
  }
  const problemas = validarMassa(Object.fromEntries(nomes.map((n) => [n, massa[n]])));
  if (problemas.length) {
    throw new SetupError(`Massa inválida: ${problemas.map((p) => `${p.caminho} (${p.motivo})`).join("; ")}`, undefined, "massa");
  }
}

/** Linhas de massa usadas no PDF, com documentos mascarados. */
export function resumoMassa(massa: Massa, nomes: string[]): { registro: string; nome: string; documento: string }[] {
  return nomes.map((n) => {
    const r = massa[n] ?? {};
    const nome = r.nome ?? r.razaoSocial ?? "";
    const documento = r.cpf ? `CPF ${mascararCpf(r.cpf)}` : r.cnpj ? `CNPJ ${mascararCnpj(r.cnpj)}` : "";
    return { registro: n, nome, documento };
  });
}
