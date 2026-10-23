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
  nic: [["NetIncomeLossAvailableToCommonStockholdersBasic"], "USD"],          // resultado para los comunes (sin preferidos)
  pl: [["ProfitLoss"], "USD"],                                               // resultado con los minoritarios
  nci: [["NetIncomeLossAttributableToNoncontrollingInterest"], "USD"],
  ncir: [["NetIncomeLossAttributableToRedeemableNoncontrollingInterest"], "USD"],          // algunas lo parten en dos
  ncin: [["NetIncomeLossAttributableToNonredeemableNoncontrollingInterest"], "USD"],
  pref: [["PreferredStockDividendsIncomeStatementImpact", "DividendsPreferredStock"], "USD"],
  afudc: [["PublicUtilitiesAllowanceForFundsUsedDuringConstructionCapitalizedCostOfEquity"], "USD"],
};
// partidas puntuales para el EPS normalizado: cada etiqueta por separado (se combinan con reglas propias)
export const ADJ_TAGS = [
  "RestructuringCharges", "RestructuringSettlementAndImpairmentProvisions", "RestructuringCostsAndAssetImpairmentCharges",
  "GoodwillImpairmentLoss", "GoodwillAndIntangibleAssetImpairment", "ImpairmentOfIntangibleAssetsExcludingGoodwill",
  "ImpairmentOfLongLivedAssetsHeldForUse", "ImpairmentOfLongLivedAssetsToBeDisposedOf", "AssetImpairmentCharges", "ImpairmentOfOilAndGasProperties",
  "LitigationSettlementExpense", "LossContingencyLossInPeriod", "BusinessCombinationAcquisitionRelatedCosts",
  "GainLossOnSaleOfPropertyPlantEquipment", "GainLossOnDispositionOfAssets", "GainLossOnDispositionOfAssets1",
  "GainLossOnSaleOfBusiness", "DisposalGroupNotDiscontinuedOperationGainLossOnDisposal", "EquitySecuritiesFvNiGainLoss",
  "GainsLossesOnExtinguishmentOfDebt", "RealizedInvestmentGainsLosses",
  "ResearchAndDevelopmentAssetAcquiredOtherThanThroughBusinessCombinationWrittenOff", "ResearchAndDevelopmentInProcess",
  // solo para explicar lo que hay entre el operativo y el antes de impuestos (no son ajustes)
  "BusinessCombinationContingentConsiderationArrangementsChangeInAmountOfContingentConsiderationLiability1",
  "ForeignCurrencyTransactionGainLossBeforeTax", "DefinedBenefitPlanNetPeriodicBenefitCostCreditExcludingServiceCost",
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
  out.adj = {}; out.cd = {};
  for (const [dest, tags] of [["adj", ADJ_TAGS], ["cd", CD_TAGS]]) for (const t of tags) {
    const a = g[t]?.units?.USD;
    if (a?.length) out[dest][t] = a.map(e => ({ start: e.start, end: e.end, val: e.val, fp: e.fp, form: e.form, frame: e.frame, filed: e.filed }));
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
// flujo de caja (períodos) y balance (saldos) para P/FCF, EV/EBIT y deuda neta / EBITDA
export const CD_TAGS = [
  "NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  "PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements", "PaymentsToDevelopSoftware",
  "ShareBasedCompensation", "AllocatedShareBasedCompensationExpense",
  "DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization", "Depreciation", "AmortizationOfIntangibleAssets",
  "CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  "ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
  "LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermDebt", "DebtCurrent", "LongTermDebtCurrent",
  "LongTermDebtAndCapitalLeaseObligationsCurrent", "ShortTermBorrowings", "CommercialPaper",
  "MinorityInterest", "PreferredStockValue",
];
// combinan las etiquetas en el orden de EDGAR_TAGS.eps: un trimestre de una etiqueta posterior solo entra si no hay
// otro que cierre esa misma fecha (±10 días).
const DAY_MS = 86400000;
// Un período anual que aparece en un 10-Q es casi siempre un error de etiquetado de la empresa (FIX cargó en su 10-Q de
// 2026 el primer trimestre de 2025 con fecha de todo el año): para los períodos de un año manda el 10-K.
const isK = f => /^10-K/.test(f || "");
export function betterFact(e, o, annual) {
  if (annual && isK(e.form) !== isK(o.form)) return isK(e.form);
  return (e.filed || "") > (o.filed || "");
}
// Al derivar un trimestre (acumulado largo menos el corto), el corto se toma en la versión presentada hasta la fecha del
// largo: si la empresa reexpresó después los nueve meses (un negocio que pasó a discontinuadas), restarle esa versión al
// anual viejo mezcla dos bases y el cuarto trimestre sale inflado.
function quartersOf(facts, splitFactor) {
  const per = new Map();
  for (const e of facts) {
    if (!e.start || !e.end || !isFinite(e.val)) continue;
    const k = e.start + "|" + e.end, o = per.get(k), annual = (Date.parse(e.end) - Date.parse(e.start)) / DAY_MS > 300;
    const v = { start: e.start, end: e.end, filed: e.filed, form: e.form, val: e.val / splitFactor(e.end, e.filed), s: Date.parse(e.start), t: Date.parse(e.end) };
    const vers = o ? o.vers : [];
    vers.push(v);
    if (!o || betterFact(e, o, annual)) per.set(k, { ...v, vers }); else o.vers = vers;
  }
  const asOf = (S, filed) => { const ok = S.vers.filter(v => (v.filed || "") <= (filed || "")).sort((a, b) => (a.filed || "").localeCompare(b.filed || "")); return ok.length ? ok[ok.length - 1] : S; };
  const ps = [...per.values()], days = (a, b) => (b - a) / DAY_MS;
  const out = [];
  const near = t => out.some(q => Math.abs(q.t - t) <= 10 * DAY_MS);
  // un trimestre cargado con el valor del año entero (LHX en su 10-K de 2025): si coincide con el anual que cierra el mismo
  // día y están los nueve meses, el trimestre es el anual menos los nueve meses
  const fixQ = p => {
    const L = ps.find(x => x.end === p.end && days(x.s, x.t) > 300 && Math.abs(x.val) > 0 && Math.abs(p.val - x.val) <= 0.005 * Math.abs(x.val));
    if (!L) return null;
    const S = ps.find(x => x.start === L.start && Math.abs(days(x.t, p.s)) <= 5 && x.t < p.t);
    return S ? L.val - asOf(S, L.filed).val : null;
  };
  for (const p of ps.filter(p => days(p.s, p.t) >= 70 && days(p.s, p.t) <= 125).sort((a, b) => a.t - b.t)) {
    if (near(p.t)) continue;
    const f = fixQ(p);
    out.push(f != null ? { t: p.t, end: p.end, eps: f, derived: true } : { t: p.t, end: p.end, eps: p.val });
  }
  const byStart = new Map();
  for (const p of ps) { if (!byStart.has(p.start)) byStart.set(p.start, []); byStart.get(p.start).push(p); }
  for (const g of byStart.values()) {
    g.sort((a, b) => a.t - b.t);
    for (const L of g) {
      if (near(L.t)) continue;
      const S = g.filter(x => x.t < L.t && days(x.t, L.t) >= 70 && days(x.t, L.t) <= 125).pop();
      if (S) out.push({ t: L.t, end: L.end, eps: L.val - asOf(S, L.filed).val, derived: true });
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
// Es la ganancia de un trimestre normal, con el mismo criterio para todas las empresas y toda la historia.
// Base (método operativo): resultado operativo + los resultados recurrentes de abajo de la línea operativa: intereses
// (pagados y ganados), resultado de asociadas y, en las eléctricas, el AFUDC (retorno sobre obras en curso). Lo demás que
// está abajo de la línea (tenencias de acciones, diferencias de cambio, ventas de negocios) queda afuera.
//   Algunas empresas tienen los intereses o las asociadas dentro del resultado operativo (las aseguradoras de salud
//   cobran intereses como ingreso; las automotrices pagan los de su financiera como costo). Para no contarlos dos veces se
//   prueba qué armado reproduce mejor el resultado antes de impuestos de la empresa, y solo se cambia el de siempre si el
//   otro explica la diferencia mucho mejor.
// Bancos, aseguradoras y quienes no informan resultado operativo: resultado antes de impuestos (método impuestos).
// Extraordinarios: a la base se le suman los cargos puntuales y se le restan las ganancias puntuales, en toda la serie.
//   · Etiquetados en la SEC: reestructuraciones, deterioros (llave de negocio, intangibles, activos fijos), juicios,
//     costos de adquisiciones, I+D adquirida y resultado por venta de activos fijos. Por US GAAP (ASC 350, 360, 420)
//     están dentro del resultado operativo cuando la empresa lo presenta. Con base antes de impuestos se sacan además
//     las ventas de negocios, las tenencias de acciones, la cancelación de deuda y las ganancias realizadas de inversiones.
//   · Solo cuenta lo que excede el nivel habitual: la partida menos su mediana de los 12 trimestres anteriores (una
//     reestructuración de todos los trimestres es un costo del negocio), y solo si mueve la base 3% o más.
//   · Control de que el monto esté en la base: muchas de estas etiquetas salen del flujo de caja, que suma también lo
//     de operaciones discontinuadas o de abajo de la línea. Si al ajustar la base se aleja de su nivel típico (mediana
//     de los 8 trimestres previos) en vez de acercarse, el ajuste no se hace y queda anotado como descartado.
//   · I+D adquirida: en una compra de activos se carga a resultados; en la compra de una empresa el mismo proyecto se
//     activa. Se saca lo que excede lo habitual para que las dos formas den igual.
//   · Si la reestructuración viene en una etiqueta que ya incluye deterioros, no se suman los deterioros aparte.
//   · Lo que no está etiquetado (los juicios de META, por ejemplo) va a mano en data/norm_adj.json, con su fuente; si
//     está a mano, reemplaza a la etiqueta de la misma categoría en ese trimestre.
// Impuesto: la base ajustada se grava a la tasa típica: mediana de la tasa efectiva de los 12 trimestres previos (se
// toman las de −25% a 45%, así entran las eléctricas con créditos fiscales), acotada entre 0 y 35%. Que un cargo deduzca
// o no da igual para el normalizado; solo cambia cuánto le restó al EPS contable, que es el efecto que se muestra.
// Minoritarios: se descuenta la parte de los socios minoritarios (mediana de los últimos 8 trimestres de su parte en la
// ganancia), clave en las empresas con estructura de sociedad (IBKR, BX, TKO). Dividendos preferidos: se restan.
// Acciones: las diluidas que informa la empresa, si coinciden (±15%) con las implícitas (resultado / EPS); si no, las
// implícitas.
// Además marca los trimestres con un margen operativo ajustado muy fuera de lo normal, para revisar si quedó algo puntual.
let NORM_ADJ = {};
try { NORM_ADJ = JSON.parse(readFileSync(new URL("./data/norm_adj.json", import.meta.url), "utf8")); } catch (e) { NORM_ADJ = {}; }
export const normAdjManual = () => NORM_ADJ;
const CAT_ES = { ipr: "I+D adquirida", restr: "reestructuración", imp: "deterioro de activos", lit: "juicios y contingencias", acq: "costos de adquisición",
  ppe: "venta de activos fijos", biz: "venta de negocios", mtm: "tenencias de acciones", debt: "cancelación de deuda", inv: "ganancias realizadas de inversiones" };
const median = a => { const x = [...a].sort((p, q) => p - q); return x.length ? (x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2) : null; };
export function normalizedQuarterly(raw, splitFactor, gaap, symbol) {
  if (!gaap.length) return { eps: [], method: null };
  const one = () => 1, TEN = 10 * DAY_MS;
  // trimestres por período; si falta el cuarto y no hay acumulado de 9 meses, anual menos los otros tres (en US$ se puede restar)
  const ser = arr => {
    const q = quartersOf(arr || [], one);
    const fy = (arr || []).filter(e => e.start && e.end && isFinite(e.val)).sort((a, b) => (isK(b.form) - isK(a.form)) || (b.filed || "").localeCompare(a.filed || ""));
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
  const IE = ser(raw.ie), II = ser(raw.ii), EQ = ser(raw.eq), AF = ser(raw.afudc);
  const NIC = ser(raw.nic), PL = ser(raw.pl), PREF = ser(raw.pref);
  const NCI0 = ser(raw.nci), NCIR = ser(raw.ncir), NCIN = ser(raw.ncin);
  const nciVal = t => { const a = at(NCI0, t); if (a !== undefined) return a; const r = at(NCIR, t), n = at(NCIN, t); return r === undefined && n === undefined ? undefined : (r || 0) + (n || 0); };
  // si a un trimestre le falta el dato de intereses, el del trimestre anterior más cercano (es una serie estable)
  const steady = (sr, t) => { if (!sr.length) return 0; const v = at(sr, t); if (v !== undefined) return v; const prev = sr.filter(q => q.t <= t).pop() || sr[0]; return prev.eps; };
  const totalEps = gaap.filter(e => !isContinuingTag(e.tag)).map(e => ({ t: e.date * 1000, eps: e.eps }));
  const PRE = [];
  for (const q of PT.length ? PT : NI) {
    const pt = at(PT, q.t), ni = at(NI, q.t), tx = at(TX, q.t);
    const v = pt !== undefined ? pt : (ni !== undefined && tx !== undefined ? ni + tx : undefined);
    if (v !== undefined) PRE.push({ t: q.t, end: q.end, eps: v });
  }
  const A = raw.adj || {}, S = {};
  for (const t of ADJ_TAGS) if (A[t]) S[t] = ser(A[t]);
  const get = (t, tt) => S[t] ? at(S[t], tt) : undefined;
  // partidas conocidas de abajo de la línea que no son del negocio: tenencias, diferencias de cambio, cancelación de
  // deuda, cambio de valor de pagos contingentes por compras (ABBV) y costo de pensiones sin el del servicio
  const knownNonOp = t => (get("EquitySecuritiesFvNiGainLoss", t) || 0) + (get("ForeignCurrencyTransactionGainLossBeforeTax", t) || 0)
    + (get("GainsLossesOnExtinguishmentOfDebt", t) || 0) - (get("BusinessCombinationContingentConsiderationArrangementsChangeInAmountOfContingentConsiderationLiability1", t) || 0)
    - (get("DefinedBenefitPlanNetPeriodicBenefitCostCreditExcludingServiceCost", t) || 0);
  const lastT = gaap[gaap.length - 1].date * 1000;
  const reaches = sr => sr.length > 0 && sr[sr.length - 1].t >= lastT - 100 * DAY_MS;
  let method = reaches(OI) ? "operativo" : (reaches(PRE) ? "impuestos" : null), motivo = null;
  if (!method) return { eps: [], method: null };
  // eléctricas (informan AFUDC): lo de abajo de la línea (AFUDC, créditos de pensiones, intereses ganados) es parte del
  // negocio regulado, así que la base es el resultado antes de impuestos
  if (method === "operativo" && reaches(PRE) && AF.some(q => q.t >= lastT - 3 * 365 * DAY_MS)) { method = "impuestos"; motivo = "eléctrica"; }

  // armado de la base: qué partidas de abajo de la línea operativa suman (fuera = la empresa las tiene abajo de la línea).
  // Hipótesis: cada una de intereses pagados, ganados y asociadas, adentro o afuera del operativo; se elige la que mejor
  // reproduce PT − OI, pero solo se deja la de siempre (todo afuera) si otra baja el error a menos de 40% y a menos de
  // la cuarta parte del interés.
  let inOI = { ie: false, ii: false, eq: false };
  if (method === "operativo") {
    const qs = OI.filter(q => at(PT, q.t) !== undefined && q.t >= lastT - 4 * 365 * DAY_MS).slice(-16);
    if (qs.length >= 6) {
      const res = h => median(qs.map(q => Math.abs((at(PT, q.t) - q.eps) - (-(h.ie ? 0 : steady(IE, q.t)) + (h.ii ? 0 : steady(II, q.t)) + (h.eq ? 0 : (at(EQ, q.t) || 0)) + (at(AF, q.t) || 0)))));
      const H = [];
      for (const ie of [false, true]) for (const ii of [false, true]) for (const eq of [false, true]) H.push({ ie, ii, eq, r: res({ ie, ii, eq }) });
      const def = H[0], best = H.slice(1).sort((a, b) => a.r - b.r)[0];
      const scale = Math.max(median(qs.map(q => Math.abs(steady(IE, q.t)))), median(qs.map(q => Math.abs(steady(II, q.t)))), 1);
      if (best && best.r < 0.4 * def.r && best.r < 0.25 * scale) inOI = { ie: best.ie, ii: best.ii, eq: best.eq };
      // Lo que queda sin explicar entre el antes de impuestos y el operativo: si es negativo y sistemático (más de 10%
      // del operativo, mediana de 4 años), hay costos recurrentes abajo de la línea o lo que la empresa etiqueta como
      // operativo no es el consolidado (DIS informa el de sus segmentos, sin los gastos corporativos): base antes de
      // impuestos. Si es positivo (ganancias de tenencias, como GOOGL o AMZN), queda afuera, que es lo conservador.
      const h = inOI, oiMed = median(qs.map(q => Math.abs(q.eps)));
      const signed = median(qs.map(q => (at(PT, q.t) - q.eps) - (-(h.ie ? 0 : steady(IE, q.t)) + (h.ii ? 0 : steady(II, q.t)) + (h.eq ? 0 : (at(EQ, q.t) || 0)) + (at(AF, q.t) || 0)) - knownNonOp(q.t)));
      if (reaches(PRE) && oiMed > 0 && signed < -0.10 * oiMed) { method = "impuestos"; motivo = "costos recurrentes abajo del operativo"; inOI = { ie: false, ii: false, eq: false }; }
    }
  }
  const BASE = method === "operativo" ? OI : PRE;
  const baseOf = q => method === "operativo"
    ? q.eps - (inOI.ie ? 0 : steady(IE, q.t)) + (inOI.ii ? 0 : steady(II, q.t)) + (inOI.eq ? 0 : (at(EQ, q.t) || 0)) + (at(AF, q.t) || 0)
    : q.eps;

  // acciones: implícitas = resultado para los comunes / EPS (el total; si no está, el de operaciones continuas);
  // las informadas, en la escala que más se acerque a las implícitas de ese trimestre, si en general coinciden (±15%)
  const anyEps = gaap.map(e => ({ t: e.date * 1000, eps: e.eps }));
  const implied = new Map();
  for (const q of BASE) {
    const ni = at(NIC, q.t) ?? at(NI, q.t), e = at(totalEps, q.t) ?? at(anyEps, q.t);
    if (ni !== undefined && e !== undefined && Math.abs(e) >= 0.05 && ni / e > 0) implied.set(q.t, ni / e);
  }
  const impList = [...implied.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
  const nearImp = t => { let best = null; for (const x of impList) if (!best || Math.abs(x.t - t) < Math.abs(best.t - t)) best = x; return best; };
  const reported = [];
  for (const e of raw.sh || []) {
    if (!e.start || !(e.val > 0)) continue;
    const d = (Date.parse(e.end) - Date.parse(e.start)) / DAY_MS; if (d < 70 || d > 125) continue;
    const t = Date.parse(e.end), ref = nearImp(t);
    let v = e.val * splitFactor(e.end, e.filed);
    if (ref) v = [1, 1e3, 1e6].map(sc => v * sc).reduce((best, x) => Math.abs(Math.log(x / ref.v)) < Math.abs(Math.log(best / ref.v)) ? x : best);
    if (!reported.some(r => Math.abs(r.t - t) <= TEN)) reported.push({ t, eps: v });
  }
  const pairs = reported.map(r => { const i = implied.get([...implied.keys()].find(k => Math.abs(k - r.t) <= TEN)); return i ? Math.abs(r.eps / i - 1) : null; }).filter(x => x != null);
  const repOk = reported.length > 0 && (pairs.length ? median(pairs) <= 0.15 : !impList.length);
  const sharesFor = t => {
    const r = repOk ? at(reported, t) : undefined; if (r !== undefined) return r;
    const i = [...implied.keys()].find(k => Math.abs(k - t) <= TEN); if (i !== undefined) return implied.get(i);
    // sin dato ese trimestre: el más cercano, solo si está a menos de 200 días
    const cands = [...impList.map(x => ({ t: x.t, v: x.v })), ...(repOk ? reported.map(x => ({ t: x.t, v: x.eps })) : [])];
    let best = null; for (const x of cands) if (!best || Math.abs(x.t - t) < Math.abs(best.t - t)) best = x;
    return best && Math.abs(best.t - t) <= 200 * DAY_MS ? best.v : null;
  };
  // parte de los minoritarios en la ganancia: de las etiquetas; si no están o dan poco, la que se deduce de
  // 1 − resultado de los accionistas / (antes de impuestos − impuesto), si es estable (sociedades como BX o TKO, que
  // informan la parte de los socios con etiquetas propias)
  const inferredNci = i => {
    const v = BASE.slice(Math.max(0, i - 7), i + 1).map(x => { const pt = at(PT, x.t), tx = at(TX, x.t), ni = at(NI, x.t);
      return pt !== undefined && tx !== undefined && ni !== undefined && pt - tx > 0 && ni > 0 ? 1 - ni / (pt - tx) : null; }).filter(r => r != null).sort((a, b) => a - b);
    if (v.length < 4) return null;
    const m = median(v), iqr = v[Math.floor(v.length * 0.75)] - v[Math.floor(v.length * 0.25)];
    return m >= 0.15 && m < 0.95 && iqr <= 0.15 ? m : null;
  };
  const nciAt = t => {
    const n = nciVal(t); if (n === undefined) return null;
    const pl = at(PL, t) ?? ((at(NI, t) ?? undefined) !== undefined ? at(NI, t) + n : undefined);
    if (!(pl > 0)) return null; const r = n / pl; return r >= 0 && r < 0.95 ? r : null;
  };

  // partidas puntuales por categoría y trimestre (US$, signo: + cargo que se suma de vuelta, − ganancia que se resta)
  const firstOf = (tags, tt) => { for (const t of tags) { const v = get(t, tt); if (v !== undefined) return { v, t }; } return null; };
  const catAt = tt => {
    const c = {}, T = {};   // T: etiqueta de la SEC de cada categoría, para mostrar de dónde sale
    const restr = firstOf(["RestructuringCharges", "RestructuringSettlementAndImpairmentProvisions", "RestructuringCostsAndAssetImpairmentCharges"], tt);
    if (restr) { c.restr = restr.v; T.restr = restr.t; }
    if (!restr || restr.t === "RestructuringCharges") {
      const gw = get("GoodwillAndIntangibleAssetImpairment", tt) ?? ((get("GoodwillImpairmentLoss", tt) || 0) + (get("ImpairmentOfIntangibleAssetsExcludingGoodwill", tt) || 0));
      const ll = (get("ImpairmentOfLongLivedAssetsHeldForUse", tt) || 0) + (get("ImpairmentOfLongLivedAssetsToBeDisposedOf", tt) || 0) + (get("ImpairmentOfOilAndGasProperties", tt) || 0);
      const aic = get("AssetImpairmentCharges", tt) || 0, tot = Math.max(aic, (gw || 0) + ll);
      if (tot) {
        c.imp = tot;
        T.imp = aic >= (gw || 0) + ll ? "AssetImpairmentCharges" : ["GoodwillAndIntangibleAssetImpairment", "GoodwillImpairmentLoss", "ImpairmentOfIntangibleAssetsExcludingGoodwill",
          "ImpairmentOfLongLivedAssetsHeldForUse", "ImpairmentOfLongLivedAssetsToBeDisposedOf", "ImpairmentOfOilAndGasProperties"].filter(t => get(t, tt)).join(" + ");
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

  // tasa efectiva = impuesto / resultado antes de impuestos (si no está, resultado neto + impuesto)
  const etrAt = t => {
    const tx = at(TX, t); if (tx === undefined) return null;
    const pt = at(PT, t), ni = at(NI, t);
    const p = pt !== undefined ? pt : (ni !== undefined ? ni + tx : undefined);
    if (!(p > 0)) return null; const r = tx / p; return (r >= -0.25 && r <= 0.45) ? r : null;
  };
  const allRates = BASE.map(q => etrAt(q.t)).filter(r => r != null);
  const globalRate = allRates.length >= 4 ? median(allRates) : 0.21;
  const out = [], adj = [], margins = [], rows = [], adjBases = [];
  BASE.forEach((q, i) => {
    const win = BASE.slice(Math.max(0, i - 11), i + 1).map(x => etrAt(x.t)).filter(r => r != null);
    const tax = Math.min(0.35, Math.max(0, win.length >= 4 ? median(win) : globalRate));
    const sh = sharesFor(q.t);
    const base = baseOf(q);
    const man = manual.filter(m => Math.abs(m.t - q.t) <= 20 * DAY_MS);
    // a mano primero (verificados); después los etiquetados, de mayor a menor, con el control de que estén en la base
    const items = man.map(m => ({ cat: m.cat || "lit", pre: m.pre * 1e6, src: "manual", desc: m.desc, fuente: m.fuente, noDeduce: m.deducible === false }));
    const cand = [];
    for (const [cat, v] of Object.entries(raws[i])) {
      if (man.some(m => m.cat === cat)) continue;
      const typ = typical(i, cat), ex = v - typ;
      if (Math.abs(ex) >= Math.max(5e6, 0.03 * Math.abs(base))) cand.push({ cat, pre: ex, src: "SEC", tag: cats[i].T[cat], informado: v, habitual: typ });
    }
    const prevB = adjBases.slice(-8), typB = prevB.length >= 4 ? median(prevB) : null;
    let cur = base + items.reduce((a, x) => a + x.pre, 0);
    for (const x of cand.sort((a, b) => Math.abs(b.pre) - Math.abs(a.pre))) {
      if (typB != null && Math.abs(cur + x.pre - typB) > Math.abs(cur - typB) + 0.35 * Math.abs(typB)) { items.push({ ...x, descartado: true }); continue; }
      cur += x.pre; items.push(x);
    }
    const addBack = items.filter(x => !x.descartado).reduce((a, x) => a + x.pre, 0);
    adjBases.push(base + addBack);
    if (method === "operativo") { const rv = at(REV, q.t); if (rv > 0) margins.push({ i, t: q.t, end: q.end, m: (q.eps + addBack) / rv }); }
    const nciW = BASE.slice(Math.max(0, i - 7), i + 1).map(x => nciAt(x.t)).filter(r => r != null);
    let nci = nciW.length ? median(nciW) : 0; const inf = inferredNci(i); if (inf != null && inf > nci + 0.10) nci = inf;
    const pref = at(PREF, q.t) || 0;
    // importes en millones de US$; eps = lo que le restó (o sumó) al EPS contable: neto de impuestos, o entero si no deduce
    if (items.length) adj.push({ fin: q.end, base: +(base / 1e6).toFixed(1), tasa: +tax.toFixed(3),
      items: items.map(x => ({ ...x, cat: CAT_ES[x.cat] || x.cat, pre: +(x.pre / 1e6).toFixed(1),
        eps: sh && !x.descartado ? +((x.noDeduce ? x.pre : x.pre * (1 - tax)) * (1 - nci) / sh).toFixed(3) : null,
        ...(x.src === "SEC" ? { informado: +(x.informado / 1e6).toFixed(1), habitual: +(x.habitual / 1e6).toFixed(1) } : {}) })) });
    const M = v => v == null ? null : +(v / 1e6).toFixed(1);
    // EBIT ajustado: el operativo sin los extraordinarios (con base antes de impuestos, más los intereses pagados)
    const ebit = method === "operativo" ? q.eps + addBack : q.eps + steady(IE, q.t) + addBack;
    rows.push({ fin: q.end, base: M(base), ajuste: M(addBack), tasa: +tax.toFixed(3), minoritarios: +nci.toFixed(3), preferidos: M(pref), acciones: sh ? M(sh) : null,
      antesImp: M(at(PT, q.t)), impuesto: M(at(TX, q.t)), neto: M(at(NI, q.t)), ebit: M(ebit) });
    if (!sh) return;
    const eps = ((base + addBack) * (1 - tax) * (1 - nci) - pref) / sh;
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
  const armado = method === "operativo" ? { interesesPagadosEnOperativo: inOI.ie, interesesGanadosEnOperativo: inOI.ii, asociadasEnOperativo: inOI.eq, afudc: AF.length > 0 } : (motivo ? { motivo } : null);
  return { eps: out, method, adj, flags, rows, armado, accionesInformadas: !!repOk };
}

// ---- Flujo de caja y deuda ----
// Flujos de 12 meses (los últimos cuatro trimestres, derivados de los acumulados del año como el EPS) y el último balance.
//   FCF = flujo operativo − inversión en activo fijo (incluye el software desarrollado que se activa).
//   Deuda = financiera de largo y corto plazo (incluye arrendamientos financieros si la empresa los suma; no los
//   operativos). Caja = efectivo e inversiones de corto plazo. EV = capitalización + deuda + minoritarios + preferidos − caja.
//   EBIT = el ajustado del normalizado (sin extraordinarios); EBITDA = EBIT + amortizaciones del flujo de caja.
// Todo en millones de US$. Devuelve null si los flujos no llegan a cuatro trimestres o el último tiene más de 200 días.
export function cashDebt(raw, normRows, asOf = Date.now()) {
  const C = raw.cd || {}, one = () => 1, TEN = 10 * DAY_MS;
  const q = t => quartersOf(C[t] || [], one).sort((a, b) => a.t - b.t);
  const ttm = tags => {
    for (const t of [].concat(tags)) {
      const s = q(t); if (s.length < 4) continue;
      const l = s.slice(-4);
      if (l[3].t - l[0].t > 300 * DAY_MS || asOf - l[3].t > 200 * DAY_MS) continue;
      return { v: l.reduce((a, x) => a + x.eps, 0), t: l[3].t, tag: t };
    }
    return null;
  };
  const ocf = ttm(["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"]);
  if (!ocf) return null;
  const same = x => x && Math.abs(x.t - ocf.t) <= TEN ? x.v : null;
  const capex = same(ttm(["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements"])) ?? 0;
  const sw = same(ttm("PaymentsToDevelopSoftware")) ?? 0;
  const sbc = same(ttm(["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"]));
  let da = same(ttm(["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization"]));
  if (da == null) { const d = same(ttm("Depreciation")), am = same(ttm("AmortizationOfIntangibleAssets")); da = d != null ? d + (am || 0) : null; }
  // balance: el último cierre informado; cada partida, del mismo cierre
  const inst = t => (C[t] || []).filter(e => !e.start && e.end && isFinite(e.val));
  const lastBal = Math.max(...["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "LongTermDebtNoncurrent", "LongTermDebt", "DebtCurrent"]
    .flatMap(t => inst(t).map(e => Date.parse(e.end))), 0);
  const bal = t => { const v = inst(t).filter(e => Math.abs(Date.parse(e.end) - lastBal) <= TEN).sort((a, b) => (a.filed || "").localeCompare(b.filed || "")).pop(); return v ? v.val : null; };
  const firstBal = ts => { for (const t of ts) { const v = bal(t); if (v != null) return v; } return null; };
  const cash = (firstBal(["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]) || 0)
    + (firstBal(["ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent"]) || 0);
  const stb = firstBal(["ShortTermBorrowings", "CommercialPaper"]) || 0;
  const nonCur = firstBal(["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"]);
  const dc = bal("DebtCurrent"), ltdc = firstBal(["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"]);
  const cur = dc != null ? dc : (ltdc || 0) + stb;
  const ltd = bal("LongTermDebt");
  const debt = nonCur != null ? nonCur + cur : ltd != null ? ltd + (dc != null ? Math.max(0, dc - (ltdc || 0)) : stb) : null;
  const nci = bal("MinorityInterest") || 0, pref = bal("PreferredStockValue") || 0;
  // EBIT ajustado de 12 meses, de los mismos trimestres del normalizado
  const rs = (normRows || []).filter(r => r.ebit != null);
  const lastR = rs.slice(-4), ebitOk = lastR.length === 4 && Math.abs(Date.parse(lastR[3].fin) - ocf.t) <= 100 * DAY_MS;
  const M = v => v == null ? null : Math.round(v / 1e5) / 10;
  return { ocf: M(ocf.v), capex: M(capex + sw), sbc: M(sbc), da: M(da), ebit: ebitOk ? +lastR.reduce((a, r) => a + r.ebit, 0).toFixed(1) : null,
    debt: M(debt), cash: M(cash), nci: M(nci), pref: M(pref),
    fin: new Date(ocf.t).toISOString().slice(0, 10), bal: lastBal ? new Date(lastBal).toISOString().slice(0, 10) : null };
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
    if (k === "adj" || k === "cd") {   // por etiqueta
      out[k] = {};
      for (const t of new Set([...Object.keys(newer[k] || {}), ...Object.keys(older[k] || {})])) out[k][t] = mergeRaw({ x: (newer[k] || {})[t] || [] }, { x: (older[k] || {})[t] || [] }).x;
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
