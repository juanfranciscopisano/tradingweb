import { readFileSync } from "node:fs";
// EDGAR (SEC, XBRL): EPS diluido trimestral contable, EPS normalizado y acciones diluidas.
// Lo usan el backend (/api/pebg) y scripts/multiples.mjs (P/E histórico del S&P 500 y sus sectores).
// ---- EDGAR: EPS contable y normalizado ----
// Los datos crudos se cachean por ticker; el ajuste por splits se hace en cada pedido con los splits de Yahoo.
// Splits: EDGAR guarda cada trimestre tal como se presentó. Si un split ocurrió DESPUÉS del cierre del
// trimestre y DESPUÉS de presentado el dato, ese dato está sin ajustar (los precios de Yahoo sí están
// ajustados), así que se divide por el ratio. Si la empresa lo volvió a presentar después del split, ya
// viene reexpresado y no se toca.
export const EDGAR_TAGS = {
  // primero el de operaciones continuas: lo discontinuado (una escisión, un negocio vendido) ya no está en el precio.
  // Varias empresas (MNST, VRSN, GD) solo informan ese desde hace años. XOM publica "básico y diluido" en una sola
  // etiqueta; algunas (V, clases de acciones) solo el básico. Se combinan por período, en este orden de prioridad.
  eps: [["IncomeLossFromContinuingOperationsPerDilutedShare", "EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted",
         "IncomeLossFromContinuingOperationsPerBasicShare", "EarningsPerShareBasic"], "USD/shares"],
  oi: [["OperatingIncomeLoss"], "USD"],
  pt: [["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"], "USD"],
  tx: [["IncomeTaxExpenseBenefit"], "USD"],
  ni: [["NetIncomeLoss"], "USD"],
  sh: [["WeightedAverageNumberOfDilutedSharesOutstanding"], "shares"],
  ie: [["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestAndDebtExpense"], "USD"],
  ii: [["InvestmentIncomeInterest", "InterestIncomeOther", "InvestmentIncomeInterestAndDividend"], "USD"],
  eq: [["IncomeLossFromEquityMethodInvestments"], "USD"],
  rev: [["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"], "USD"],
};
// partidas puntuales para el EPS normalizado: cada etiqueta por separado (se combinan con reglas propias)
export const ADJ_TAGS = [
  "RestructuringCharges", "RestructuringSettlementAndImpairmentProvisions", "RestructuringCostsAndAssetImpairmentCharges",
  "GoodwillImpairmentLoss", "GoodwillAndIntangibleAssetImpairment", "ImpairmentOfIntangibleAssetsExcludingGoodwill",
  "ImpairmentOfLongLivedAssetsHeldForUse", "ImpairmentOfLongLivedAssetsToBeDisposedOf", "AssetImpairmentCharges",
  "LitigationSettlementExpense", "LossContingencyLossInPeriod", "BusinessCombinationAcquisitionRelatedCosts",
  "GainLossOnSaleOfPropertyPlantEquipment", "GainLossOnDispositionOfAssets", "GainLossOnDispositionOfAssets1",
  "GainLossOnSaleOfBusiness", "DisposalGroupNotDiscontinuedOperationGainLossOnDisposal", "EquitySecuritiesFvNiGainLoss",
  "GainsLossesOnExtinguishmentOfDebt", "RealizedInvestmentGainsLosses",
  "ResearchAndDevelopmentAssetAcquiredOtherThanThroughBusinessCombinationWrittenOff", "ResearchAndDevelopmentInProcess",
];
export function rawFromFacts(facts) {
  const g = facts?.facts?.["us-gaap"] || {};
  const out = {};
  for (const [k, [tags, unit]] of Object.entries(EDGAR_TAGS)) {
    if (k === "eps") {
      // EPS: todas las etiquetas por separado (cada una arma sus trimestres; después se combinan por prioridad)
      out.eps = [];
      for (const t of tags) for (const e of g[t]?.units?.[unit] || [])
        out.eps.push({ tag: t, start: e.start, end: e.end, val: e.val, fp: e.fp, form: e.form, frame: e.frame, filed: e.filed });
      continue;
    }
    // las empresas cambian de etiqueta con los años: se combinan por período (frame), con prioridad a la primera
    const arr = [], seen = new Set();
    let primary = null;
    for (const t of tags) {
      const a = g[t]?.units?.[unit];
      if (!a?.length) continue;
      if (!primary) primary = t;
      for (const e of a) {
        if (e.frame) { if (seen.has(e.frame)) continue; seen.add(e.frame); arr.push(e); }
        else if (t === primary) arr.push(e);
      }
    }
    out[k] = arr.map(e => ({ start: e.start, end: e.end, val: e.val, fp: e.fp, form: e.form, frame: e.frame, filed: e.filed }));
  }
  out.adj = {};
  for (const t of ADJ_TAGS) {
    const a = g[t]?.units?.USD;
    if (a?.length) out.adj[t] = a.map(e => ({ start: e.start, end: e.end, val: e.val, fp: e.fp, form: e.form, frame: e.frame, filed: e.filed }));
  }
  return out;
}

