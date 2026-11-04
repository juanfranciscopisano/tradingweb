// Arma empresas.json: P/E y P/BV semana a semana de las 19 acciones del MSCI MERVAL, para el panel del Merval y para
// P/E histórico. Corre en GitHub Actions los días hábiles (.github/workflows/empresas.yml), después de Bancos.
//
// Por empresa y por semana: el precio de cierre, el resultado por acción de 12 meses y el valor libro por acción, los dos
// en la moneda del precio de esa semana. El múltiplo de cada semana es precio / eso.
//   - Las que presentan en pesos (NIC 29 desde 2018): precio de BYMA en pesos. Cada resultado y cada patrimonio está en
//     pesos de su cierre y se lleva a pesos de cada semana con el IPC (indec.json, como en Bancos). El resultado de 12
//     meses es la suma de los cuatro trimestres (cada uno con su IPC) o, si no están, el del último ejercicio.
//   - Las que presentan en dólares (YPF y Pampa): precio del ADR en dólares y resultados en dólares por ADR.
//   - Ternium Argentina (moneda funcional dólar, presenta en pesos al oficial de cada cierre): el balance pasa a dólares
//     con el oficial de su cierre y a pesos de cada semana con el contado con liquidación.
//   - Bancos (Galicia, Macro, BBVA, Supervielle y Valores): de bancos.json (el BCRA desde 2000, los 20-F y Yahoo):
//     valor libro = precio / P/BV y resultado = ROE real × valor libro.
// Fuentes de los resultados y patrimonios: los 20-F de la SEC (NIIF) de las que tienen ADR, los ejercicios y los
// últimos cinco trimestres de Yahoo, y los trimestres cargados a mano de Pampa (backend/data/eps_manual.json). Cada
// balance vale desde su presentación: el plazo de la CNV (42 días el trimestre, 70 el ejercicio) o antes si la SEC lo
// tiene antes. Con MODO=diagnostico solo escribe en el log qué trae cada fuente.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { yahooSession } from "./fundamentals.mjs";
import { ipcDe, weekOf, MONDAY0, yahooSerie, monedaYahoo } from "./bancos.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DAY = 86400, WEEK = 7 * DAY;
const tOf = d => Math.floor(Date.parse(d + "T00:00:00Z") / 1000);
const isoOf = t => new Date(t * 1000).toISOString().slice(0, 10);
const dias = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;
export const VERSION = 1;
export const W_DESDE = weekOf(Date.UTC(2014, 0, 6) / 1000);   // las series que no son de bancos arrancan en 2014
export const MAX_DIAS = 470;   // un resultado o un balance de más de 470 días ya no se usa (el ejercicio siguiente se atrasó)
export const PLAZO = { q: 42, a: 70 };   // días de la CNV para presentar el trimestre y el ejercicio

// las 19 del MSCI MERVAL desde el 19/10/2026 (La Nación, 17/10/2026). px: el precio que se usa (el ADR si los
// resultados están en dólares); ratio: acciones por ADR; sec: el ADR con 20-F en la SEC
export const MERVAL = [
  { s: "YPFD", n: "YPF", adr: "YPF", px: "YPF", moneda: "USD", ratio: 1, sec: "YPF", sector: "Energía" },
  { s: "PAMP", n: "Pampa Energía", adr: "PAM", px: "PAM", moneda: "USD", ratio: 25, sec: "PAM", manual: "PAM", sector: "Energía" },
  { s: "GGAL", n: "Grupo Financiero Galicia", adr: "GGAL", banco: true, sector: "Financiero" },
  { s: "BMA", n: "Banco Macro", adr: "BMA", banco: true, sector: "Financiero" },
  { s: "TGSU2", n: "Transportadora de Gas del Sur", adr: "TGS", sec: "TGS", sector: "Servicios públicos" },
  { s: "CEPU", n: "Central Puerto", adr: "CEPU", sec: "CEPU", sector: "Servicios públicos" },
  { s: "BBAR", n: "BBVA Argentina", adr: "BBAR", banco: true, sector: "Financiero" },
  // BYMA: sin EV/EBITDA, porque su caja incluye las garantías de los participantes (más que su capitalización)
  { s: "BYMA", n: "Bolsas y Mercados Argentinos", sector: "Financiero", sinEV: true },
  // Ternium Argentina tiene el dólar como moneda funcional (presenta en pesos al tipo de cambio de cada cierre): su
  // patrimonio en dólares da 4,75, 4,33, 4,94 y 4,68 mil millones a fin de 2022 a 2025, y en pesos constantes salta
  { s: "TXAR", n: "Ternium Argentina", sector: "Materiales", funcional: "USD" },
  { s: "LOMA", n: "Loma Negra", adr: "LOMA", sec: "LOMA", sector: "Materiales" },
  { s: "CRES", n: "Cresud", adr: "CRESY", sec: "CRESY", sector: "Agro e inmuebles" },
  { s: "EDN", n: "Edenor", adr: "EDN", sec: "EDN", sector: "Servicios públicos" },
  { s: "ALUA", n: "Aluar", sector: "Materiales" },
  { s: "SUPV", n: "Grupo Supervielle", adr: "SUPV", banco: true, sector: "Financiero" },
  { s: "VALO", n: "Banco de Valores", banco: true, sector: "Financiero" },
  { s: "TRAN", n: "Transener", sector: "Servicios públicos" },
  { s: "ECOG", n: "Ecogas Inversiones", sector: "Servicios públicos" },
  { s: "TGNO4", n: "Transportadora de Gas del Norte", sector: "Servicios públicos" },
  { s: "METR", n: "Metrogas", sector: "Servicios públicos" },
];
// fuera del índice, solo para el P/BV de P/E histórico de los que tienen el EPS cargado a mano
export const EXTRA = [{ s: "NU", n: "Nu Holdings", px: "NU", moneda: "USD", ratio: 1, sec: "NU", manual: "NU" }];

// ---- observaciones: { end, tipo: "q" (trimestre) | "a" (ejercicio) | "t" (12 meses), val, c (fecha de la moneda),
// pub (segundos), sh (acciones, ya por ADR si el precio es el ADR), src }
const pubDe = (end, tipo, hoyS, filed = null) => {
  const p = tOf(end) + PLAZO[tipo === "q" ? "q" : "a"] * DAY, f = filed ? tOf(filed) : Infinity;
  return Math.min(p, f >= tOf(end) ? f : Infinity, hoyS);
};
const anual = (a, b) => { const d = dias(a, b); return d >= 350 && d <= 380; };

