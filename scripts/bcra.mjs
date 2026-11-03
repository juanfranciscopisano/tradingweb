// Arma bcra.json con los datos por entidad del BCRA ("Información de entidades financieras", datos abiertos): cada mes
// publica un .7z con TXT de todas las entidades. Corre en GitHub Actions (.github/workflows/bcra.yml).
//
// - Balance histórico (Entfin/Tec_Cont/bal_hist/balhist.txt): saldo de cada cuenta de cada entidad, mes a mes desde julio
//   de 1996, en miles de pesos de cada mes (desde 2020, con ajuste por inflación). De ahí: patrimonio neto (cuentas 4, 5 y 6:
//   patrimonio, resultados y otros resultados integrales), acciones (capital social en circulación y pendiente de emisión,
//   valor nominal $1), activo, intangibles y el resultado acumulado de cada ejercicio.
// - Indicadores (Entfin/Tec_Cont/indicad) de cada archivo mensual desde julio de 2011: mora, previsiones, capital, ROE; cada
//   archivo trae cinco fechas (dos cierres y los últimos tres meses), así que alcanza con uno de cada tres.
// - Inflación para antes de 2017 (los balances no tenían ajuste hasta 2020): serie empalmada de INDEC (hasta 2006) y los IPC
//   de CABA, Córdoba y San Luis, encadenada con el IPC nacional del INDEC desde diciembre de 2016 (indec.json).
//
//   MODO=diario (por defecto): si el BCRA publicó un mes nuevo, rearma con ese archivo. MODO=historia: también los
//   indicadores de todos los archivos desde 2011. MODO=diagnostico: qué traen los archivos, solo en el log.
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION = 1;
// cambia cuando cambia cómo se calcula algo: la corrida diaria rearma los balances aunque no haya un mes nuevo
export const REV = 4;
export const BASE = "https://www.bcra.gob.ar/archivos/Pdfs/PublicacionesEstadisticas/Entidades/";
export const FECHAS = "https://www.bcra.gob.ar/api/endpoints/informacion-entidades.php?action=fechas&lang=es";
export const IPC_HIST = "https://raw.githubusercontent.com/matuteiglesias/IPC-Argentina/main/data/info/indice_precios_M.csv";
const UA = "Mozilla/5.0 (tradingweb; datos de bancos)";
// las entidades de la pestaña Bancos con su código del BCRA; AAA00 es el total del sistema financiero
export const ENT = {
  "00007": { corto: "Galicia", ticker: "GGAL" }, "00285": { corto: "Macro", ticker: "BMA" }, "00017": { corto: "BBVA", ticker: "BBAR" },
  "00027": { corto: "Supervielle", ticker: "SUPV" }, "00034": { corto: "Patagonia", ticker: "BPAT" }, "00044": { corto: "Hipotecario", ticker: "BHIP" },
  "00198": { corto: "Valores", ticker: "VALO" },
};
export const SISTEMA = "AAA00";
// indicadores que se guardan: clave y cómo empieza la descripción en el archivo
export const INDICADORES = [
  ["mora", /^A9 /], ["moraPriv", /^A11 /], ["moraCons", /^A16 /], ["moraCom", /^A17 /], ["cobertura", /^A14 /],
  ["apalanc", /^C1 /], ["roe", /^R1 /], ["roa", /^RG1 /],
];
export const BASE_MES = "199607", BASE_IND = "201105";