export function makeSplitFactor(splits) {
  return (end, filed) => {
    const tEnd = Date.parse(end) / 1000, tFiled = filed ? Date.parse(filed) / 1000 : 0;
    let f = 1;
    for (const s of splits) if (s.date > tEnd && s.date > tFiled) f *= s.ratio;
    return f;
  };
}

// trimestre calendario por el punto medio del período (sirve para ejercicios que no cierran en diciembre)
export const qkeyOf = end => { const d = new Date(Date.parse(end) - 45 * 86400000); return d.getUTCFullYear() + "Q" + (Math.floor(d.getUTCMonth() / 3) + 1); };

// EPS diluido trimestral (contable), por período real (sirve para ejercicios no calendario y trimestres de 12 o 16
// semanas, como COST). Por etiqueta: los trimestres informados (70 a 125 días) y los que faltan, como período
// acumulado menos el acumulado anterior del mismo ejercicio (anual - 9 meses, 9 meses - 6 meses, 6 meses - Q1).
// Si un período se presentó más de una vez (reexpresiones, comparativos), vale la última presentación. Después se
// combinan las etiquetas en el orden de EDGAR_TAGS.eps: un trimestre de una etiqueta posterior solo entra si no hay
// otro que cierre esa misma fecha (±10 días).
const DAY_MS = 86400000;
function quartersOf(facts, splitFactor) {
  const per = new Map();
  for (const e of facts) {
    if (!e.start || !e.end || !isFinite(e.val)) continue;
    const k = e.start + "|" + e.end, o = per.get(k);
    if (!o || (e.filed || "") > (o.filed || "")) per.set(k, { start: e.start, end: e.end, filed: e.filed, val: e.val / splitFactor(e.end, e.filed), s: Date.parse(e.start), t: Date.parse(e.end) });
  }
  const ps = [...per.values()], days = (a, b) => (b - a) / DAY_MS;
  const out = [];
  const near = t => out.some(q => Math.abs(q.t - t) <= 10 * DAY_MS);
  for (const p of ps.filter(p => days(p.s, p.t) >= 70 && days(p.s, p.t) <= 125).sort((a, b) => a.t - b.t)) if (!near(p.t)) out.push({ t: p.t, end: p.end, eps: p.val });
  const byStart = new Map();
  for (const p of ps) { if (!byStart.has(p.start)) byStart.set(p.start, []); byStart.get(p.start).push(p); }
  for (const g of byStart.values()) {
    g.sort((a, b) => a.t - b.t);
    for (const L of g) {
      if (near(L.t)) continue;
      const S = g.filter(x => x.t < L.t && days(x.t, L.t) >= 70 && days(x.t, L.t) <= 125).pop();
      if (S) out.push({ t: L.t, end: L.end, eps: L.val - S.val, derived: true });
    }
  }
  return out;
}
export const isContinuingTag = t => /ContinuingOperations/.test(t || "");
export function gaapQuarterly(raw, splitFactor, symbol) {
  const order = EDGAR_TAGS.eps[0], byTag = new Map();
  for (const e of raw.eps || []) { const t = e.tag || order[1]; if (!byTag.has(t)) byTag.set(t, []); byTag.get(t).push(e); }
  const merged = [];
  for (const t of order) {
    if (!byTag.has(t)) continue;
    for (const q of quartersOf(byTag.get(t), splitFactor)) {
      if (!isFinite(q.eps) || merged.some(m => Math.abs(m.t - q.t) <= 10 * DAY_MS)) continue;
      merged.push({ ...q, tag: t });
    }
  }
  const out = merged.sort((a, b) => a.t - b.t).map(q => ({ date: Math.floor(q.t / 1000), eps: +q.eps.toFixed(4), frame: "CY" + qkeyOf(q.end), end: q.end, tag: q.tag, derived: !!q.derived }));
  console.log(`pebg ${symbol}: EDGAR ${out.length} trimestres`);
  return out;
}