// 20-F (NIIF): resultado y patrimonio de los propietarios de la controladora por ejercicio, en la primera presentación
// (lo que se supo entonces). En pesos, cada uno está en moneda del cierre del 20-F en que salió (los comparativos de
// los 20-F con NIC 29, desde el ejercicio 2018, vienen reexpresados a ese cierre; antes, en pesos de su fecha)
export function desdeSec(facts, { unidad = "ARS", hoyS = Infinity } = {}) {
  const f = facts?.facts?.["ifrs-full"] || {}, dei = facts?.facts?.dei || {};
  const first = (arr, key) => {
    const m = new Map();
    for (const e of arr) { const k = key(e), p = m.get(k); if (!p || (e.filed || "") < (p.filed || "")) m.set(k, e); }
    return [...m.values()];
  };
  // cierre de cada presentación: el más reciente de sus saldos y resultados (Cresud presentó el 20-F de 2024 sin el patrimonio)
  const finDe = new Map();
  for (const t of ["EquityAttributableToOwnersOfParent", "Equity", "ProfitLossAttributableToOwnersOfParent", "ProfitLoss"]) for (const e of f[t]?.units?.[unidad] || []) if (e.end && e.accn && !(finDe.get(e.accn) >= e.end)) finDe.set(e.accn, e.end);
  const moneda = e => unidad !== "ARS" || (e.filed || "") < "2018-09-01" ? e.end : (finDe.get(e.accn) || e.end);
  // patrimonio de los propietarios; sin esa etiqueta, el total menos los minoritarios (si no están, el total)
  const eqA = (f.EquityAttributableToOwnersOfParent?.units?.[unidad] || []).filter(e => !e.start && isFinite(e.val));
  const eqT = (f.Equity?.units?.[unidad] || []).filter(e => !e.start && isFinite(e.val));
  const nci = (f.NoncontrollingInterests?.units?.[unidad] || []).filter(e => !e.start && isFinite(e.val));
  const eq = [], ends = new Set();
  for (const e of first(eqA, e => e.end)) { eq.push({ end: e.end, val: e.val, c: moneda(e), pub: pubDe(e.end, "a", hoyS, e.filed), src: "SEC 20-F", tag: "atribuible" }); ends.add(e.end); }
  for (const e of first(eqT, e => e.end)) {
    if (ends.has(e.end)) continue;
    const m = nci.filter(x => x.end === e.end && x.accn === e.accn)[0];
    eq.push({ end: e.end, val: e.val - (m ? m.val : 0), c: moneda(e), pub: pubDe(e.end, "a", hoyS, e.filed), src: "SEC 20-F", tag: m ? "total − minoritarios" : "total" });
  }
  const niTag = f.ProfitLossAttributableToOwnersOfParent?.units?.[unidad] ? "ProfitLossAttributableToOwnersOfParent" : "ProfitLoss";
  // la primera presentación con escala creíble: TGS cargó 2018 a 2020 en miles sin escalar (11,4 millones en vez de 11.400);
  // un resultado de menos de 0,05% del patrimonio del mismo 20-F se descarta y vale el de la presentación siguiente
  const eqDe = new Map(); for (const e of [...eqA, ...eqT]) eqDe.set(e.accn + "|" + e.end, e.val);
  const creible = e => { const q = eqDe.get(e.accn + "|" + e.end); return !(q > 0) || e.val === 0 || Math.abs(e.val / q) >= 0.0005; };
  const porPeriodo = new Map();
  for (const e of (f[niTag]?.units?.[unidad] || []).filter(e => e.start && e.end && isFinite(e.val) && anual(e.start, e.end))) { const k = e.start + e.end; if (!porPeriodo.has(k)) porPeriodo.set(k, []); porPeriodo.get(k).push(e); }
  const ni = [];
  for (const arr of porPeriodo.values()) {
    const e = arr.sort((a, b) => (a.filed || "").localeCompare(b.filed || "")).find(creible);
    if (e) ni.push({ end: e.end, tipo: "a", val: e.val, c: moneda(e), pub: pubDe(e.end, "a", hoyS, e.filed), src: "SEC 20-F", accn: e.accn });
  }
  // acciones de cada ejercicio: las de la tapa (dei) cerca del cierre, el promedio ponderado o resultado / EPS
  const cand = end => {
    const out = [];
    for (const e of dei.EntityCommonStockSharesOutstanding?.units?.shares || []) if (Math.abs(dias(end, e.end)) <= 130 && e.val > 1e6) out.push(e.val);
    for (const t of ["WeightedAverageShares", "AdjustedWeightedAverageShares"]) for (const e of f[t]?.units?.shares || []) if (e.start && e.end === end && anual(e.start, e.end) && e.val > 1e6) out.push(e.val);
    const n = ni.find(x => x.end === end), eps = (f.BasicEarningsLossPerShare?.units?.[unidad + "/shares"] || []).find(e => e.end === end && e.start && anual(e.start, e.end) && e.val && n && e.accn === n.accn);
    if (n && eps && n.val / eps.val > 1e6) out.push(Math.abs(n.val / eps.val));
    return out;
  };
  return { ni: ni.sort((a, b) => a.end.localeCompare(b.end)), eq: eq.sort((a, b) => a.end.localeCompare(b.end)), cand };
}

// Yahoo: trimestres en pesos de su cierre; ejercicios en moneda del ejercicio siguiente (comparativos) y el último en la
// suya (monedaYahoo, de Bancos); 12 meses: la suma nominal de los cuatro trimestres que publica Yahoo
export function desdeYahoo(ys, { hoyS = Infinity, acc = "OrdinarySharesNumber" } = {}) {
  const fin = Object.keys(ys.a).sort().pop();
  const bvDe = o => o.CommonStockEquity ?? o.StockholdersEquity;
  const sh = o => (o[acc] > 0 ? o[acc] : null);
  const ni = [], eq = [];
  for (const [end, o] of Object.entries(ys.q)) {
    if (isFinite(o.NetIncomeCommonStockholders)) ni.push({ end, tipo: "q", val: o.NetIncomeCommonStockholders, c: end, pub: pubDe(end, "q", hoyS), sh: sh(o), src: "Yahoo trimestral" });
    if (isFinite(bvDe(o))) eq.push({ end, val: bvDe(o), c: end, pub: pubDe(end, "q", hoyS), sh: sh(o), src: "Yahoo trimestral" });
  }
  for (const [end, o] of Object.entries(ys.a)) {
    const c = monedaYahoo(end, fin);
    if (isFinite(o.NetIncomeCommonStockholders)) ni.push({ end, tipo: "a", val: o.NetIncomeCommonStockholders, c, pub: pubDe(end, "a", hoyS), sh: sh(o), src: "Yahoo anual" });
    if (isFinite(bvDe(o))) eq.push({ end, val: bvDe(o), c, pub: pubDe(end, "a", hoyS), sh: sh(o), src: "Yahoo anual" });
  }
  for (const [end, o] of Object.entries(ys.t || {})) if (isFinite(o.NetIncomeCommonStockholders)) ni.push({ end, tipo: "t", val: o.NetIncomeCommonStockholders, c: end, pub: pubDe(end, "q", hoyS), sh: sh(o), src: "Yahoo 12 meses" });
  return { ni, eq };
}

// trimestres cargados a mano (eps_manual.json): resultado en millones y acciones en millones; por ADR con el ratio
export function desdeManual(m, { ratio = 1, hoyS = Infinity } = {}) {
  return (m?.trimestres || []).filter(r => r.fin && isFinite(r.resultado) && r.acciones > 0).map(r => ({
    end: r.fin, tipo: "q", val: r.resultado * 1e6, c: r.fin, sh: r.acciones * 1e6 / ratio,
    pub: Math.min(/^\d{4}-\d\d-\d\d$/.test(r.presentado || "") ? tOf(r.presentado) : tOf(r.fin) + 45 * DAY, hoyS), src: "a mano (6-K)",
  }));
}

// une observaciones: por cierre y tipo manda la primera lista que lo tiene (±10 días)
export function unir(listas) {
  const out = [];
  for (const L of listas) for (const x of L) if (!out.some(y => y.tipo === x.tipo && Math.abs(dias(y.end, x.end)) <= 10)) out.push(x);
  return out.sort((a, b) => a.end.localeCompare(b.end) || a.tipo.localeCompare(b.tipo));
}

// el trimestre que falta de un ejercicio: el ejercicio menos los otros tres (Ternium no tiene el 3T25 en Yahoo). Solo
// con el ejercicio en moneda de su cierre; los otros tres se llevan a esa moneda (conv) y el que falta queda en ella
export function completarTrimestres(ni, conv = () => 1) {
  const q = ni.filter(x => x.tipo === "q"), out = [];
  for (const a of ni.filter(x => x.tipo === "a" && Math.abs(dias(x.c, x.end)) <= 10)) {
    const ini = new Date(tOf(a.end) * 1000); ini.setUTCMonth(ini.getUTCMonth() - 12);
    const dentro = q.filter(x => dias(isoOf(ini.getTime() / 1000), x.end) > 20 && dias(x.end, a.end) >= -10);
    if (dentro.length !== 3) continue;
    // los cuatro cierres trimestrales del ejercicio: el que no está es el que falta
    const cierres = [3, 6, 9, 12].map(k => { const d = new Date(ini.getTime()); d.setUTCMonth(d.getUTCMonth() + k + 1, 0); return isoOf(d.getTime() / 1000); });
    const falta = cierres.find(e => !dentro.some(x => Math.abs(dias(x.end, e)) <= 10));
    if (!falta) continue;
    const tc = tOf(a.c) + DAY - 1;
    out.push({ end: falta, tipo: "q", val: a.val - dentro.reduce((s, x) => s + x.val * conv(x.c, tc), 0), c: a.c, pub: Math.max(a.pub, ...dentro.map(x => x.pub)), sh: a.sh ?? dentro[0].sh, src: "ejercicio menos tres trimestres" });
  }
  return unir([ni, out]);
}