// ---- meses "YYYYMM" e índices desde un mes base
export const mesIdx = (m, base) => (+m.slice(0, 4) - +base.slice(0, 4)) * 12 + (+m.slice(4, 6) - +base.slice(4, 6));
export const mesDe = (i, base) => { const t = +base.slice(0, 4) * 12 + (+base.slice(4, 6) - 1) + i; return `${Math.floor(t / 12)}${String(t % 12 + 1).padStart(2, "0")}`; };
const num = s => { const t = String(s ?? "").replace(/"/g, "").trim(); if (!t) return null; const v = parseFloat(/,\d+$/.test(t) && !/\./.test(t) ? t.replace(",", ".") : t); return isFinite(v) ? v : null; };
const sinComillas = s => String(s ?? "").replace(/^"|"$/g, "").trim();

// ---- balance histórico: por entidad y mes, las sumas que hacen falta. Saldos deudores positivos y acreedores negativos
// (activo positivo; pasivo, patrimonio y resultados negativos). intang: códigos de las cuentas de intangibles
export function leerBalhist(texto, codigos, intang = new Set()) {
  const out = {};
  for (const linea of texto.split(/\r?\n/)) {
    if (!linea) continue;
    const c = linea.split("\t"); if (c.length < 4) continue;
    const ent = sinComillas(c[0]); if (!codigos.has(ent)) continue;
    const mes = sinComillas(c[1]), cta = sinComillas(c[2]), v = num(c[3]);
    if (!/^\d{6}$/.test(mes) || !/^\d{6}$/.test(cta) || v == null) continue;
    const e = (out[ent] ??= {}), x = (e[mes] ??= { activo: 0, pasivo: 0, pn: 0, res: 0, ori: 0, acc: 0, cartera: 0, intang: 0, rna: 0 });
    const d = cta[0];
    if (d === "1" || d === "2") x.activo += v;
    else if (d === "3") x.pasivo += v;
    else if (d === "4") { x.pn += v; if (cta === "410003" || cta === "410009") x.acc += v; if (cta === "410006") x.cartera += v; if (cta.startsWith("45")) x.rna += v; }
    else if (cta.startsWith("65")) x.ori += v;
    else if (d === "5" || d === "6") x.res += v;
    if (intang.has(cta)) x.intang += v;
  }
  return out;
}
// series mensuales de una entidad desde el mes base (miles de pesos; patrimonio y resultado con su signo natural)
export function serieEntidad(meses, base, hasta) {
  const n = mesIdx(hasta, base) + 1, z = () => new Array(n).fill(null);
  const s = { pn: z(), acciones: z(), activo: z(), intang: z(), resEj: z(), rna: z(), descuadre: 0 };
  for (const [m, x] of Object.entries(meses)) {
    const i = mesIdx(m, base); if (i < 0 || i >= n) continue;
    s.pn[i] = Math.round(-(x.pn + x.res + x.ori)); s.acciones[i] = Math.round(-x.acc); s.activo[i] = Math.round(x.activo);
    s.intang[i] = Math.round(x.intang); s.resEj[i] = Math.round(-x.res); s.rna[i] = Math.round(-x.rna);
    // activo = pasivo + patrimonio: lo que no cierra, en proporción del activo
    const d = Math.abs(x.activo + x.pasivo + x.pn + x.res + x.ori) / Math.max(1, Math.abs(x.activo));
    if (d > s.descuadre) s.descuadre = d;
  }
  return s;
}
// cierres de ejercicio, en junio o diciembre (los bancos que cerraban en junio pasaron a diciembre en 1998-2002). Dos señales:
// que el resultado acumulado vuelva a empezar al mes siguiente (cambie de signo o quede en menos de 60%) y que pase a
// resultados no asignados (que suban en lo mismo). En el mes de cierre de la entidad alcanza con una; en junio, para los
// ejercicios viejos, hacen falta las dos (un resultado chico de junio no es un cierre)
export function cierres(s, base, mesCierre = 12) {
  const out = [];
  for (let i = 1; i < s.resEj.length; i++) {
    const a = s.resEj[i - 1], b = s.resEj[i], ra = s.rna[i - 1], rb = s.rna[i], mes = +mesDe(i - 1, base).slice(4, 6);
    if (a == null || b == null || !a || (mes !== 12 && mes !== 6 && mes !== mesCierre)) continue;
    const vuelve = Math.sign(b) !== Math.sign(a) || Math.abs(b) < 0.6 * Math.abs(a);
    const salto = ra != null && rb != null ? rb - ra : null;
    const pasaARna = salto != null && Math.abs(salto - a) <= 0.25 * Math.abs(a) + 0.002 * Math.abs(s.pn[i] || 0);
    if (mes === mesCierre ? (vuelve || pasaARna) : (vuelve && pasaARna)) out.push(i - 1);
  }
  return out;
}
// resultado y ROE de cada ejercicio: resultado acumulado al cierre / promedio del patrimonio al cierre anterior y a este,
// anualizado si el ejercicio no tuvo 12 meses
export function ejercicios(s, base, idx) {
  const out = [];
  for (let k = 1; k < idx.length; k++) {
    const i0 = idx[k - 1], i1 = idx[k], meses = i1 - i0;
    if (meses < 6 || meses > 18) continue;
    const ni = s.resEj[i1], p0 = s.pn[i0], p1 = s.pn[i1];
    if (ni == null || !(p0 > 0) || !(p1 > 0)) continue;
    const prom = (p0 + p1) / 2;
    out.push({ fin: mesDe(i1, base), meses, res: ni, pnProm: Math.round(prom), roe: +(ni / prom * 12 / meses * 100).toFixed(2) });
  }
  return out;
}

// ---- indicadores de un archivo mensual: las cinco fechas de cada entidad salen de entidad/COMPLETO.TXT
export function fechasEntidades(texto) {
  const out = {};
  for (const l of texto.split(/\r?\n/)) {
    const c = l.split("\t"); if (c.length < 17) continue;
    const ent = sinComillas(c[0]), f = c.slice(12, 17).map(sinComillas);
    if (f.some(x => /^\d{6}$/.test(x)) && f.every(x => /^\d{6}$/.test(x) || x === "")) out[ent] = { fechas: f, cierre: num(c[5]), nombre: sinComillas(c[1]) };
  }
  return out;
}
// ent -> clave -> { mes: valor }. El sistema: sus propias filas si el archivo las trae y, si no, la columna del sistema
// financiero de las filas de cada entidad, que es la de su última fecha
export function leerIndicad(texto, fechas, codigos) {
  const out = {}, colSis = {};
  // los agregados (AAA00, AA910...) no están en el archivo de entidades: llevan las fechas más comunes
  const cuenta = {}; for (const x of Object.values(fechas)) { const k = x.fechas.join(","); cuenta[k] = (cuenta[k] || 0) + 1; }
  const modal = Object.entries(cuenta).sort((a, b) => b[1] - a[1])[0]?.[0]?.split(",") || null;
  for (const l of texto.split(/\r?\n/)) {
    const c = l.split("\t"); if (c.length < 10) continue;
    const ent = sinComillas(c[0]), desc = sinComillas(c[4]);
    const ind = INDICADORES.find(([, re]) => re.test(desc)); if (!ind) continue;
    const f = fechas[ent]?.fechas || (/^AA/.test(ent) ? modal : null);
    if (codigos.has(ent) && f) {
      const o = ((out[ent] ??= {})[ind[0]] ??= {});
      for (let k = 0; k < 5; k++) { const v = num(c[5 + k]); if (f[k] && v != null) o[f[k]] = v; }
    }
    const sis = num(c[12]), ult = (f || []).filter(Boolean).at(-1);
    if (!/^AA/.test(ent) && sis != null && ult) { const o = (colSis[ind[0]] ??= {}); if (o[ult] == null) o[ult] = sis; }
  }
  if (!out[SISTEMA] && Object.keys(colSis).length) out[SISTEMA] = colSis;
  return out;
}
// une los indicadores de varios archivos en series mensuales (los archivos que van después pisan a los anteriores)
export function unirIndicadores(lista, base, hasta) {
  const n = mesIdx(hasta, base) + 1, out = {};
  for (const x of lista) for (const [ent, o] of Object.entries(x)) for (const [k, porMes] of Object.entries(o)) {
    const a = ((out[ent] ??= {})[k] ??= new Array(n).fill(null));
    for (const [m, v] of Object.entries(porMes)) { const i = mesIdx(m, base); if (i >= 0 && i < n) a[i] = v; }
  }
  return out;
}

// ---- ROE real de cada ejercicio. Desde 2020 y en 2002 los balances vienen en moneda de cada mes (ajuste por inflación):
// el resultado ya es real y va sobre el patrimonio promedio de los meses del ejercicio llevado a moneda del cierre con el
// IPC. Los demás años son nominales: ROE real = (1 + ROE) / (1 + inflación de esos meses) − 1
export const ajustePorInflacion = fin => fin >= "202001" || fin.startsWith("2002");
export function roeReales(entidades, ipc) {
  for (const e of Object.values(entidades)) for (const x of e.ejercicios) {
    const fin = mesIdx(x.fin, ipc.m0), ini = fin - x.meses, a = ipc.v[ini], b = ipc.v[fin];
    if (!(ini >= 0 && a > 0 && b > 0)) continue;
    const pi = Math.pow(b / a, 12 / x.meses) - 1; x.inflacion = +(pi * 100).toFixed(2);
    if (!ajustePorInflacion(x.fin)) { x.roeReal = +(((1 + x.roe / 100) / (1 + pi) - 1) * 100).toFixed(2); continue; }
    const fe = mesIdx(x.fin, BASE_MES); let suma = 0, n = 0;
    for (let k = fe - x.meses + 1; k <= fe; k++) {
      const pn = e.pn?.[k], ik = ipc.v[mesIdx(mesDe(k, BASE_MES), ipc.m0)];
      if (pn > 0 && ik > 0) { suma += pn * b / ik; n++; }
    }
    if (n >= 0.75 * x.meses) { x.ajustado = true; x.pnPromReal = Math.round(suma / n); x.roeReal = +(x.res / (suma / n) * 12 / x.meses * 100).toFixed(2); }
  }
  return entidades;
}

// ---- inflación: la serie empalmada (CSV: fecha, log, índice, ...) hasta noviembre de 2016 y el IPC nacional del INDEC
// desde diciembre de 2016, en un solo índice mensual desde enero de 2000
export function ipcHistorico(csv, indec) {
  const hist = new Map();
  for (const l of String(csv).split(/\r?\n/).slice(1)) { const c = l.split(","), m = (c[0] || "").match(/^(\d{4})-(\d{2})/), v = parseFloat(c[2]); if (m && v > 0) hist.set(m[1] + m[2], v); }
  const I = indec?.datos?.ipc_nacional, s = (I?.series || []).find(x => /^nacional$/i.test(x.region || "") && /nivel general/i.test(x.descripcion || ""));
  const nac = new Map();
  if (s && I.d0) { const [y0, m0] = I.d0.split("-").map(Number); s.v.forEach((v, i) => { if (v > 0) { const t = y0 * 12 + m0 - 1 + i; nac.set(`${Math.floor(t / 12)}${String(t % 12 + 1).padStart(2, "0")}`, v); } }); }
  const ancla = "201612";
  if (!hist.has(ancla) || !nac.has(ancla)) return null;
  const k = nac.get(ancla) / hist.get(ancla), base = "200001", fin = [...nac.keys()].sort().at(-1);
  const v = [];
  for (let i = 0; i <= mesIdx(fin, base); i++) { const m = mesDe(i, base); v.push(m < ancla ? (hist.has(m) ? +(hist.get(m) * k).toFixed(4) : null) : (nac.get(m) ?? null)); }
  return { m0: base, v };
}

// ---- red y archivos
async function bajar(fetchImpl, url, dest) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(300000) });
      if (r.status === 404) return 0;
      if (!r.ok) throw new Error("HTTP " + r.status);
      const b = Buffer.from(await r.arrayBuffer()); await writeFile(dest, b); return b.length;
    } catch (e) { if (a >= 2) throw e; await new Promise(res => setTimeout(res, 3000 * (a + 1))); }
  }
}
// saca del .7z las carpetas pedidas (sin distinguir mayúsculas) y busca adentro un archivo por el final de su ruta
function extraer(archivo, destino, rutas) {
  try { execFileSync("7z", ["x", "-y", "-ssc-", "-o" + destino, archivo, ...rutas], { stdio: "ignore", maxBuffer: 1 << 26 }); } catch (e) { /* alguna ruta no está */ }
}
function buscar(destino, sufijo) {
  const p = execFileSync("bash", ["-c", `find "${destino}" -type f | grep -i -E '${sufijo}$' | head -1`], { encoding: "utf8" }).trim();
  return p || null;
}
const leer = p => p ? readFileSync(p, "latin1") : "";