// ---- EPS normalizado ----
// Base: resultado operativo − intereses pagados + intereses ganados + resultado de asociadas (lo que queda debajo de
// la línea operativa, como ganancias por tenencias de acciones o diferencias de cambio, no entra). Bancos, aseguradoras
// y quienes no informan resultado operativo: resultado antes de impuestos.
// Extraordinarios: a la base se le suman los cargos puntuales y se le restan las ganancias puntuales, en toda la serie.
//   · Etiquetados en la SEC: reestructuraciones, deterioros (llave de negocio, intangibles, activos fijos), juicios,
//     costos de adquisiciones y resultado por venta de activos fijos. Por US GAAP (ASC 350, 360, 420) estos están dentro
//     del resultado operativo cuando la empresa lo presenta. Con base antes de impuestos se sacan además las ventas de
//     negocios, las tenencias de acciones a valor de mercado, la cancelación de deuda y las ganancias realizadas de
//     inversiones de las aseguradoras.
//   · Solo cuenta como extraordinario lo que excede el nivel habitual: el cargo menos la mediana de esa partida en los
//     12 trimestres anteriores (una reestructuración que aparece todos los trimestres es un costo del negocio), y solo
//     si mueve la base en 3% o más.
//   · I+D adquirida (compras de proyectos en desarrollo que se cargan a resultados de una vez, típico de farmacéuticas):
//     no se saca, se prorratea. Cada trimestre carga el promedio de los últimos 12 (el pico se reparte en 3 años), porque
//     comprar proyectos es un costo recurrente del negocio, aunque llegue a saltos.
//   · Si una reestructuración viene en una etiqueta que también incluye deterioros, no se suman los deterioros aparte
//     (mejor quedarse corto que contar dos veces).
//   · Lo que no está etiquetado (el juicio de META, por ejemplo) va a mano en data/norm_adj.json, con su fuente; si está
//     a mano, reemplaza a la etiqueta de la misma categoría en ese trimestre.
// Impuesto: la base ajustada se grava a la tasa típica (mediana de la tasa efectiva de los 12 trimestres previos, entre
// 5 y 35%). Como se vuelve a gravar el resultado limpio, que el cargo deduzca o no da igual para el normalizado (una
// multa que no deduce infla la tasa de ese trimestre, y la mediana la descarta); solo cambia cuánto le restó al
// EPS contable, que es el efecto por acción que se muestra.
// Acciones: resultado neto / EPS contable total (consistente con splits); si no, las de la SEC con control de escala.
// Además marca los trimestres con un margen operativo ajustado muy fuera de lo normal, para revisar si quedó algo puntual.
let NORM_ADJ = {};
try { NORM_ADJ = JSON.parse(readFileSync(new URL("./data/norm_adj.json", import.meta.url), "utf8")); } catch (e) { NORM_ADJ = {}; }
export const normAdjManual = () => NORM_ADJ;
const CAT_ES = { ipr: "I+D adquirida (prorrateada)", restr: "reestructuración", imp: "deterioro de activos", lit: "juicios y contingencias", acq: "costos de adquisición",
  ppe: "venta de activos fijos", biz: "venta de negocios", mtm: "tenencias de acciones", debt: "cancelación de deuda", inv: "ganancias realizadas de inversiones" };