// acciones que faltan: las de la observación más cercana que las tenga (del mismo origen si hay)
export function completarAcciones(lista, otras = []) {
  const con = [...lista, ...otras].filter(x => x.sh > 0);
  for (const x of lista) if (!(x.sh > 0)) {
    const o = con.slice().sort((p, q) => Math.abs(dias(p.end, x.end)) - Math.abs(dias(q.end, x.end)))[0];
    if (o) x.sh = o.sh;
  }
  return lista;
}

// splits: Yahoo da las acciones viejas a veces como se informaron y a veces ya ajustadas (BYMA: 7.625 millones en 2022,
// antes de los splits de 2024 y 2025). Se multiplica por los splits posteriores solo si eso las acerca a las de hoy (ref)
export function ajustarSplits(lista, splits, ref) {
  if (!splits.length || !(ref > 0)) return lista;
  for (const x of lista) {
    if (!(x.sh > 0)) continue;
    const f = splits.filter(s => s.date > tOf(x.end)).reduce((a, s) => a * s.ratio, 1);
    if (f !== 1 && Math.abs(Math.log(x.sh * f / ref)) < Math.abs(Math.log(x.sh / ref))) x.sh *= f;
  }
  return lista;
}
// acciones que saltan más de 12% contra las de los dos lados (a 200 días o menos) que coinciden entre sí: dato malo de
// Yahoo (Pampa, 3T25: 46 millones de ADR con 54 antes y después)
export function limpiarAcciones(lista, otras = []) {
  const todas = [...lista, ...otras].filter(x => x.sh > 0);
  for (const x of lista) {
    if (!(x.sh > 0)) continue;
    const ant = todas.filter(y => y !== x && y.end < x.end && dias(y.end, x.end) <= 200).map(y => y.sh);
    const pos = todas.filter(y => y !== x && y.end > x.end && dias(x.end, y.end) <= 200).map(y => y.sh);
    if (!ant.length || !pos.length) continue;
    const a = ant.at(-1), p = pos[0];
    if (Math.abs(Math.log(a / p)) < 0.05 && Math.abs(Math.log(x.sh / a)) > 0.12 && Math.abs(Math.log(x.sh / p)) > 0.12) x.sh = Math.sqrt(a * p);
  }
  return lista;
}
// precio con un salto de más de 4 veces en una semana sin split (Ecogas pasó de 26.925 a 1.725 al empezar a cotizar):
// lo de antes del último salto no se usa
export function cortarSaltos(price, splits) {
  const ws = [...price.keys()].sort((a, b) => a - b);
  let corte = null;
  for (let i = 1; i < ws.length; i++) {
    const r = price.get(ws[i]) / price.get(ws[i - 1]);
    const conSplit = splits.some(s => Math.abs(weekOf(s.date) - ws[i]) <= 2);
    if (!conSplit && (r > 4 || r < 0.25)) corte = ws[i];
  }
  if (corte != null) for (const w of ws) if (w < corte) price.delete(w);
  return corte;
}
// ¿la empresa tiene el dólar como moneda funcional (presenta en pesos convertidos al tipo de cambio de cada cierre)?
// Ternium Argentina: el patrimonio en dólares (pesos / tipo de cambio del cierre) es casi constante y en pesos
// constantes (IPC) salta con cada devaluación. Se compara qué serie es más pareja: los cambios anuales de cada una
export function monedaFuncional(eq, convIpc, fxAt, hoyS) {
  const o = eq.filter(x => x.end >= "2019-06-30" && x.val > 0).sort((a, b) => a.end.localeCompare(b.end));
  const sd = vals => { const d = []; for (let i = 1; i < vals.length; i++) { const yrs = dias(vals[i - 1][0], vals[i][0]) / 365.25; if (yrs >= 0.2) d.push(Math.log(vals[i][1] / vals[i - 1][1]) / yrs); }
    if (d.length < 2) return null; const m = d.reduce((a, b) => a + b, 0) / d.length; return Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length); };
  // en pesos constantes: cada valor en su moneda (c) llevado a hoy con el IPC; en dólares: el valor en pesos de su
  // cierre (así presenta la que tiene el dólar como moneda funcional) sobre el tipo de cambio de ese día
  const ars = sd(o.map(x => [x.end, x.val * convIpc(x.c, hoyS)])), usd = sd(o.map(x => [x.end, x.val / fxAt(tOf(x.end) + DAY - 1)]));
  return { ars, usd, dolar: ars != null && usd != null && usd < 0.6 * ars };
}

// ---- series semanales: precio, resultado por acción de 12 meses y valor libro por acción, en la moneda de cada semana.
// conv(c, t): de la moneda de la fecha c a la del momento t (segundos). splits: [{ date, ratio }] (Yahoo ajusta los
// precios viejos por los splits; las acciones de un balance anterior se multiplican por el ratio)
export function semanalEmpresa({ price, ni, eq, conv, splits = [], weeks, hoyS }) {
  const Q = ni.filter(x => x.tipo === "q").sort((a, b) => a.end.localeCompare(b.end));
  const A = ni.filter(x => x.tipo !== "q");
  const E = eq.slice().sort((a, b) => a.end.localeCompare(b.end));
  const spl = end => splits.filter(s => s.date > tOf(end)).reduce((a, s) => a * s.ratio, 1);
  const c = [], eps = [], bv = [], uso = [];
  for (const w of weeks) {
    const t = Math.min(MONDAY0 + w * WEEK + 4 * DAY, hoyS), p = price.get(w);
    // 12 meses: cuatro trimestres seguidos presentados, o el último ejercicio (o los 12 meses de Yahoo)
    let best = null;
    const qs = Q.filter(x => x.pub <= t);
    if (qs.length >= 4) {
      const u = qs.slice(-4);
      const seguidos = u.every((x, i) => i === 0 || (dias(u[i - 1].end, x.end) >= 75 && dias(u[i - 1].end, x.end) <= 105));
      if (seguidos) best = { end: u[3].end, val: u.reduce((s, x) => s + x.val * conv(x.c, t), 0), sh: u[3].sh, tipo: "4 trimestres", src: u[3].src };
    }
    for (const x of A) if (x.pub <= t && (!best || x.end > best.end)) best = { end: x.end, val: x.val * conv(x.c, t), sh: x.sh, tipo: x.tipo === "a" ? "ejercicio" : "12 meses", src: x.src };
    const b = E.filter(x => x.pub <= t).pop();
    c.push(p > 0 ? p : null);
    const okN = best && best.sh > 0 && t - tOf(best.end) <= MAX_DIAS * DAY;
    eps.push(okN ? best.val / (best.sh * spl(best.end)) : null);
    const okB = b && b.sh > 0 && t - tOf(b.end) <= MAX_DIAS * DAY;
    bv.push(okB ? b.val * conv(b.c, t) / (b.sh * spl(b.end)) : null);
    uso.push({ ni: okN ? best : null, eq: okB ? b : null });
  }
  return { c, eps, bv, uso };
}

// bancos: de bancos.json (precio de BYMA, P/BV y ROE real por semana): valor libro = precio / P/BV; resultado de 12
// meses = ROE × valor libro
export function desdeBancos(B, week0, weeks) {
  const c = [], eps = [], bv = [];
  for (const w of weeks) {
    const i = w - week0, p = i >= 0 ? B.precio?.[i] : null, pb = i >= 0 ? B.pb?.[i] : null, roe = i >= 0 ? B.roe?.[i] : null;
    c.push(p > 0 ? p : null);
    const b = p > 0 && pb > 0 ? p / pb : null;
    bv.push(b);
    eps.push(b != null && roe != null ? b * roe / 100 : null);
  }
  return { c, eps, bv };
}