// MODO=diagnostico: qué hay adentro de algunos archivos (MESES=201107,202004), solo en el log
async function diagnostico({ fetchImpl, log, meses }) {
  const fechas = await fetchImpl(FECHAS, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(60000) }).then(r => r.json());
  const lista = (fechas?.data?.fechas || []).map(x => x.value).filter(v => /^\d{6}$/.test(v)).sort();
  const faltan = []; for (let i = 0; i <= mesIdx(lista.at(-1), lista[0]); i++) { const m = mesDe(i, lista[0]); if (!lista.includes(m)) faltan.push(m); }
  log(`lista del BCRA: ${lista.length} meses, ${lista.slice(0, 3).join(" ")} … ${lista.slice(-2).join(" ")}; faltan ${faltan.join(" ") || "ninguno"}`);
  const dir = await mkdtemp(join(tmpdir(), "bcra-d-"));
  for (const m of meses) {
    const f = join(dir, m + ".7z");
    let tam = 0;
    try { tam = await bajar(fetchImpl, BASE + m + "d.7z", f); } catch (e) { log(`${m}: ${e.message}`); continue; }
    if (!tam) { log(`${m}: no está (404)`); continue; }
    const cab = readFileSync(f).subarray(0, 8).toString("hex");
    let txt = "";
    try { txt = execFileSync("7z", ["l", "-ba", "-slt", f], { encoding: "latin1", maxBuffer: 1 << 28 }); } catch (e) { txt = "7z falló: " + String(e.stdout || e.message).slice(0, 400); }
    const rutas = [...txt.matchAll(/^Path = (.*)$/gm)].map(x => x[1]);
    log(`${m}: ${(tam / 1e6).toFixed(1)} MB, cabecera ${cab}, ${rutas.length} archivos${rutas.length ? "" : "; " + txt.slice(0, 300).replace(/\s+/g, " ")}`);
    const ind = rutas.filter(r => /Tec_Cont\/indicad\//i.test(r)), ent = rutas.filter(r => /Tec_Cont\/entidad\//i.test(r));
    log(`  indicad: ${ind.length} archivos (${ind.slice(0, 8).map(r => r.split("/").pop()).join(" ")}); entidad: ${ent.length} (${ent.filter(r => !/\/\d{5}\.txt$/i.test(r)).slice(0, 6).map(r => r.split("/").pop()).join(" ")}); bal_hist: ${rutas.filter(r => /bal_?hist/i.test(r)).map(r => r.split("/").pop()).join(" ") || "no"}`);
    const d = join(dir, m); extraer(f, d, ["Entfin/Tec_Cont/entidad/*", "Entfin/Tec_Cont/indicad/*", "*/Entfin/Tec_Cont/entidad/*", "*/Entfin/Tec_Cont/indicad/*"]);
    const ti = leer(buscar(d, "indicad/completo\\.txt")), te = leer(buscar(d, "entidad/completo\\.txt"));
    const li = ti.split(/\r?\n/).filter(Boolean), le = te.split(/\r?\n/).filter(Boolean);
    log(`  indicad/completo: ${li.length} líneas; ${li.filter(l => /^"?AAA00/.test(l)).length} del sistema; primera: ${JSON.stringify(li[0] || "").slice(0, 260)}`);
    log(`    Galicia: ${li.filter(l => /^"?00007"?\t/.test(l)).map(l => { const c = l.split("\t"); return sinComillas(c[4]) + " [" + c.slice(5, 13).join(" ") + "]"; }).join(" | ")}`);
    log(`    grupos en indicad: ${ind.filter(r => /\/AA[^/]*$/i.test(r)).map(r => r.split("/").pop()).join(" ") || "ninguno"}; en entidad/completo: ${le.filter(l => /^"?AA/.test(l)).map(l => { const c = l.split("\t"); return sinComillas(c[0]) + " " + sinComillas(c[1]); }).join(", ") || "ninguno"}`);
    const aa = buscar(d, "indicad/aa000\\.txt"); if (aa) log(`    AA000: ${JSON.stringify(leer(aa).split(/\r?\n/).slice(0, 2).join(" // ")).slice(0, 400)}`);
    log(`  entidad/completo: ${le.length} líneas; Galicia: ${JSON.stringify(le.find(l => /^"?00007"?\t/.test(l)) || "").slice(0, 300)}`);
    const fe = fechasEntidades(te), x = leerIndicad(ti, fe, new Set(["00007", SISTEMA]));
    log(`  leído: Galicia ${Object.entries(x["00007"] || {}).map(([k, o]) => k + " " + Object.keys(o).join("/")).slice(0, 3).join(", ") || "—"}; sistema ${Object.entries(x[SISTEMA] || {}).map(([k, o]) => k + " " + Object.keys(o).length).join(", ") || "—"}`);
    await rm(d, { recursive: true, force: true });
    await rm(f, { force: true });
  }
  await rm(dir, { recursive: true, force: true });
  return null;
}