export function normalizedQuarterly(raw, splitFactor, gaap, symbol) {
  if (!gaap.length) return { eps: [], method: null };
  const one = () => 1, TEN = 10 * DAY_MS;
  // trimestres por período; si falta el cuarto y no hay acumulado de 9 meses, anual menos los otros tres (en US$ se puede restar)
  const ser = arr => {
    const q = quartersOf(arr || [], one);
    const fy = (arr || []).filter(e => e.start && e.end && isFinite(e.val)).sort((a, b) => (b.filed || "").localeCompare(a.filed || ""));
    for (const e of fy) {
      const s0 = Date.parse(e.start), t = Date.parse(e.end), d = (t - s0) / DAY_MS;
      if (d < 350 || d > 380 || q.some(x => Math.abs(x.t - t) <= TEN)) continue;
      const inside = q.filter(x => x.t > s0 && x.t < t - TEN);
      if (inside.length === 3) q.push({ t, end: e.end, eps: e.val - inside.reduce((a, x) => a + x.eps, 0), derived: true });
    }
    return q.sort((a, b) => a.t - b.t);
  };
  const at = (sr, t) => { const x = sr.find(q => Math.abs(q.t - t) <= TEN); return x ? x.eps : undefined; };
  const OI = ser(raw.oi), PT = ser(raw.pt), TX = ser(raw.tx), NI = ser(raw.ni), REV = ser(raw.rev);
  const IE = ser(raw.ie), II = ser(raw.ii), EQ = ser(raw.eq);
  // si a un trimestre le falta el dato de intereses, el del trimestre anterior más cercano (es una serie estable)
  const steady = (sr, t) => { if (!sr.length) return 0; const v = at(sr, t); if (v !== undefined) return v; const prev = sr.filter(q => q.t <= t).pop() || sr[0]; return prev.eps; };
  const totalEps = gaap.filter(e => !isContinuingTag(e.tag)).map(e => ({ t: e.date * 1000, eps: e.eps }));
  const PRE = [];
  for (const q of PT.length ? PT : NI) {
    const pt = at(PT, q.t), ni = at(NI, q.t), tx = at(TX, q.t);
    const v = pt !== undefined ? pt : (ni !== undefined && tx !== undefined ? ni + tx : undefined);
    if (v !== undefined) PRE.push({ t: q.t, end: q.end, eps: v });
  }
  const lastT = gaap[gaap.length - 1].date * 1000;
  const reaches = sr => sr.length > 0 && sr[sr.length - 1].t >= lastT - 100 * DAY_MS;
  const method = reaches(OI) ? "operativo" : (reaches(PRE) ? "impuestos" : null);
  if (!method) return { eps: [], method: null };
  const BASE = method === "operativo" ? OI : PRE;

  // acciones implícitas = resultado neto / EPS total (ya ajustado por splits)
  const median = a => { const x = [...a].sort((p, q) => p - q); return x.length ? (x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2) : null; };
  const implied = new Map();
  for (const q of BASE) {
    const ni = at(NI, q.t), e = at(totalEps, q.t);
    if (ni !== undefined && e !== undefined && Math.abs(e) >= 0.05 && ni / e > 0) implied.set(q.t, ni / e);
  }
  const medImplied = median([...implied.values()]);
  const reported = [];
  for (const e of raw.sh || []) {
    if (!e.start || !(e.val > 0)) continue;
    const d = (Date.parse(e.end) - Date.parse(e.start)) / DAY_MS; if (d < 70 || d > 125) continue;
    let v = e.val * splitFactor(e.end, e.filed);
    if (medImplied) v = [1, 1e3, 1e6].map(sc => v * sc).reduce((best, x) => Math.abs(Math.log(x / medImplied)) < Math.abs(Math.log(best / medImplied)) ? x : best);
    reported.push({ t: Date.parse(e.end), eps: v });
  }
  const sharesFor = t => {
    if (implied.has(t)) return implied.get(t);
    const r = at(reported, t); if (r !== undefined) return r;
    const near = [...[...implied.entries()].map(([k, v]) => ({ t: k, v })), ...reported.map(x => ({ t: x.t, v: x.eps }))].sort((a, b) => a.t - b.t);
    const prev = near.filter(x => x.t <= t).pop() || near.find(x => x.t > t);
    return prev ? prev.v : null;
  };

  // partidas puntuales por categoría y trimestre (US$, signo: + cargo que se suma de vuelta, − ganancia que se resta)
  const A = raw.adj || {}, S = {};
  for (const t of ADJ_TAGS) if (A[t]) S[t] = ser(A[t]);
  const get = (t, tt) => S[t] ? at(S[t], tt) : undefined;
  const firstOf = (tags, tt) => { for (const t of tags) { const v = get(t, tt); if (v !== undefined) return { v, t }; } return null; };
  const catAt = tt => {
    const c = {}, T = {};   // T: etiqueta de la SEC de cada categoría, para mostrar de dónde sale
    const restr = firstOf(["RestructuringCharges", "RestructuringSettlementAndImpairmentProvisions", "RestructuringCostsAndAssetImpairmentCharges"], tt);
    if (restr) { c.restr = restr.v; T.restr = restr.t; }
    if (!restr || restr.t === "RestructuringCharges") {
      const gw = get("GoodwillAndIntangibleAssetImpairment", tt) ?? ((get("GoodwillImpairmentLoss", tt) || 0) + (get("ImpairmentOfIntangibleAssetsExcludingGoodwill", tt) || 0));
      const ll = (get("ImpairmentOfLongLivedAssetsHeldForUse", tt) || 0) + (get("ImpairmentOfLongLivedAssetsToBeDisposedOf", tt) || 0);
      const aic = get("AssetImpairmentCharges", tt) || 0, tot = Math.max(aic, (gw || 0) + ll);
      if (tot) {
        c.imp = tot;
        T.imp = aic >= (gw || 0) + ll ? "AssetImpairmentCharges" : ["GoodwillAndIntangibleAssetImpairment", "GoodwillImpairmentLoss", "ImpairmentOfIntangibleAssetsExcludingGoodwill",
          "ImpairmentOfLongLivedAssetsHeldForUse", "ImpairmentOfLongLivedAssetsToBeDisposedOf"].filter(t => get(t, tt)).join(" + ");
      }
    }
    const lit = firstOf(["LitigationSettlementExpense", "LossContingencyLossInPeriod"], tt); if (lit) { c.lit = lit.v; T.lit = lit.t; }
    const acq = get("BusinessCombinationAcquisitionRelatedCosts", tt); if (acq) { c.acq = acq; T.acq = "BusinessCombinationAcquisitionRelatedCosts"; }
    const ipr = firstOf(["ResearchAndDevelopmentAssetAcquiredOtherThanThroughBusinessCombinationWrittenOff", "ResearchAndDevelopmentInProcess"], tt); if (ipr) { c.ipr = ipr.v; T.ipr = ipr.t; }
    const ppe = firstOf(["GainLossOnSaleOfPropertyPlantEquipment", "GainLossOnDispositionOfAssets", "GainLossOnDispositionOfAssets1"], tt); if (ppe) { c.ppe = -ppe.v; T.ppe = ppe.t; }
    if (method === "impuestos") {
      const biz = firstOf(["GainLossOnSaleOfBusiness", "DisposalGroupNotDiscontinuedOperationGainLossOnDisposal"], tt); if (biz) { c.biz = -biz.v; T.biz = biz.t; }
      const mtm = get("EquitySecuritiesFvNiGainLoss", tt); if (mtm) { c.mtm = -mtm; T.mtm = "EquitySecuritiesFvNiGainLoss"; }
      const debt = get("GainsLossesOnExtinguishmentOfDebt", tt); if (debt) { c.debt = -debt; T.debt = "GainsLossesOnExtinguishmentOfDebt"; }
      const inv = get("RealizedInvestmentGainsLosses", tt); if (inv) { c.inv = -inv; T.inv = "RealizedInvestmentGainsLosses"; }
    }
    return { c, T };
  };
  const cats = BASE.map(q => catAt(q.t)), raws = cats.map(x => x.c);
  const manual = (NORM_ADJ[symbol] || []).map(m => ({ ...m, t: Date.parse(m.fin + "T00:00:00Z") }));
  const typical = (i, cat) => median(raws.slice(Math.max(0, i - 12), i).map(c => c[cat] || 0));
  const mean12 = (i, cat) => raws.slice(Math.max(0, i - 11), i + 1).reduce((a, c) => a + (c[cat] || 0), 0) / Math.min(12, i + 1);

  // tasa efectiva = impuesto / resultado antes de impuestos (si no está, resultado neto + impuesto)
  const etrAt = t => {
    const tx = at(TX, t); if (tx === undefined) return null;
    const pt = at(PT, t), ni = at(NI, t);
    const p = pt !== undefined ? pt : (ni !== undefined ? ni + tx : undefined);
    if (!(p > 0)) return null; const r = tx / p; return (r >= 0 && r <= 0.45) ? r : null;
  };
  const allRates = BASE.map(q => etrAt(q.t)).filter(r => r != null);
  const globalRate = allRates.length >= 4 ? median(allRates) : 0.21;
  const out = [], adj = [], margins = [], rows = [];
  BASE.forEach((q, i) => {
    const win = BASE.slice(Math.max(0, i - 11), i + 1).map(x => etrAt(x.t)).filter(r => r != null);
    const tax = Math.min(0.35, Math.max(0.05, win.length >= 4 ? median(win) : globalRate));
    const sh = sharesFor(q.t);
    const base = method === "operativo" ? q.eps - steady(IE, q.t) + steady(II, q.t) + (at(EQ, q.t) || 0) : q.eps;
    // etiquetados: solo lo que excede el nivel habitual y mueve la base 3% o más
    const man = manual.filter(m => Math.abs(m.t - q.t) <= 20 * DAY_MS);
    const items = [];
    const iprLive = raws.slice(Math.max(0, i - 11), i + 1).some(c => c.ipr);
    for (const cat of new Set([...Object.keys(raws[i]), ...(iprLive ? ["ipr"] : [])])) {
      if (man.some(m => m.cat === cat)) continue;
      const v = raws[i][cat] || 0, smooth = cat === "ipr", typ = smooth ? mean12(i, cat) : typical(i, cat), ex = v - typ;
      if (Math.abs(ex) >= Math.max(5e6, 0.03 * Math.abs(base)))
        items.push({ cat, pre: ex, src: "SEC", tag: cats[i].T[cat] || cats.slice(Math.max(0, i - 11), i).map(x => x.T[cat]).filter(Boolean).pop(), informado: v, habitual: typ, ...(smooth ? { regla: "promedio12" } : {}) });
    }
    for (const m of man) items.push({ cat: m.cat || "lit", pre: m.pre * 1e6, src: "manual", desc: m.desc, fuente: m.fuente, noDeduce: m.deducible === false });
    const addBack = items.reduce((a, x) => a + x.pre, 0);
    if (method === "operativo") { const rv = at(REV, q.t); if (rv > 0) margins.push({ i, t: q.t, end: q.end, m: (q.eps + addBack) / rv }); }
    // importes en millones de US$; eps = lo que le restó (o sumó) al EPS contable: neto de impuestos, o entero si no deduce
    if (items.length) adj.push({ fin: q.end, base: +(base / 1e6).toFixed(1), tasa: +tax.toFixed(3),
      items: items.map(x => ({ ...x, cat: CAT_ES[x.cat] || x.cat, pre: +(x.pre / 1e6).toFixed(1), eps: sh ? +((x.noDeduce ? x.pre : x.pre * (1 - tax)) / sh).toFixed(3) : null,
        ...(x.src === "SEC" ? { informado: +(x.informado / 1e6).toFixed(1), habitual: +(x.habitual / 1e6).toFixed(1) } : {}) })) });
    const M = v => v == null ? null : +(v / 1e6).toFixed(1);
    rows.push({ fin: q.end, base: M(base), ajuste: M(addBack), tasa: +tax.toFixed(3), acciones: sh ? M(sh) : null, antesImp: M(at(PT, q.t)), impuesto: M(at(TX, q.t)), neto: M(at(NI, q.t)) });
    if (!sh) return;
    const eps = (base + addBack) * (1 - tax) / sh;
    if (isFinite(eps)) out.push({ date: Math.floor(q.t / 1000), eps: +eps.toFixed(4), frame: "CY" + qkeyOf(q.end) });
  });
  // margen operativo ajustado fuera de lo normal: más de 2,5 desvíos y más de 4 puntos contra los 8 trimestres previos
  const flags = [];
  margins.forEach((x, j) => {
    const prev = margins.slice(Math.max(0, j - 8), j).map(y => y.m);
    if (prev.length < 6) return;
    const mu = prev.reduce((a, b) => a + b, 0) / prev.length, sd = Math.sqrt(prev.reduce((a, b) => a + (b - mu) ** 2, 0) / prev.length);
    if (Math.abs(x.m - mu) > Math.max(2.5 * sd, 0.04)) flags.push({ fin: x.end, margen: +(x.m * 100).toFixed(1), media: +(mu * 100).toFixed(1) });
  });
  return { eps: out, method, adj, flags, rows };
}