const sig = (v, n = 5) => v == null || !isFinite(v) ? null : +v.toPrecision(n);
// recorta los nulos del principio: w0 = primera semana con precio y algún dato
function recortar(weeks, x, ev = null) {
  let i0 = weeks.findIndex((w, i) => x.c[i] != null && (x.eps[i] != null || x.bv[i] != null));
  if (i0 < 0) return null;
  return { w0: weeks[i0], c: x.c.slice(i0).map(v => sig(v, 6)), eps: x.eps.slice(i0).map(v => sig(v)), bv: x.bv.slice(i0).map(v => sig(v)),
    ...(ev ? { eb: ev.eps.slice(i0).map(v => sig(v)), nd: ev.bv.slice(i0).map(v => sig(v)) } : {}) };
}

// ---- EV/EBITDA, de Yahoo (los 20-F etiquetan deuda, caja y amortizaciones de muchas maneras distintas, con errores de
// escala): EBITDA = resultado operativo + amortizaciones, sin el resultado por inflación, las diferencias de cambio ni los
// intereses, que van abajo del operativo. Deuda neta = deuda financiera (con arrendamientos) − caja e inversiones
// corrientes + minoritarios (el EBITDA es el consolidado). Monedas: los trimestres en la suya; los ejercicios, en la del
// último balance que los trae: el patrimonio y la deuda, del año siguiente; los resultados, de dos años después en las que
// presentan 20-F (tres años de resultados: el operativo de TGS de 2022 en Yahoo es el del 20-F de 2022 por el IPC de dos
// años) y del año siguiente en las demás. Las que tienen el dólar como moneda funcional, cada uno en la suya.
const monedaYahoo2 = (end, fin) => { const sig2 = `${+end.slice(0, 4) + 2}${end.slice(4)}`; return sig2 < fin ? sig2 : fin; };
// sinDeuda: Yahoo no da la deuda en ningún balance de la empresa (Ecogas no tiene deuda financiera): cuenta como cero.
// Si la da en algunos y no en otros (Aluar), el balance sin deuda no se usa
export function deudaNeta(o, sinDeuda = false, mi = o.MinorityInterest) {
  const caja = o.CashCashEquivalentsAndShortTermInvestments ?? (o.CashAndCashEquivalents != null ? o.CashAndCashEquivalents + (o.OtherShortTermInvestments || 0) : null);
  const deuda = isFinite(o.TotalDebt) ? o.TotalDebt : sinDeuda ? 0 : null;
  if (deuda == null || caja == null) return null;
  return deuda - caja + Math.max(0, mi || 0);
}
export function evDesdeYahoo(ys, { hoyS = Infinity, acc = "OrdinarySharesNumber", flujos2 = false, propia = false, conv = () => 1 } = {}) {
  const fin = Object.keys(ys.a).sort().pop();
  const sh = o => (o[acc] > 0 ? o[acc] : null);
  const da = o => o.ReconciledDepreciation ?? o.DepreciationAndAmortization;
  // amortizaciones trimestrales raras: Yahoo da las del 3T25 de casi todas en un tercio de lo normal y las del 1T de Loma
  // en miles. Con menos de 60% de la mediana de los trimestres, o sin dato y con resultado operativo, va la mediana
  const qs = Object.entries(ys.q).sort((a, b) => a[0].localeCompare(b[0]));
  const das = qs.map(([, o]) => da(o)).filter(v => v > 0).sort((a, b) => a - b), med = das.length >= 2 ? das[Math.floor(das.length / 2)] : null;
  const eb = [], nd = [], sinDeuda = ![...Object.values(ys.q), ...Object.values(ys.a)].some(o => isFinite(o.TotalDebt));
  // minoritarios: si a un trimestre le faltan y el anterior (hasta 200 días) los tiene, van esos, llevados a su moneda
  // (Yahoo no los trae en el de YPF al 30/09/2026: US$ 269 millones en junio)
  const conMinor = [...Object.values(ys.q), ...Object.values(ys.a)].some(o => isFinite(o.MinorityInterest));
  let miAnt = null;
  for (const [end, o] of qs) {
    if (isFinite(o.OperatingIncome)) {
      let d = da(o);
      if (med != null && !(d >= 0.6 * med)) d = med;
      if (d != null) eb.push({ end, tipo: "q", val: o.OperatingIncome + d, c: end, pub: pubDe(end, "q", hoyS), sh: sh(o), src: "Yahoo trimestral" });
    }
    let mi = o.MinorityInterest, miArr = false;
    if (isFinite(mi)) miAnt = { end, val: mi };
    else if (conMinor && miAnt && dias(miAnt.end, end) <= 200) { mi = miAnt.val * conv(miAnt.end, tOf(end) + DAY - 1); miArr = true; }
    const n = deudaNeta(o, sinDeuda, mi);
    if (n != null) nd.push({ end, tipo: "b", val: n, c: end, pub: pubDe(end, "q", hoyS), sh: sh(o), src: "Yahoo trimestral", ...(miArr ? { ajustes: ["minoritarios del trimestre anterior"] } : {}) });
  }
  for (const [end, o] of Object.entries(ys.a)) {
    const cF = propia ? end : flujos2 ? monedaYahoo2(end, fin) : monedaYahoo(end, fin), cB = propia ? end : monedaYahoo(end, fin);
    if (isFinite(o.OperatingIncome) && da(o) != null) eb.push({ end, tipo: "a", val: o.OperatingIncome + da(o), c: cF, pub: pubDe(end, "a", hoyS), sh: sh(o), src: "Yahoo anual" });
    const n = deudaNeta(o, sinDeuda);
    if (n != null) nd.push({ end, tipo: "b", val: n, c: cB, pub: pubDe(end, "a", hoyS), sh: sh(o), src: "Yahoo anual" });
  }
  return { eb, nd };
}

// ajustes a mano de la deuda neta (backend/data/deuda_ajustes.json): partidas que Yahoo no trae y están en los estados
// financieros de ese cierre, en millones de su moneda. "deuda" suma y "caja" resta. Valen para el balance de esa fecha;
// con arrastra (un plan de pagos que se amortiza en años), también para los siguientes, llevadas con conv, hasta que
// haya uno más nuevo de la misma partida
export function ajustarDeuda(nd, ajustes = [], conv = () => 1) {
  for (const x of nd) for (const a of ajustes) {
    const mismo = a.cierre === x.end;
    const arrastra = a.arrastra && a.cierre < x.end && !ajustes.some(b => b.que === a.que && b.cierre > a.cierre && b.cierre <= x.end);
    if (!mismo && !arrastra) continue;
    x.val += ((a.deuda || 0) - (a.caja || 0)) * 1e6 * conv(a.cierre, tOf(x.c) + DAY - 1);
    x.ajustes = [...(x.ajustes || []), a.que];
  }
  return nd;
}

// dividendos de Yahoo: uno de más de la mitad del precio de su semana es un error y no se usa; dos con menos de 4 días entre
// sí y montos a menos de 10% son el mismo cargado dos veces (Ecogas, 339,81 el 17/09/2026 y 331,45 el 18/09: el precio
// de esa semana bajó 6%, no 23%) y queda el primero
export function limpiarDividendos(divs, price, log = () => {}) {
  const out = [];
  for (const d of divs) {
    const p = price.get(weekOf(d.date));
    if (p > 0 && d.amount >= 0.5 * p) { log(`dividendo de ${d.amount} el ${isoOf(d.date)} contra un precio de ${p}: no se usa`); continue; }
    const prev = out[out.length - 1];
    if (prev && d.date - prev.date <= 4 * DAY && Math.abs(d.amount / prev.amount - 1) < 0.1) { log(`dividendo de ${d.amount} el ${isoOf(d.date)}: repite el de ${prev.amount} del ${isoOf(prev.date)}, no se suma`); continue; }
    out.push(d);
  }
  return out;
}

// dividendos cobrados después del balance que usa cada semana: el precio ya los descontó (cotiza ex dividendo) y la caja
// del balance todavía los tiene, así que se suman a la deuda neta por acción, en la moneda de la semana. Devuelve los
// de la última semana
export function sumarDividendos(sEv, divs, weeks, conv, hoyS) {
  let ult = [];
  weeks.forEach((w, i) => {
    const o = sEv.uso[i]?.eq, t = Math.min(MONDAY0 + w * WEEK + 4 * DAY, hoyS);
    if (!o || sEv.bv[i] == null) return;
    const ds = divs.filter(d => d.date >= tOf(o.end) + DAY && d.date <= t);
    if (ds.length) sEv.bv[i] += ds.reduce((a, d) => a + d.amount * conv(isoOf(d.date), t), 0);
    if (i === weeks.length - 1) ult = ds;
  });
  return ult;
}

