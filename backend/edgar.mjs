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
};
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

// EPS normalizado trimestral: (resultado operativo - intereses pagados + intereses ganados + resultado de
// asociadas por el método de la participación) x (1 - tasa efectiva típica) / acciones diluidas.
// Queda lo recurrente; afuera queda lo puntual: cargos o beneficios impositivos, ganancias o pérdidas de
// mercado por tenencias de acciones, diferencias de cambio y demás resultados no operativos. La tasa es la mediana de la
// tasa efectiva de los 12 trimestres previos, descartando trimestres anómalos (fuera de 0-45%).
// Acciones: resultado neto / EPS contable ajustado (consistente con el split); si el EPS es casi cero,
// el dato de acciones de EDGAR, con control de escala (algunas empresas lo cargan en miles o millones).
// Si la empresa no reporta resultado operativo al día (bancos, aseguradoras, JNJ desde 2014), se normaliza
// solo el impuesto: resultado antes de impuestos x (1 - tasa típica). Devuelve { eps, method }.
export function normalizedQuarterly(raw, splitFactor, gaap, symbol) {
  if (!gaap.length) return { eps: [], method: null };
  const quarterly = arr => {
    const q = new Map();
    for (const e of arr) if (/^CY\d{4}Q\d$/.test(e.frame || "")) q.set(qkeyOf(e.end), { end: e.end, start: e.start, val: e.val });
    for (const a of arr) {
      if (!/^CY\d{4}$/.test(a.frame || "") || !a.start) continue;
      const inside = [...q.values()].filter(x => x.start && x.start >= a.start && x.end <= a.end);
      const k = qkeyOf(a.end);
      if (inside.length === 3 && !q.has(k)) q.set(k, { end: a.end, start: null, val: a.val - inside.reduce((s, x) => s + x.val, 0) });
    }
    return q;
  };
  const OI = quarterly(raw.oi), PT = quarterly(raw.pt), TX = quarterly(raw.tx), NI = quarterly(raw.ni);
  const IE = quarterly(raw.ie || []), II = quarterly(raw.ii || []), EQ = quarterly(raw.eq || []);
  // si a un trimestre le falta el dato de intereses, el del trimestre anterior (es una serie estable)
  const steady = (m, k) => { if (!m.size) return 0; if (m.has(k)) return m.get(k).val; const ks = [...m.keys()].sort(); const prev = ks.filter(x => x <= k).pop() || ks[0]; return m.get(prev).val; };
  // para las acciones implícitas (resultado neto / EPS) solo sirve el EPS total: el de operaciones continuas no
  // corresponde al resultado neto cuando hay operaciones discontinuadas
  const EPS = new Map(gaap.filter(e => !isContinuingTag(e.tag)).map(e => [e.frame.slice(2), e.eps]));
  // método: operativo si la serie llega hasta el último trimestre contable (o el anterior); si no, antes de impuestos
  const lastG = gaap[gaap.length - 1].frame.slice(2);
  const prevQ = k => { const [y, q] = k.split("Q").map(Number); return q > 1 ? `${y}Q${q - 1}` : `${y - 1}Q4`; };
  const reaches = m => m.size > 0 && [...m.keys()].sort().pop() >= prevQ(lastG);
  const PRE = new Map();
  for (const k of new Set([...PT.keys(), ...NI.keys()])) {
    const v = PT.get(k)?.val ?? ((NI.has(k) && TX.has(k)) ? NI.get(k).val + TX.get(k).val : null);
    if (v != null) PRE.set(k, { end: (PT.get(k) || NI.get(k)).end, val: v });
  }
  const method = reaches(OI) ? "operativo" : (reaches(PRE) ? "impuestos" : null);
  if (!method) return { eps: [], method: null };
  const BASE = method === "operativo" ? OI : PRE;
  const keys = [...BASE.keys()].sort((a, b) => BASE.get(a).end.localeCompare(BASE.get(b).end));

  // acciones implícitas = resultado neto / EPS (ya ajustado por splits)
  const implied = new Map();
  for (const k of keys) {
    const ni = NI.get(k)?.val, eps = EPS.get(k);
    if (ni != null && eps != null && Math.abs(eps) >= 0.05 && ni / eps > 0) implied.set(k, ni / eps);
  }
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
  const medImplied = median([...implied.values()]);
  const reported = new Map();
  for (const e of raw.sh) {
    if (!/^CY\d{4}Q\d$/.test(e.frame || "") || !(e.val > 0)) continue;
    let v = e.val * splitFactor(e.end, e.filed);
    if (medImplied) { // escala: unidades, miles o millones, la que quede más cerca de las implícitas
      v = [1, 1e3, 1e6].map(s => v * s).reduce((best, x) => Math.abs(Math.log(x / medImplied)) < Math.abs(Math.log(best / medImplied)) ? x : best);
    }
    reported.set(qkeyOf(e.end), v);
  }
  const sharesFor = k => {
    if (implied.has(k)) return implied.get(k);
    if (reported.has(k)) return reported.get(k);
    const near = [...implied.keys(), ...reported.keys()].sort();
    const prev = near.filter(x => x <= k).pop() || near.find(x => x > k);
    return prev ? (implied.get(prev) ?? reported.get(prev)) : null;
  };

  // tasa efectiva = impuesto / resultado antes de impuestos (si no está, resultado neto + impuesto)
  const etr = k => {
    const t = TX.get(k)?.val; if (t == null) return null;
    const p = PT.get(k)?.val ?? (NI.has(k) ? NI.get(k).val + t : null);
    if (!(p > 0)) return null; const r = t / p; return (r >= 0 && r <= 0.45) ? r : null;
  };
  const allRates = keys.map(etr).filter(r => r != null);
  const globalRate = allRates.length >= 4 ? median(allRates) : 0.21;
  const out = [];
  keys.forEach((k, i) => {
    const win = keys.slice(Math.max(0, i - 11), i + 1).map(etr).filter(r => r != null);
    const t = Math.min(0.35, Math.max(0.05, win.length >= 4 ? median(win) : globalRate));
    const sh = sharesFor(k);
    if (!sh) return;
    const base = method === "operativo"
      ? OI.get(k).val - steady(IE, k) + steady(II, k) + (EQ.has(k) ? EQ.get(k).val : 0)
      : PRE.get(k).val;
    const eps = base * (1 - t) / sh;
    if (isFinite(eps)) out.push({ date: Math.floor(Date.parse(BASE.get(k).end) / 1000), eps: +eps.toFixed(4), frame: "CY" + k });
  });
  console.log(`pebg ${symbol}: normalizado (${method}) ${out.length} trimestres, tasa típica ${(globalRate * 100).toFixed(1)}%`);
  return { eps: out, method };
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