// acciones diluidas por trimestre, ajustadas por splits (para ponderar en los agregados de índice y sector):
// resultado neto / EPS contable cuando el EPS no es casi cero; si no, el dato de acciones de EDGAR con control
// de escala. Devuelve [{ date, shares }] ordenado.
export function sharesQuarterly(raw, splitFactor, gaap) {
  const NI = new Map();
  for (const e of raw.ni) if (/^CY\d{4}Q\d$/.test(e.frame || "")) NI.set(qkeyOf(e.end), e.val);
  const out = new Map();
  for (const g of gaap) {
    if (isContinuingTag(g.tag)) continue;   // el resultado neto incluye lo discontinuado: no se divide por el EPS continuo
    const k = g.frame.slice(2), ni = NI.get(k);
    if (ni != null && Math.abs(g.eps) >= 0.05 && ni / g.eps > 0) out.set(k, { date: g.date, shares: ni / g.eps });
  }
  const med = (() => { const v = [...out.values()].map(x => x.shares).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; })();
  for (const e of raw.sh) {
    if (!/^CY\d{4}Q\d$/.test(e.frame || "") || !(e.val > 0)) continue;
    const k = qkeyOf(e.end);
    if (out.has(k)) continue;
    let v = e.val * splitFactor(e.end, e.filed);
    if (med) v = [1, 1e3, 1e6].map(s => v * s).reduce((best, x) => Math.abs(Math.log(x / med)) < Math.abs(Math.log(best / med)) ? x : best);
    out.set(k, { date: Math.floor(Date.parse(e.end) / 1000), shares: v });
  }
  return [...out.values()].sort((a, b) => a.date - b.date);
}