async function getJSON(f, url, opts = {}, tries = 3) {
  for (let a = 0; ; a++) {
    try {
      const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), 30000);
      const r = await f(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tm));
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (a >= tries - 1) throw e;
      await new Promise(res => setTimeout(res, 1500 * (a + 1)));
    }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const precioDe = chart => {
  const ts = chart?.timestamp || [], cl = chart?.indicators?.quote?.[0]?.close || [], m = new Map();
  ts.forEach((t, i) => { if (cl[i] > 0) m.set(weekOf(t), cl[i]); });
  const splits = Object.values(chart?.events?.splits || {}).map(s => ({ date: s.date, ratio: s.numerator / s.denominator })).filter(s => s.ratio > 0 && isFinite(s.ratio) && s.ratio !== 1);
  const divs = Object.values(chart?.events?.dividends || {}).map(d => ({ date: d.date, amount: d.amount })).filter(d => d.amount > 0 && isFinite(d.amount)).sort((a, b) => a.date - b.date);
  return { m, splits, divs };
};
// dólar oficial de cada día: el mayorista de referencia del BCRA (Comunicación A 3500, variable 5 de su API); si no
// responde, el del BNA de argentinadatos. El mayorista de argentinadatos no sirve: quedó en 366,45 del 12/12/2023 a fin
// de año, con la devaluación del 13/12 adentro. fxAt(t) = el último hasta t
export const BCRA_FX = (desde, hasta) => `https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/5?desde=${desde}${hasta ? "&hasta=" + hasta : ""}&limit=3000`;
export const FX_BNA = "https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial";
export const CCL_URL = "https://api.argentinadatos.com/v1/cotizaciones/dolares/contadoconliqui";
const ptsDe = j => (Array.isArray(j) ? j : []).filter(x => x && /^\d{4}-\d\d-\d\d$/.test(x.fecha || "") && x.venta > 0).map(x => [tOf(x.fecha), +x.venta]).sort((a, b) => a[0] - b[0]);
// la API del BCRA: { results: [{ detalle: [{ fecha, valor }] }] } al formato de argentinadatos
export const bcraFx = (...js) => js.flatMap(j => j?.results?.[0]?.detalle || []).map(x => ({ fecha: x.fecha, venta: +x.valor }));
export function fxDe(j, min = 100) {
  const pts = ptsDe(j);
  if (pts.length < min) return null;
  const at = t => { if (t <= pts[0][0]) return pts[0][1]; let lo = 0, hi = pts.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= t) lo = m; else hi = m; } return pts[hi][0] <= t ? pts[hi][1] : pts[lo][1]; };
  return { at, n: pts.length, desde: isoOf(pts[0][0]), hasta: isoOf(pts.at(-1)[0]) };
}
const Y_TIPOS = ["NetIncomeCommonStockholders", "StockholdersEquity", "CommonStockEquity", "OrdinarySharesNumber", "DilutedAverageShares",
  "OperatingIncome", "ReconciledDepreciation", "DepreciationAndAmortization", "TotalDebt", "CashCashEquivalentsAndShortTermInvestments", "CashAndCashEquivalents", "OtherShortTermInvestments", "MinorityInterest"];