export async function main({ fetchImpl = globalThis.fetch, root = new URL("../", import.meta.url), now = new Date(), log = console.log, modo = process.env.MODO || "diario" } = {}) {
  if (modo === "diagnostico") return diagnostico({ fetchImpl, log, meses: (process.env.MESES || "201107,201410,201704,201707,202004,202010,202101").split(",") });
  let prev = null;
  try { prev = JSON.parse(await readFile(new URL("bcra.json", root), "utf8")); } catch (e) { /* primera vez */ }
  const fechas = await fetchImpl(FECHAS, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(60000) }).then(r => r.json());
  const meses = (fechas?.data?.fechas || []).map(x => x.value).filter(v => /^\d{6}$/.test(v)).sort();
  const ult = meses.at(-1);
  if (!ult) throw new Error("el BCRA no devolvió la lista de meses");
  if (modo === "diario" && prev?.mes === ult && prev?.version === VERSION && prev?.rev === REV) { log(`bcra.json ya tiene ${ult}`); return prev; }
  const dir = await mkdtemp(join(tmpdir(), "bcra-")), codigos = new Set(Object.keys(ENT)), conSistema = new Set([...codigos, SISTEMA]);
  // el último archivo: balance histórico, plan de cuentas, datos de las entidades e indicadores
  const f = join(dir, ult + ".7z"), tam = await bajar(fetchImpl, BASE + ult + "d.7z", f);
  if (!tam) throw new Error(`no está ${ult}d.7z`);
  log(`${ult}d.7z: ${(tam / 1e6).toFixed(1)} MB`);
  const dUlt = join(dir, ult);
  extraer(f, dUlt, ["Entfin/Tec_Cont/bal_hist/*", "Entfin/Tec_Cont/cuentas/*", "Entfin/Tec_Cont/entidad/*", "Entfin/Tec_Cont/indicad/*"]);
  await rm(f, { force: true });
  // intangibles: las cuentas del activo que lo dicen en el plan de cuentas
  const intang = new Set();
  for (const l of leer(buscar(dUlt, "cuentas/cuentas\\.txt")).split(/\r?\n/)) { const c = l.split("\t"), cod = sinComillas(c[0]), d = sinComillas(c[1]); if (/^[12]\d{5}$/.test(cod) && /INTANG|LLAVE DE NEG/i.test(d)) intang.add(cod); }
  log(`cuentas de intangibles: ${[...intang].sort().join(" ") || "ninguna"}`);
  // del balance histórico, solo las líneas de nuestras entidades
  const bh = buscar(dUlt, "bal_hist/balhist\\.txt");
  if (!bh) throw new Error("el archivo no trae el balance histórico");
  const filtrado = execFileSync("bash", ["-c", `grep -a -E '^"?(${[...codigos].join("|")})"?\t' "${bh}" || true`], { encoding: "latin1", maxBuffer: 1 << 30 });
  const bal = leerBalhist(filtrado, codigos, intang);
  const fUlt = fechasEntidades(leer(buscar(dUlt, "entidad/completo\\.txt")));
  const entidades = {};
  for (const [cod, info] of Object.entries(ENT)) {
    const m = bal[cod]; if (!m) { log(`${cod}: sin balance histórico`); continue; }
    const s = serieEntidad(m, BASE_MES, ult), mesCierre = fUlt[cod]?.cierre || 12, ci = cierres(s, BASE_MES, mesCierre), ej = ejercicios(s, BASE_MES, ci);
    entidades[cod] = { n: fUlt[cod]?.nombre || info.corto, ...info, cierre: mesCierre, pn: s.pn, acciones: s.acciones, activo: s.activo, intang: s.intang, resEj: s.resEj, ejercicios: ej };
    const p0 = s.pn.findIndex(v => v != null);
    log(`${cod} ${info.corto}: desde ${mesDe(p0, BASE_MES)}; patrimonio ${s.pn.at(-1)} miles; acciones ${s.acciones.at(-1)} miles; intangibles ${s.intang.at(-1)}; descuadre máximo ${(s.descuadre * 100).toFixed(3)}% del activo; ${ci.length} cierres (${ci.slice(0, 4).map(i => mesDe(i, BASE_MES)).join(" ")} … ${ci.slice(-2).map(i => mesDe(i, BASE_MES)).join(" ")}); ROE ${ej.filter(e => /^(2000|2001|2002|2005|2010|2015|2019|2024|2025)/.test(e.fin)).map(e => e.fin + " " + e.roe + "%").join(", ")}`);
  }
  // indicadores: uno de cada tres archivos desde julio de 2011 (historia) o el último (diario)
  const deCarpeta = d => leerIndicad(leer(buscar(d, "indicad/completo\\.txt")), fechasEntidades(leer(buscar(d, "entidad/completo\\.txt"))), conSistema);
  const lista = [];
  const pedidos = modo === "historia" ? meses.filter(m => m >= "201107" && mesIdx(ult, m) % 3 === 0) : [ult];
  for (const m of pedidos) {
    try {
      let d = dUlt;
      if (m !== ult) {
        const fm = join(dir, m + ".7z");
        if (!(await bajar(fetchImpl, BASE + m + "d.7z", fm))) { log(`${m}: no está`); continue; }
        d = join(dir, m); extraer(fm, d, ["Entfin/Tec_Cont/entidad/*", "Entfin/Tec_Cont/indicad/*"]); await rm(fm, { force: true });
      }
      const x = deCarpeta(d);
      log(`${m}: indicadores de ${Object.keys(x).length} entidades; Galicia ${Object.entries(x["00007"] || {}).map(([k, o]) => k + " " + Object.keys(o).length).join(", ") || "—"}; sistema ${Object.keys(x[SISTEMA] || {}).length}`);
      lista.push(x);
      if (m !== ult) await rm(d, { recursive: true, force: true });
    } catch (e) { log(`${m}: ${e.message}`); }
  }
  // en diario se suman a lo que ya había (lo nuevo pisa)
  const desdePrev = (prev && modo !== "historia" && prev.ind && prev.i0) ? [Object.fromEntries(Object.entries(prev.ind).map(([ent, o]) => [ent, Object.fromEntries(Object.entries(o).map(([k, a]) => [k, Object.fromEntries(a.map((v, i) => [mesDe(i, prev.i0), v]).filter(([, v]) => v != null))]))]))] : [];
  const ind = unirIndicadores([...desdePrev, ...lista], BASE_IND, ult);
  // inflación anterior a 2017
  let ipc = prev?.ipc || null;
  try {
    const csv = await fetchImpl(IPC_HIST, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) }).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
    const x = ipcHistorico(csv, JSON.parse(await readFile(new URL("indec.json", root), "utf8")));
    if (x) ipc = { ...x, fuente: "hasta noviembre de 2016, serie empalmada de INDEC (hasta 2006) y los IPC de CABA, Córdoba y San Luis (matuteiglesias/IPC-Argentina en GitHub); desde diciembre de 2016, IPC nacional del INDEC" };
    else log("inflación: no se pudo encadenar (falta diciembre de 2016)");
  } catch (e) { log("inflación: " + e.message); }
  if (ipc) roeReales(entidades, ipc);
  const out = { version: VERSION, rev: REV, asOf: now.toISOString(), mes: ult, m0: BASE_MES, i0: BASE_IND, fuente: "BCRA, Información de entidades financieras (datos abiertos)", entidades, ind, ipc };
  await writeFile(new URL("bcra.json", root), JSON.stringify(out));
  log(`bcra.json: ${Object.keys(entidades).length} entidades, balances desde ${BASE_MES}, indicadores desde ${BASE_IND} hasta ${ult}; sistema: ${Object.entries(ind[SISTEMA] || {}).map(([k, a]) => k + " " + a.filter(v => v != null).length).join(", ")}`);
  await rm(dir, { recursive: true, force: true });
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch(e => { console.error(e); process.exit(1); });