// empresas que cambiaron de CIK (reorganización como holding): la historia está en el registro anterior
export const PREDECESSOR_CIK = { XOM: "0000034088", GOOGL: "0001288776", GOOG: "0001288776" };   // Alphabet: la historia está en Google Inc.
// EPS informado por otra clase de acción que la que cotiza en el índice: BRK lo publica por acción A (1 A = 1.500 B)
export const EPS_PER_SHARE_DIV = { "BRK-B": 1500 };
// une los datos crudos de dos registros; manda el nuevo y el viejo completa los períodos que faltan
export function mergeRaw(newer, older) {
  if (!older) return newer;
  if (!newer) return older;
  const out = {};
  for (const k of new Set([...Object.keys(newer), ...Object.keys(older)])) {
    if (k === "adj") {   // por etiqueta
      out.adj = {};
      for (const t of new Set([...Object.keys(newer.adj || {}), ...Object.keys(older.adj || {})])) out.adj[t] = mergeRaw({ x: (newer.adj || {})[t] || [] }, { x: (older.adj || {})[t] || [] }).x;
      continue;
    }
    const a = newer[k] || [], b = older[k] || [];
    const key = e => (e.tag || "") + "|" + (e.frame || (e.start + e.end + e.fp));
    const seen = new Set(a.map(key));
    out[k] = [...b.filter(e => !seen.has(key(e))), ...a];
  }
  return out;
}
// resultado neto trimestral (frames CY####Q#; el trimestre faltante = anual - los otros 3)
export function netIncomeQuarterly(raw) {
  const q = new Map();
  for (const e of raw.ni) if (/^CY\d{4}Q\d$/.test(e.frame || "")) q.set(qkeyOf(e.end), { end: e.end, start: e.start, val: e.val });
  for (const a of raw.ni) {
    if (!/^CY\d{4}$/.test(a.frame || "") || !a.start) continue;
    const inside = [...q.values()].filter(x => x.start && x.start >= a.start && x.end <= a.end);
    const k = qkeyOf(a.end);
    if (inside.length === 3 && !q.has(k)) q.set(k, { end: a.end, start: null, val: a.val - inside.reduce((t, x) => t + x.val, 0) });
  }
  return [...q.values()].map(x => ({ date: Math.floor(Date.parse(x.end) / 1000), ni: x.val })).sort((a, b) => a.date - b.date);
}