export async function main({ root = new URL("../", import.meta.url), fetchImpl = globalThis.fetch, now = new Date(), log = console.log,
  secUA = process.env.SEC_UA || "tradingweb research@example.com", modo = process.env.MODO || "diario" } = {}) {
  if (modo === "ebitda") return diagnosticoEbitda({ fetchImpl, log, secUA, solo: process.env.SOLO ? process.env.SOLO.split(",") : null });
  if (modo === "diagnostico") return diagnostico({ fetchImpl, log, secUA, solo: process.env.SOLO ? process.env.SOLO.split(",") : null, extraY: (process.env.EXTRA_Y || "").split(",").filter(Boolean) });
  const hoyS = Math.floor(now.getTime() / 1000), errores = {};
  const leer = async (p, req = true) => { try { return JSON.parse(await readFile(new URL(p, root), "utf8")); } catch (e) { if (req) throw new Error(p + ": " + e.message); log(p + ": " + e.message); return null; } };
  const indec = await leer("indec.json"), bcra = await leer("bcra.json", false), bancos = await leer("bancos.json", false), manual = await leer("backend/data/eps_manual.json", false) || {},
    ajustesDeuda = await leer("backend/data/deuda_ajustes.json", false) || {};
  const ipc = ipcDe(indec, bcra?.ipc);
  if (!ipc) throw new Error("indec.json sin el IPC nacional");
  const convARS = (c, t) => ipc.at(t) / ipc.at(tOf(c) + DAY - 1), convUSD = () => 1;
  let fx = null, fxSrc = null;
  { const H = { headers: { "User-Agent": UA, Accept: "application/json" } }, bajar = u => getJSON(fetchImpl, u, H).catch(e => { log("tipo de cambio: " + u + " " + e.message); return null; });
    const [a, b] = await Promise.all([bajar(BCRA_FX("2013-01-01", "2019-12-31")), bajar(BCRA_FX("2020-01-01"))]);
    fx = a && b ? fxDe(bcraFx(a, b)) : null; fxSrc = "BCRA, Comunicación A 3500";
    if (!fx) { fx = fxDe(await bajar(FX_BNA)); fxSrc = "BNA (argentinadatos)"; } }
  if (!fx) errores.fx = "sin tipo de cambio oficial: todas en pesos con el IPC";
  // con el dólar como moneda funcional, el balance pasa a dólares con el oficial de su cierre (como presenta la empresa) y
  // a pesos de cada semana con el contado con liquidación, el dólar al que el mercado pone el precio: es el múltiplo de
  // una cuenta en dólares, como el de un ADR (con el oficial, la brecha de 2020 a 2025 inflaba el P/BV de Ternium a 1,6)
  let ccl = null;
  try { ccl = fxDe(await getJSON(fetchImpl, CCL_URL, { headers: { "User-Agent": UA, Accept: "application/json" } })); } catch (e) { log("contado con liquidación: " + e.message); }
  if (fx && !ccl) errores.ccl = "sin contado con liquidación: el dólar funcional va con el oficial";
  { const fechas = ["2019-12-31", "2023-12-12", "2023-12-14", "2023-12-29", "2024-12-31", "2025-04-14", "2025-12-31", isoOf(hoyS)];
    if (fx) log(`dólar oficial (${fxSrc}): ` + fechas.map(d => d + " " + fx.at(tOf(d) + DAY - 1)).join(", ") + `; ${fx.n} datos de ${fx.desde} a ${fx.hasta}`);
    if (ccl) log("contado con liquidación: " + fechas.map(d => d + " " + ccl.at(tOf(d) + DAY - 1)).join(", ") + `; ${ccl.n} datos de ${ccl.desde} a ${ccl.hasta}`); }
  const convFX = fx ? (c, t) => (ccl || fx).at(t) / fx.at(tOf(c) + DAY - 1) : convARS;
  // SEC
  const secH = { headers: { "User-Agent": secUA, Accept: "application/json" } };
  let lastSec = 0;
  const secGet = async url => { const w = lastSec + 200 - Date.now(); if (w > 0) await sleep(w); lastSec = Date.now(); return getJSON(fetchImpl, url, secH); };
  const cik = {};
  try { for (const x of Object.values(await secGet("https://www.sec.gov/files/company_tickers.json") || {})) cik[String(x.ticker).toUpperCase()] = String(x.cik_str).padStart(10, "0"); }
  catch (e) { errores.sec = e.message; log("SEC tickers: " + e.message); }
  // Yahoo
  let ys = null;
  try { ys = await yahooSession(fetchImpl); } catch (e) { errores.yahoo = e.message; log("Yahoo (sesión): " + e.message); }
  const yH = { headers: { "User-Agent": UA, Accept: "application/json", ...(ys ? { Cookie: ys.cookie } : {}) } }, cr = ys ? `&crumb=${encodeURIComponent(ys.crumb)}` : "";
  const p1 = Date.UTC(2013, 11, 30) / 1000;
  const chartDe = sym => getJSON(fetchImpl, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${hoyS}&interval=1wk&events=div%2Csplits`, { headers: { "User-Agent": UA, Accept: "application/json" } }).then(j => j?.chart?.result?.[0] || null);
  const tipos = [...["quarterly", "annual"].flatMap(p => Y_TIPOS.map(t => p + t)), "trailingNetIncomeCommonStockholders"].join(",");
  const yFund = sym => getJSON(fetchImpl, `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${tipos}&period1=${Date.UTC(2015, 0, 1) / 1000}&period2=${hoyS + DAY}${cr}`, yH);

  const weeks = []; for (let w = W_DESDE; w <= weekOf(hoyS); w++) weeks.push(w);
  const empresas = {};
  for (const c of [...MERVAL, ...EXTRA]) {
    try {
      const base = { n: c.n, adr: c.adr || null, sector: c.sector || null };
      if (c.banco) {
        const B = bancos?.bancos?.[c.s];
        if (!B) throw new Error("no está en bancos.json");
        const bw = []; for (let w = bancos.week0; w <= weekOf(hoyS); w++) bw.push(w);
        const x = recortar(bw, desdeBancos(B, bancos.week0, bw));
        if (!x) throw new Error("bancos.json sin datos");
        const k = x.c.length - 1;
        empresas[c.s] = { ...base, px: B.ticker || c.s + ".BA", moneda: "ARS", banco: true, ...x,
          ult: { precio: B.ult?.precio ?? x.c[k], eps: x.eps[k], bv: x.bv[k], balance: B.ult?.balance || null, roe: B.ult?.roe ?? null, fuente: "Bancos: " + (B.ult?.fuente || "BCRA, 20-F y Yahoo") } };
        log(`${c.s}: de bancos.json desde ${isoOf(MONDAY0 + x.w0 * WEEK)}, P/BV ${B.ult?.pb}, ROE ${B.ult?.roe}%`);
        continue;
      }
      const usd = c.moneda === "USD", px = c.px || c.s + ".BA", ySym = usd ? (c.adr || c.px) : c.s + ".BA";
      const [chart, yj, facts] = await Promise.all([
        chartDe(px),
        yFund(ySym).catch(e => { errores[c.s + " Yahoo"] = e.message; return null; }),
        c.sec && cik[c.sec] ? secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik[c.sec]}.json`).catch(e => { errores[c.s + " SEC"] = e.message; return null; }) : null,
      ]);
      if (!chart) throw new Error("sin precios de " + px);
      const { m: price, splits, divs: divs0 } = precioDe(chart);
      const divs = limpiarDividendos(divs0, price, m => log(`${c.s}: ${m}`));
      const corte = cortarSaltos(price, splits);
      if (corte != null) log(`${c.s}: precio desde ${isoOf(MONDAY0 + corte * WEEK)} (salto sin split antes)`);
      // en dólares, las acciones por ADR: las del promedio diluido del ADR en Yahoo (las de la acción local vienen mal en YPF)
      const yser = yahooSerie(yj), yah = desdeYahoo(yser, { hoyS, acc: usd ? "DilutedAverageShares" : "OrdinarySharesNumber" });
      const sec = facts ? desdeSec(facts, { unidad: usd ? "USD" : "ARS", hoyS }) : { ni: [], eq: [], cand: () => [] };
      const man = c.manual ? desdeManual(manual[c.manual], { ratio: c.ratio || 1, hoyS }) : [];
      // acciones de los 20-F: las de los trimestres a mano o de Yahoo del mismo cierre; si no hay, la candidata del 20-F
      // más cercana a las de la observación confiable más próxima en el tiempo
      const conf = [...man, ...yah.ni, ...yah.eq].filter(x => x.sh > 0);
      for (const x of [...sec.ni, ...sec.eq]) {
        const igual = conf.find(y => Math.abs(dias(y.end, x.end)) <= 10);
        if (igual) { x.sh = igual.sh; continue; }
        const cs = sec.cand(x.end).map(v => v / (usd ? (c.ratio || 1) : 1));
        if (!cs.length) continue;
        const ref = conf.slice().sort((a, b) => Math.abs(dias(a.end, x.end)) - Math.abs(dias(b.end, x.end)))[0];
        x.sh = ref ? cs.sort((a, b) => Math.abs(Math.log(a / ref.sh)) - Math.abs(Math.log(b / ref.sh)))[0] : cs.sort((a, b) => a - b)[Math.floor(cs.length / 2)];
      }
      // moneda funcional (las que presentan en pesos): con el dólar, los ejercicios de Yahoo están en pesos de su cierre
      // y todo se lleva de un cierre a otro con el tipo de cambio oficial, no con el IPC
      let regimen = usd ? "dólares" : "pesos";
      if (!usd && fx) {
        // la prueba en pesos constantes lleva cada valor desde su moneda de NIC 29 (c) y la de dólares desde su cierre
        const mf = monedaFuncional(unir([yah.eq.filter(x => x.src === "Yahoo trimestral"), sec.eq, yah.eq.filter(x => x.src === "Yahoo anual")].map(L => L.map(x => ({ ...x, tipo: "b" })))), convARS, fx.at, hoyS);
        if (mf.dolar || c.funcional === "USD") regimen = "dólar funcional";
        log(`${c.s}: moneda funcional, desvío de los cambios anuales del patrimonio en pesos constantes ${mf.ars?.toFixed(3)} y en dólares ${mf.usd?.toFixed(3)}: ${regimen}`);
      }
      if (regimen === "dólar funcional") for (const x of [...yah.ni, ...yah.eq]) x.c = x.end;
      // por cierre manda: los trimestres a mano, Yahoo trimestral, los 20-F y los ejercicios de Yahoo
      let ni = unir([man, yah.ni.filter(x => x.tipo === "q"), sec.ni, yah.ni.filter(x => x.tipo !== "q")]);
      const conv = usd ? convUSD : regimen === "dólar funcional" ? convFX : convARS;
      ni = completarTrimestres(ni, conv);
      let eq = unir([yah.eq.filter(x => x.src === "Yahoo trimestral").map(x => ({ ...x, tipo: "b" })), sec.eq.map(x => ({ ...x, tipo: "b" })), yah.eq.filter(x => x.src === "Yahoo anual").map(x => ({ ...x, tipo: "b" }))]);
      // en pesos, el patrimonio anterior a la NIC 29 (costo histórico, sin reexpresar) no se compara con el de después
      if (regimen === "pesos") eq = eq.filter(x => x.end >= "2018-09-30");
      completarAcciones(ni, eq); completarAcciones(eq, ni);
      limpiarAcciones(ni, eq); limpiarAcciones(eq, ni);
      const ref = [...ni, ...eq].filter(x => x.sh > 0).sort((a, b) => b.end.localeCompare(a.end))[0]?.sh;
      ajustarSplits(ni, splits, ref); ajustarSplits(eq, splits, ref);
      const s = semanalEmpresa({ price, ni, eq, conv, splits: [], weeks, hoyS });
      // EV/EBITDA: EBITDA de 12 meses y deuda neta por acción de cada semana, con las mismas acciones y monedas
      let sEv = null, evObs = null, divUlt = [];
      if (!c.sinEV) {
        const ev = evDesdeYahoo(yser, { hoyS, acc: usd ? "DilutedAverageShares" : "OrdinarySharesNumber", flujos2: !!c.sec, propia: usd || regimen === "dólar funcional", conv });
        const eb = completarTrimestres(unir([ev.eb]), conv), nd = ajustarDeuda(unir([ev.nd]), ajustesDeuda[c.s] || [], conv);
        completarAcciones(eb, [...ni, ...eq]); completarAcciones(nd, [...ni, ...eq]);
        limpiarAcciones(eb, [...ni, ...eq]); limpiarAcciones(nd, [...ni, ...eq]);
        ajustarSplits(eb, splits, ref); ajustarSplits(nd, splits, ref);
        if (eb.length && nd.length) {
          sEv = semanalEmpresa({ price, ni: eb, eq: nd, conv, splits: [], weeks, hoyS }); evObs = { eb, nd };
          divUlt = sumarDividendos(sEv, divs, weeks, conv, hoyS);
        }
        const ultNd = nd.slice().sort((a, b) => a.end.localeCompare(b.end)).pop();
        for (const a of ajustesDeuda[c.s] || []) if (ultNd && a.cierre < ultNd.end && !a.arrastra) log(`${c.s}: el ajuste a mano de la deuda (${a.que}, ${a.cierre}) es de un balance anterior al último (${ultNd.end}): revisar`);
      }
      const x = recortar(weeks, s, sEv);
      if (!x) throw new Error("sin resultados ni balances que empalmen con el precio");
      const k = s.c.length - 1, u = s.uso[k], uEv = sEv ? sEv.uso[k] : null;
      const precio = chart?.meta?.regularMarketPrice ?? x.c.at(-1);
      // control: los 20-F contra los ejercicios de Yahoo del mismo cierre (llevados a la misma moneda)
      const ctrl = [];
      for (const a of sec.ni) { const y = yah.ni.find(z => z.tipo === "a" && z.end === a.end); if (y && y.val) ctrl.push(`resultado ${a.end}: ${(a.val * conv(a.c, tOf(y.c) + DAY - 1) / y.val).toFixed(2)}`); }
      for (const a of sec.eq) { const y = yah.eq.find(z => z.src === "Yahoo anual" && z.end === a.end); if (y && y.val) ctrl.push(`patrimonio ${a.end}: ${(a.val * conv(a.c, tOf(y.c) + DAY - 1) / y.val).toFixed(2)}${a.tag !== "atribuible" ? " (" + a.tag + ")" : ""}`); }
      empresas[c.s] = { ...base, px, moneda: usd ? "USD" : "ARS", regimen, ...(usd ? { ratio: c.ratio || 1 } : {}), ...x,
        ult: { precio, eps: sig(s.eps[k]), bv: sig(s.bv[k]), resultado: u.ni ? { cierre: u.ni.end, tipo: u.ni.tipo, fuente: u.ni.src } : null, balance: u.eq ? { cierre: u.eq.end, fuente: u.eq.src } : null,
          ajusteIPC: regimen === "pesos" && u.eq ? +convARS(u.eq.c, hoyS).toFixed(3) : null, ajusteTC: regimen === "dólar funcional" && u.eq ? +convFX(u.eq.c, hoyS).toFixed(3) : null,
          ...(uEv ? { ebitda: uEv.ni ? { cierre: uEv.ni.end, tipo: uEv.ni.tipo, fuente: uEv.ni.src } : null, deuda: uEv.eq ? { cierre: uEv.eq.end, fuente: uEv.eq.src, ...(uEv.eq.ajustes ? { ajustes: uEv.eq.ajustes } : {}),
            ...(divUlt.length ? { dividendos: divUlt.map(d => [isoOf(d.date), sig(d.amount)]) } : {}) } : null } : {}) },
        obs: { resultados: ni.map(o => [o.end, o.tipo, sig(o.val / 1e6, 6), o.c, isoOf(o.pub), o.sh ? sig(o.sh / 1e6, 6) : null, o.src]),
          balances: eq.map(o => [o.end, sig(o.val / 1e6, 6), o.c, isoOf(o.pub), o.sh ? sig(o.sh / 1e6, 6) : null, o.src]),
          ...(evObs ? { ebitda: evObs.eb.map(o => [o.end, o.tipo, sig(o.val / 1e6, 6), o.c, isoOf(o.pub), o.src]), deudaNeta: evObs.nd.map(o => [o.end, sig(o.val / 1e6, 6), o.c, isoOf(o.pub), o.src + (o.ajustes ? " con " + o.ajustes.join(", ") : "")]) } : {}),
          ...(divs.length ? { dividendos: divs.filter(d => d.date >= hoyS - 3 * 365 * DAY).map(d => [isoOf(d.date), sig(d.amount)]) } : {}) },
        ...(splits.length ? { splits: splits.map(z => [isoOf(z.date), z.ratio]) } : {}), ...(corte != null ? { precioDesde: isoOf(MONDAY0 + corte * WEEK) } : {}) };
      const pe = x.eps.at(-1) > 0 ? x.c.at(-1) / x.eps.at(-1) : null, pb = x.bv.at(-1) > 0 ? x.c.at(-1) / x.bv.at(-1) : null;
      const evE = x.eb && x.eb.at(-1) > 0 && x.c.at(-1) + x.nd.at(-1) > 0 ? (x.c.at(-1) + x.nd.at(-1)) / x.eb.at(-1) : null;
      log(`${c.s} (${px}, ${usd ? "US$" : "$"}): desde ${isoOf(MONDAY0 + x.w0 * WEEK)}; resultados ${ni.map(o => o.end + o.tipo + "(" + o.src.split(" ")[0] + ")").join(" ")}; balances ${eq.map(o => o.end + "(" + o.src.split(" ")[0] + ")").join(" ")}`
        + `; hoy P/E ${pe ? pe.toFixed(2) : "—"} (${u.ni ? u.ni.tipo + " al " + u.ni.end : "sin resultado"}), P/BV ${pb ? pb.toFixed(2) : "—"} (${u.eq ? u.eq.end : "sin balance"})`
        + (x.eb ? `, EV/EBITDA ${evE ? evE.toFixed(2) : "—"} (EBITDA ${uEv?.ni ? uEv.ni.tipo + " al " + uEv.ni.end : "—"}, deuda neta por acción ${x.nd.at(-1)} al ${uEv?.eq?.end || "—"}${divUlt.length ? " más dividendos " + divUlt.map(d => isoOf(d.date) + " " + d.amount).join(", ") : ""}${uEv?.eq?.ajustes ? " con " + uEv.eq.ajustes.join(", ") : ""}; EBITDA ${evObs.eb.map(o => o.end + o.tipo).join(" ")})` : "")
        + `; acciones ${[...new Set(eq.map(o => o.sh ? Math.round(o.sh / 1e6) : null))].join("/")} M` + (ctrl.length ? `; 20-F/Yahoo ${ctrl.join(", ")}` : "") + (splits.length ? `; splits ${splits.map(z => isoOf(z.date) + " x" + z.ratio).join(" ")}` : ""));
    } catch (e) { errores[c.s] = e.message; log(`${c.s}: ${e.message}`); }
  }
  if (MERVAL.filter(c => empresas[c.s]).length < 12) throw new Error(`Faltan empresas: ${JSON.stringify(errores)}`);
  const out = { version: VERSION, asOf: now.toISOString(), monday0: MONDAY0, ipc: { desde: ipc.desde, hasta: ipc.ult }, tc: fx ? { desde: fx.desde, hasta: fx.hasta, fuente: fxSrc } : null, ccl: ccl ? { desde: ccl.desde, hasta: ccl.hasta } : null,
    fuente: "SEC (20-F), Yahoo Finance, INDEC y bancos.json", merval: MERVAL.map(c => c.s).filter(s => empresas[s]), extra: EXTRA.map(c => c.s).filter(s => empresas[s]),
    indice: { n: "MSCI MERVAL", desde: "2026-10-19", fuente: "La Nación, 17/10/2026" }, empresas, errores };
  await writeFile(new URL("empresas.json", root), JSON.stringify(out));
  log(`empresas.json: ${Object.keys(empresas).length} empresas; errores: ${JSON.stringify(errores)}`);
  return out;
}

