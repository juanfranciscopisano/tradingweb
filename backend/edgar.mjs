// EDGAR (SEC, XBRL): EPS diluido trimestral contable, EPS normalizado y acciones diluidas.
// Lo usan el backend (/api/pebg) y scripts/multiples.mjs (P/E histórico del S&P 500 y sus sectores).
// ---- EDGAR: EPS contable y normalizado ----
// Los datos crudos se cachean por ticker; el ajuste por splits se hace en cada pedido con los splits de Yahoo.
// Splits: EDGAR guarda cada trimestre tal como se presentó. Si un split ocurrió DESPUÉS del cierre del
// trimestre y DESPUÉS de presentado el dato, ese dato está sin ajustar (los precios de Yahoo sí están
// ajustados), así que se divide por el ratio. Si la empresa lo volvió a presentar después del split, ya
// viene reexpresado y no se toca.
export const EDGAR_TAGS = {
  // XOM publica "básico y diluido" en una sola etiqueta; algunas (V, clases de acciones) solo el básico
  eps: [["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"], "USD/shares"],
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

// EPS diluido trimestral (contable). Q1-Q3 salen de los frames CY####Q#; el trimestre faltante se
// deriva como anual menos YTD (soporta cierres de ejercicio no calendario).
export function gaapQuarterly(raw, splitFactor, symbol) {
  const epsData = raw.eps.map(e => ({ ...e, val: e.val / splitFactor(e.end, e.filed) }));
  const quarterly = {}, annualByYear = {}, ytdQ2ByYear = {}, ytdQ3ByYear = {};
  const ts = d => Math.floor(new Date(d).getTime() / 1000);
  epsData.forEach(e => {
    const endYear = String(new Date(e.end).getFullYear());
    if (!e.frame) {
      if (e.fp === "Q2" && e.form === "10-Q") {
        if (!ytdQ2ByYear[endYear] || Math.abs(e.val) > Math.abs(ytdQ2ByYear[endYear].val)) ytdQ2ByYear[endYear] = { date: ts(e.end), val: e.val, end: e.end };
      } else if (e.fp === "Q3" && e.form === "10-Q") {
        if (!ytdQ3ByYear[endYear] || Math.abs(e.val) > Math.abs(ytdQ3ByYear[endYear].val)) ytdQ3ByYear[endYear] = { date: ts(e.end), val: e.val, end: e.end };
      } else if (e.fp === "FY" && e.form === "10-K") {
        if (!annualByYear[endYear] || e.end > annualByYear[endYear].end) annualByYear[endYear] = { date: ts(e.end), val: e.val, end: e.end };
      }
    } else if (/^CY\d{4}Q\d$/.test(e.frame)) {
      if (!quarterly[e.frame] || e.end > quarterly[e.frame].end) quarterly[e.frame] = { date: ts(e.end), eps: e.val, end: e.end };
    } else if (/^CY\d{4}$/.test(e.frame)) {
      const frameYr = e.frame.slice(2); // año del frame, no el del cierre (NVDA cierra en enero)
      if (!annualByYear[frameYr] || e.end > annualByYear[frameYr].end) annualByYear[frameYr] = { date: ts(e.end), val: e.val, end: e.end };
    }
  });
  const derived = Object.entries(quarterly).map(([frame, v]) => ({ date: v.date, eps: v.eps, frame }));
  Object.keys(annualByYear).forEach(yr => {
    const ann = annualByYear[yr], q3ytd = ytdQ3ByYear[yr];
    if (!q3ytd || ann.date <= q3ytd.date) return;
    const ytdMonth = new Date(q3ytd.end).getMonth();
    let missingFrame, ytd;
    if (ytdMonth <= 3) { missingFrame = `CY${yr}Q2`; ytd = ytdQ2ByYear[yr] || q3ytd; }
    else if (ytdMonth <= 6) { missingFrame = `CY${yr}Q3`; ytd = q3ytd; }
    else { missingFrame = `CY${yr}Q4`; ytd = q3ytd; }
    if (!quarterly[missingFrame]) derived.push({ date: ann.date, eps: ann.val - ytd.val, frame: missingFrame });
  });
  const out = derived
    .filter(e => isFinite(e.eps))
    .sort((a, b) => a.date - b.date)
    .filter((e, i, arr) => i === arr.findIndex(x => x.frame === e.frame));
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
  const EPS = new Map(gaap.map(e => [e.frame.slice(2), e.eps]));
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