// ---- diagnóstico del EV/EBITDA: qué trae Yahoo de resultado operativo, amortizaciones, deuda, caja y minoritarios, y qué
// etiquetas de esas partidas tiene cada 20-F (solo en el log)
const YE_TIPOS = ["OperatingIncome", "EBIT", "EBITDA", "NormalizedEBITDA", "ReconciledDepreciation", "DepreciationAndAmortization", "DepreciationAmortizationDepletion",
  "TotalDebt", "NetDebt", "CurrentDebtAndCapitalLeaseObligation", "LongTermDebtAndCapitalLeaseObligation", "CapitalLeaseObligations", "CashAndCashEquivalents",
  "OtherShortTermInvestments", "CashCashEquivalentsAndShortTermInvestments", "MinorityInterest", "TotalRevenue"];
export async function diagnosticoEbitda({ fetchImpl = globalThis.fetch, log = console.log, secUA = "tradingweb research@example.com", solo = null } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const lista = (solo ? MERVAL.filter(c => solo.includes(c.s)) : MERVAL).filter(c => !c.banco);
  const secH = { headers: { "User-Agent": secUA, Accept: "application/json" } };
  let tick = {};
  try { for (const c of Object.values(await getJSON(fetchImpl, "https://www.sec.gov/files/company_tickers.json", secH) || {})) tick[String(c.ticker).toUpperCase()] = String(c.cik_str).padStart(10, "0"); }
  catch (e) { log("SEC tickers: " + e.message); }
  const re = /OperatingActivities|Depreciation|Amortisation|Borrowings|LeaseLiabilities|CashAndCashEquivalents|CurrentInvestments|OtherCurrentFinancialAssets|CurrentFinancialAssets|NoncontrollingInterests|^Revenue$/;
  for (const c of lista.filter(c => c.sec)) {
    const id = tick[c.sec]; if (!id) continue;
    await sleep(250);
    let facts; try { facts = await getJSON(fetchImpl, `https://data.sec.gov/api/xbrl/companyfacts/CIK${id}.json`, secH); } catch (e) { log(`${c.s}: ${e.message}`); continue; }
    const f = facts?.facts?.["ifrs-full"] || {};
    log(`\n=== SEC ${c.s}/${c.sec}`);
    for (const [tag, o] of Object.entries(f)) {
      if (!re.test(tag) || /Adjustments|Increase|Decrease|Proceeds|Repayments|Payments|Reclassification|Gains|Losses|Interest|Impairment|Accumulated/.test(tag)) continue;
      for (const [u, a] of Object.entries(o.units || {})) {
        const firstBy = new Map(); for (const e of a) { if (e.start && !anual(e.start, e.end)) continue; const k = e.end; const p = firstBy.get(k); if (!p || e.filed < p.filed) firstBy.set(k, e); }
        const v = [...firstBy.values()].sort((x, y) => x.end.localeCompare(y.end));
        log(`  ${tag} [${u}] ${v.length}: ` + v.slice(-4).map(e => `${e.end} ${+(e.val / 1e6).toPrecision(5)}M`).join("; "));
      }
    }
    // también las de amortizaciones del flujo de fondos (Adjustments...)
    for (const tag of Object.keys(f).filter(t => /^AdjustmentsForDepreciation|^AdjustmentsForAmortisation|^AdjustmentsForDepreciationAndAmortisationExpense/.test(t)))
      for (const [u, a] of Object.entries(f[tag].units || {})) log(`  ${tag} [${u}] ${a.length}: ` + a.filter(e => e.start && anual(e.start, e.end)).sort((x, y) => x.end.localeCompare(y.end) || x.filed.localeCompare(y.filed)).slice(-3).map(e => `${e.end} ${+(e.val / 1e6).toPrecision(5)}M (${e.filed})`).join("; "));
  }
  let s = null;
  try { s = await yahooSession(fetchImpl); } catch (e) { log("Yahoo sesión: " + e.message); }
  const H = { headers: { "User-Agent": UA, Accept: "application/json", ...(s ? { Cookie: s.cookie } : {}) } }, cr = s ? `&crumb=${encodeURIComponent(s.crumb)}` : "";
  for (const c of lista) {
    const sym = c.moneda === "USD" ? c.adr : c.s + ".BA";
    await sleep(400);
    const types = ["quarterly", "annual"].flatMap(p => YE_TIPOS.map(t => p + t)).join(",");
    try {
      const j = await getJSON(fetchImpl, `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types}&period1=946684800&period2=${now + DAY}${cr}`, H);
      log(`\n=== Yahoo ${sym}`);
      for (const r of j?.timeseries?.result || []) {
        const t = r?.meta?.type?.[0], pts = (r[t] || []).filter(x => x && x.asOfDate && isFinite(x.reportedValue?.raw));
        if (pts.length) log(`  ${t}: ${pts.map(x => `${x.asOfDate.slice(2)} ${+(x.reportedValue.raw / 1e6).toPrecision(4)}`).join(", ")}`);
      }
    } catch (e) { log(`Yahoo ${sym}: ${e.message}`); }
  }
}

// ---- diagnóstico: qué trae cada fuente (solo en el log)
const SEC_TAGS = ["EquityAttributableToOwnersOfParent", "Equity", "NoncontrollingInterests", "ProfitLossAttributableToOwnersOfParent", "ProfitLoss",
  "BasicEarningsLossPerShare", "DilutedEarningsLossPerShare", "WeightedAverageShares", "AdjustedWeightedAverageShares", "NumberOfSharesOutstanding"];
const YD_TIPOS = ["DilutedEPS", "BasicEPS", "NetIncomeCommonStockholders", "StockholdersEquity", "CommonStockEquity", "OrdinarySharesNumber", "DilutedAverageShares"];
export async function diagnostico({ fetchImpl = globalThis.fetch, log = console.log, secUA = "tradingweb research@example.com", solo = null, extraY = [] } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const lista = solo ? MERVAL.filter(c => solo.includes(c.s)) : MERVAL;
  const secH = { headers: { "User-Agent": secUA, Accept: "application/json" } };
  let tick = {};
  try { for (const c of Object.values(await getJSON(fetchImpl, "https://www.sec.gov/files/company_tickers.json", secH) || {})) tick[String(c.ticker).toUpperCase()] = String(c.cik_str).padStart(10, "0"); }
  catch (e) { log("SEC tickers: " + e.message); }
  for (const c of [...lista.filter(c => c.sec), ...EXTRA]) {
    const id = tick[c.sec]; if (!id) { log(`${c.s}: sin CIK`); continue; }
    await sleep(250);
    let facts;
    try { facts = await getJSON(fetchImpl, `https://data.sec.gov/api/xbrl/companyfacts/CIK${id}.json`, secH); } catch (e) { log(`${c.s}: ${e.message}`); continue; }
    const f = facts?.facts?.["ifrs-full"] || {};
    log(`\n=== ${c.s}/${c.sec}`);
    for (const tag of SEC_TAGS) for (const [u, a] of Object.entries(f[tag]?.units || {})) {
      const firstBy = new Map(); for (const e of a) { const k = e.end + (e.start || ""); const p = firstBy.get(k); if (!p || e.filed < p.filed) firstBy.set(k, e); }
      log(`  ${tag} [${u}]: ` + [...firstBy.values()].filter(e => !e.start || anual(e.start, e.end)).sort((x, y) => x.end.localeCompare(y.end)).map(e => `${e.end} ${+e.val.toPrecision(5)} (${e.filed})`).join("; "));
    }
  }
  let s = null;
  try { s = await yahooSession(fetchImpl); } catch (e) { log("Yahoo sesión: " + e.message); }
  const H = { headers: { "User-Agent": UA, Accept: "application/json", ...(s ? { Cookie: s.cookie } : {}) } }, cr = s ? `&crumb=${encodeURIComponent(s.crumb)}` : "";
  for (const sym of [...extraY, ...(solo ? lista.map(c => c.s + ".BA") : [])]) {
    await sleep(400);
    const types = ["quarterly", "annual", "trailing"].flatMap(p => YD_TIPOS.map(t => p + t)).join(",");
    try {
      const j = await getJSON(fetchImpl, `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types}&period1=946684800&period2=${now + DAY}${cr}`, H);
      log(`\nYahoo ${sym}:`);
      for (const r of j?.timeseries?.result || []) {
        const t = r?.meta?.type?.[0], pts = (r[t] || []).filter(x => x && x.asOfDate && isFinite(x.reportedValue?.raw));
        if (pts.length) log(`  ${t}: ${pts.map(x => `${x.asOfDate} ${+(+x.reportedValue.raw).toPrecision(5)}`).join(", ")}`);
      }
    } catch (e) { log(`Yahoo ${sym}: ${e.message}`); }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().then(() => {}, e => { console.error(e); process.exit(1); });
