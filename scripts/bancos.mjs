// Arma bancos.json: precio / valor libro (P/VL), P/VL tangible y ROE, semana a semana, de los bancos argentinos y de los
// de EE.UU. del S&P 500, cada uno y por grupo. Corre en GitHub Actions los días hábiles (.github/workflows/bancos.yml).
//
// EE.UU.: los bancos del S&P 500 (subindustrias Diversified Banks y Regional Banks, de spx.json). Balances trimestrales de
// la SEC (EDGAR, XBRL): valor libro de los comunes = patrimonio neto − preferidas; tangible = además sin llave de negocio
// ni intangibles. ROE = resultado de los comunes de 12 meses / patrimonio de los comunes promedio de los cinco cierres
// (el del trimestre y los cuatro anteriores). Cada trimestre vale desde su presentación a la SEC: lo que se sabía cada
// semana. Precio semanal de Yahoo, acciones del balance.
//
// Argentina: Galicia, Macro, BBVA y Supervielle (con ADR: 20-F en la SEC con NIIF desde el ejercicio 2017) y Patagonia,
// Hipotecario y Valores. Los últimos cinco trimestres y cuatro ejercicios son de Yahoo; para atrás, los 20-F. Los balances
// tienen ajuste por inflación: cada valor libro está en pesos de su cierre (los ejercicios de Yahoo, en pesos del último
// ejercicio, como los comparativos del último balance) y se lleva a pesos de cada semana con el IPC (indec.json). El
// precio es el local, en pesos (BYMA, vía Yahoo). El ROE es real: el resultado ya descuenta la inflación.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { yahooSession } from "./fundamentals.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DAY = 86400, WEEK = 7 * DAY;
export const MONDAY0 = Date.UTC(1990, 0, 1) / 1000;          // las semanas se cuentan como en multiples.json
export const weekOf = t => Math.floor((t - MONDAY0) / WEEK);
export const W0 = weekOf(Date.UTC(2010, 0, 4) / 1000);        // primera semana de las series
const tOf = d => Math.floor(Date.parse(d + "T00:00:00Z") / 1000);
const isoOf = t => new Date(t * 1000).toISOString().slice(0, 10);
export const VERSION = 1;

// Argentina: el precio es el de BYMA en pesos. CIK de los que presentan el 20-F en la SEC
export const AR = [
  { s: "GGAL", n: "Grupo Financiero Galicia", px: "GGAL.BA", cik: "0001114700" },
  { s: "BMA", n: "Banco Macro", px: "BMA.BA", cik: "0001347426" },
  { s: "BBAR", n: "BBVA Argentina", px: "BBAR.BA", cik: "0000913059" },
  { s: "SUPV", n: "Grupo Supervielle", px: "SUPV.BA", cik: "0001517399" },
  { s: "BPAT", n: "Banco Patagonia", px: "BPAT.BA" },
  { s: "BHIP", n: "Banco Hipotecario", px: "BHIP.BA" },
  { s: "VALO", n: "Grupo Financiero Valores", px: "VALO.BA" },
];
// el agregado argentino: los cuatro con historia desde 2017 (los otros tres arrancan en 2023 y moverían la composición)
export const AR_AGREGADO = ["GGAL", "BMA", "BBAR", "SUPV"];
export const US_SUBS = { "Diversified Banks": "usDiv", "Regional Banks": "usReg" };

// ---- IPC: nivel a fin de cada mes; entre cierres, interpolado por día (geométrico); después del último, con la
// variación promedio de los últimos tres meses
export function ipcDe(indec) {
  const I = indec?.datos?.ipc_nacional, s = (I?.series || []).find(x => /^nacional$/i.test(x.region || "") && /nivel general/i.test(x.descripcion || ""));
  if (!s || !I.d0) return null;
  const [y0, m0] = I.d0.split("-").map(Number), pts = [];
  s.v.forEach((v, i) => { if (v > 0) pts.push([Date.UTC(y0, m0 - 1 + i + 1, 0) / 1000 + DAY - 1, v]); });   // fin de cada mes
  if (pts.length < 4) return null;
  const n = pts.length, r = Math.pow(pts[n - 1][1] / pts[n - 4][1], 1 / 3);   // variación mensual promedio de los últimos tres
  const at = t => {
    if (t <= pts[0][0]) return pts[0][1];
    if (t >= pts[n - 1][0]) return pts[n - 1][1] * Math.pow(r, (t - pts[n - 1][0]) / (30.4375 * DAY));
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid; }
    const [ta, va] = pts[lo], [tb, vb] = pts[hi];
    return va * Math.pow(vb / va, (t - ta) / (tb - ta));
  };
  return { at, ult: isoOf(pts[n - 1][0]), desde: isoOf(pts[0][0]) };
}

// ---- EDGAR
// instantes (saldos) de una etiqueta por fecha de cierre: el primero presentado (lo que se sabía entonces)
function instantes(o, unit) {
  const m = new Map();
  for (const e of o?.units?.[unit] || []) {
    if (e.start || !e.end || !isFinite(e.val)) continue;
    const p = m.get(e.end);
    if (!p || (e.filed || "") < (p.filed || "")) m.set(e.end, { end: e.end, val: e.val, filed: e.filed, form: e.form, accn: e.accn });
  }
  return m;
}
const unir = maps => { const out = new Map(); for (const m of maps) for (const [k, v] of m) if (!out.has(k)) out.set(k, v); return out; };
const dias = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;
// flujos trimestrales de una etiqueta: los informados de ~3 meses y los que faltan (el cuarto, casi siempre) como un
// acumulado menos el acumulado del mismo inicio que termina un trimestre antes. Cada período, en su primera presentación.
export function trimestral(o, unit) {
  const first = new Map();
  for (const e of o?.units?.[unit] || []) {
    if (!e.start || !e.end || !isFinite(e.val)) continue;
    const k = e.start + "|" + e.end, p = first.get(k);
    if (!p || (e.filed || "") < (p.filed || "")) first.set(k, e);
  }
  const F = [...first.values()], q = new Map();
  for (const e of F) { const d = dias(e.start, e.end); if (d >= 80 && d <= 100) q.set(e.end, { end: e.end, val: e.val, filed: e.filed }); }
  for (const a of F) {
    const d = dias(a.start, a.end);
    if (d < 170 || q.has(a.end)) continue;
    const b = F.find(x => x.start === a.start && x.end < a.end && Math.abs(d - dias(x.start, x.end) - 91) <= 12);
    if (b) q.set(a.end, { end: a.end, val: a.val - b.val, filed: a.filed });
  }
  return [...q.values()].sort((x, y) => x.end.localeCompare(y.end));
}
// fecha desde la que vale un balance: la de su presentación; si es de mucho después (un comparativo de una presentación
// posterior, anterior a XBRL), el cierre más la demora típica
const pubDe = (end, filed, lag) => { const t = tOf(end), f = filed ? tOf(filed) : null; return f != null && f >= t && f - t <= 120 * DAY ? f : t + lag * DAY; };

// un banco de EE.UU.: balances trimestrales y ROE de 12 meses
export function usDesdeEdgar(facts) {
  const g = facts?.facts?.["us-gaap"] || {}, dei = facts?.facts?.dei || {};
  const I = (tags, unit = "USD") => unir(tags.map(t => instantes(g[t], unit)));
  // patrimonio de la controlante; si no lo etiqueta (Truist), el total con minoritarios menos los minoritarios
  const eqNci = I(["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]), mi = I(["MinorityInterest"]);
  const eq = unir([I(["StockholdersEquity"]), new Map([...eqNci].map(([k, v]) => [k, { ...v, val: v.val - (mi.get(k)?.val || 0) }]))]);
  const pref = I(["PreferredStockValue", "PreferredStockValueOutstanding", "PreferredStockIncludingAdditionalPaidInCapitalNetOfDiscount", "PreferredStockIncludingAdditionalPaidInCapital"]);
  const gw = I(["Goodwill"]), intg = I(["IntangibleAssetsNetExcludingGoodwill", "OtherIntangibleAssetsNet"]), gwi = I(["IntangibleAssetsNetIncludingGoodwill"]);
  const fin = I(["FiniteLivedIntangibleAssetsNet"]), indef = I(["IndefiniteLivedIntangibleAssetsExcludingGoodwill"]);
  for (const k of new Set([...fin.keys(), ...indef.keys()])) if (!intg.has(k)) intg.set(k, { val: (fin.get(k)?.val || 0) + (indef.get(k)?.val || 0) });
  const shBal = I(["CommonStockSharesOutstanding"], "shares"), shDei = instantes(dei.EntityCommonStockSharesOutstanding, "shares");
  const shProm = new Map((g.WeightedAverageNumberOfDilutedSharesOutstanding?.units?.shares || []).filter(e => e.start && e.end && dias(e.start, e.end) >= 80 && dias(e.start, e.end) <= 100).map(e => [e.end, { val: e.val }]));
  // resultado de los comunes: el informado; si no, resultado neto menos dividendos de preferidas
  let ni = trimestral(g.NetIncomeLossAvailableToCommonStockholdersBasic, "USD");
  const niTot = trimestral(g.NetIncomeLoss, "USD"), pd = new Map(trimestral(g.PreferredStockDividendsIncomeStatementImpact, "USD").map(x => [x.end, x.val]));
  const niMap = new Map(ni.map(x => [x.end, x]));
  for (const x of niTot) if (!niMap.has(x.end)) niMap.set(x.end, { end: x.end, val: x.val - (pd.get(x.end) || 0), filed: x.filed });
  ni = [...niMap.values()].sort((a, b) => a.end.localeCompare(b.end));
  const near = (m, end, tol = 10) => { if (m.has(end)) return m.get(end); for (const [k, v] of m) if (Math.abs(dias(k, end)) <= tol) return v; return null; };
  // preferidas e intangibles que solo van en el 10-K (Bank of America informa las preferidas una vez por año): el último
  // saldo de hasta un año antes (cambian poco)
  const previo = (m, end) => { const v = near(m, end); if (v) return v; let best = null; for (const [k, x] of m) { const d = dias(k, end); if (d > 0 && d <= 400 && (!best || k > best.k)) best = { k, ...x }; } return best; };
  const bal = [];
  for (const [end, e] of [...eq].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!/^10-[KQ]/.test(e.form || "") || e.val <= 0) continue;
    const p = previo(pref, end)?.val || 0, ce = e.val - p;
    const gwv = previo(gw, end)?.val, inv = previo(intg, end)?.val, comb = previo(gwi, end)?.val;
    const intang = gwv != null || inv != null ? (gwv || 0) + (inv || 0) : comb || 0;
    // acciones: las del balance; si no, las de la carátula (a la fecha de presentación, hasta 120 días después)
    let sh = near(shBal, end)?.val;
    if (!sh) for (const [k, v] of shDei) if (dias(end, k) >= 0 && dias(end, k) <= 120 && (!sh || k < sh.k)) sh = { k, val: v.val };
    if (sh && typeof sh === "object") sh = sh.val;
    if (!sh) sh = near(shProm, end)?.val;
    bal.push({ end, c: end, bv: ce, tbv: ce - intang, sh: sh || null, pub: pubDe(end, e.filed, /^10-K/.test(e.form) ? 60 : 45), src: "SEC" });
  }
  return { bal, ni, roe: roeTrimestral(bal, ni, () => 1) };
}
// trimestres de Yahoo posteriores al último de la SEC (Citi dejó de aparecer en los datos XBRL de la SEC en 2026): valor
// libro de los comunes, tangible, resultado de los comunes y acciones; vale desde el cierre más 45 días (60 el cuarto)
export function usDesdeYahoo(ys, desdeEnd, hoyS) {
  const bal = [], ni = [];
  for (const [end, o] of Object.entries(ys.q).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (desdeEnd && end <= desdeEnd) continue;
    const pub = Math.min(tOf(end) + (end.slice(5) === "12-31" ? 60 : 45) * DAY, hoyS);
    const bv = o.CommonStockEquity ?? null;
    if (bv > 0 && o.OrdinarySharesNumber > 0) bal.push({ end, c: end, bv, tbv: o.TangibleBookValue ?? bv, sh: o.OrdinarySharesNumber, pub, src: "Yahoo trimestral" });
    if (isFinite(o.NetIncomeCommonStockholders)) ni.push({ end, val: o.NetIncomeCommonStockholders, pub });
  }
  return { bal, ni };
}

// ROE de 12 meses en cada cierre con cuatro trimestres seguidos de resultado: resultado / promedio de los valores libro de
// los cierres del año (el del trimestre y los anteriores hasta un año antes), todo en moneda del cierre (conv lleva un
// valor de pesos de una fecha a pesos de otra; en EE.UU. es 1). También el último trimestre anualizado.
export function roeTrimestral(bal, ni, conv) {
  const out = [];
  const B = bal.slice().sort((a, b) => a.end.localeCompare(b.end));
  for (let i = 3; i < ni.length; i++) {
    const q = ni.slice(i - 3, i + 1);
    if (dias(q[0].end, q[3].end) > 300 || dias(q[0].end, q[3].end) < 250) continue;
    const end = q[3].end, b = B.filter(x => dias(x.end, end) >= -10 && dias(x.end, end) <= 375 && x.bv > 0);
    const bEnd = b.find(x => Math.abs(dias(x.end, end)) <= 10);
    if (!bEnd || b.length < 2) continue;
    const enCierre = x => x.bv * conv(x.c, bEnd.c);
    const avg = b.reduce((a, x) => a + enCierre(x), 0) / b.length;
    const n12 = q.reduce((a, x) => a + x.val * conv(x.c || x.end, bEnd.c), 0);
    // último trimestre anualizado: contra el promedio de su cierre y el anterior
    const bPrev = B.filter(x => dias(x.end, end) >= 80 && dias(x.end, end) <= 100 && x.bv > 0).pop();
    const nq = q[3].val * conv(q[3].c || q[3].end, bEnd.c), avgQ = bPrev ? (bEnd.bv + enCierre(bPrev)) / 2 : null;
    out.push({ end, c: bEnd.c, pub: Math.max(bEnd.pub, q[3].pub || 0), roe: n12 / avg, ni: n12, avg, roeQ: avgQ ? 4 * nq / avgQ : null, tipo: "12m" });
  }
  return out;
}

// un banco argentino desde el 20-F (NIIF): valor libro a cada cierre (en pesos de ese cierre) y ROE de cada ejercicio con
// el resultado y los patrimonios del mismo balance (el comparativo viene reexpresado a moneda del cierre)
export function arDesdeEdgar(facts) {
  const f = facts?.facts?.["ifrs-full"] || {}, dei = facts?.facts?.dei || {};
  const eqTag = f.EquityAttributableToOwnersOfParent ? "EquityAttributableToOwnersOfParent" : "Equity";
  const eq = instantes(f[eqTag], "ARS");
  const intg = unir([instantes(f.IntangibleAssetsAndGoodwill, "ARS")]), gw = instantes(f.Goodwill, "ARS"), io = instantes(f.IntangibleAssetsOtherThanGoodwill, "ARS");
  const niTag = f.ProfitLossAttributableToOwnersOfParent ? "ProfitLossAttributableToOwnersOfParent" : "ProfitLoss";
  const niAll = (f[niTag]?.units?.ARS || []).filter(e => e.start && e.end && isFinite(e.val));
  const eps = (f.BasicEarningsLossPerShare?.units?.["ARS/shares"] || []).filter(e => e.start && e.end && e.val);
  const shDei = instantes(dei.EntityCommonStockSharesOutstanding, "shares");
  const shOf = end => {
    for (const [k, v] of shDei) if (Math.abs(dias(end, k)) <= 130) return v.val;
    const n = niAll.find(e => e.end === end && dias(e.start, e.end) > 350), e = n && eps.find(x => x.end === end && x.accn === n.accn && dias(x.start, x.end) > 350);
    return n && e ? Math.round(n.val / e.val) : null;
  };
  const bal = [];
  for (const [end, e] of [...eq].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (e.val <= 0) continue;
    const it = intg.get(end)?.val ?? ((gw.get(end)?.val || 0) + (io.get(end)?.val || 0));
    const anual = end.slice(5) === "12-31";
    bal.push({ end, c: end, bv: e.val, tbv: e.val - it, sh: shOf(end), pub: Math.min(pubDe(end, e.filed, anual ? 75 : 60), tOf(end) + (anual ? 75 : 60) * DAY), src: "SEC 20-F" });
  }
  // ROE de cada ejercicio: resultado del año y patrimonio de cierre y de apertura del mismo balance (accn)
  const roe = [];
  for (const n of niAll) {
    if (dias(n.start, n.end) < 350 || dias(n.start, n.end) > 380) continue;
    const vals = (f[eqTag]?.units?.ARS || []).filter(e => !e.start && e.accn === n.accn);
    const cierre = vals.find(e => e.end === n.end), apertura = vals.find(e => Math.abs(dias(e.end, n.start)) <= 2);
    if (!cierre || !apertura || roe.some(r => r.end === n.end)) continue;
    const prim = niAll.filter(x => x.end === n.end && x.start === n.start).sort((a, b) => (a.filed || "").localeCompare(b.filed || ""))[0];
    if (prim.accn !== n.accn) continue;   // el del balance de ese ejercicio, no un comparativo posterior
    const avg = (cierre.val + apertura.val) / 2;
    roe.push({ end: n.end, c: n.end, pub: Math.min(pubDe(n.end, n.filed, 75), tOf(n.end) + 75 * DAY), roe: n.val / avg, ni: n.val, avg, roeQ: null, tipo: "ejercicio" });
  }
  return { bal, roe: roe.sort((a, b) => a.end.localeCompare(b.end)) };
}

// ---- Yahoo: últimos trimestres y ejercicios (los bancos argentinos)
export const Y_TIPOS = ["CommonStockEquity", "StockholdersEquity", "TangibleBookValue", "NetIncomeCommonStockholders", "OrdinarySharesNumber"];
export function yahooSerie(j) {
  const out = { q: {}, a: {}, t: {} };
  for (const r of j?.timeseries?.result || []) {
    const t = r?.meta?.type?.[0], m = /^(quarterly|annual|trailing)(.+)$/.exec(t || "");
    if (!m) continue;
    for (const x of (r[t] || []).filter(Boolean)) {
      if (!x.asOfDate || !isFinite(x.reportedValue?.raw)) continue;
      const k = m[1] === "quarterly" ? "q" : m[1] === "annual" ? "a" : "t";
      ((out[k][x.asOfDate] ||= {}))[m[2]] = +x.reportedValue.raw;
    }
  }
  return out;
}
// balances y ROE desde Yahoo. Trimestres: en pesos de su cierre. Ejercicios: en pesos del último ejercicio. Sin fecha de
// presentación: el cierre más 60 días (75 el anual), y nunca después de hoy (si está en Yahoo, ya se publicó)
export function arDesdeYahoo(ys, hoyS) {
  const bal = [], fin = Object.keys(ys.a).sort().pop();
  const bvDe = o => o.CommonStockEquity ?? o.StockholdersEquity;
  const pub = (end, lag) => Math.min(tOf(end) + lag * DAY, hoyS);
  for (const [end, o] of Object.entries(ys.q)) if (bvDe(o) > 0) bal.push({ end, c: end, bv: bvDe(o), tbv: o.TangibleBookValue ?? bvDe(o), sh: o.OrdinarySharesNumber || null, pub: pub(end, end.slice(5) === "12-31" ? 75 : 60), src: "Yahoo trimestral" });
  for (const [end, o] of Object.entries(ys.a)) if (bvDe(o) > 0) bal.push({ end, c: fin, bv: bvDe(o), tbv: o.TangibleBookValue ?? bvDe(o), sh: o.OrdinarySharesNumber || null, pub: pub(end, 75), src: "Yahoo anual" });
  // resultados trimestrales (para el ROE de 12 meses, que se arma con todas las fuentes juntas) y ROE de cada ejercicio:
  // resultado / promedio del patrimonio de cierre y de apertura (los dos en la misma moneda)
  const ni = Object.entries(ys.q).filter(([, o]) => isFinite(o.NetIncomeCommonStockholders)).map(([end, o]) => ({ end, c: end, val: o.NetIncomeCommonStockholders, pub: pub(end, end.slice(5) === "12-31" ? 75 : 60) })).sort((a, b) => a.end.localeCompare(b.end));
  const roe = [];
  const A = Object.entries(ys.a).sort((a, b) => a[0].localeCompare(b[0]));
  for (let i = 1; i < A.length; i++) {
    const [end, o] = A[i], [endP, oP] = A[i - 1];
    if (!isFinite(o.NetIncomeCommonStockholders) || !(bvDe(o) > 0) || !(bvDe(oP) > 0) || dias(endP, end) < 350 || dias(endP, end) > 380) continue;
    const avg = (bvDe(o) + bvDe(oP)) / 2;
    roe.push({ end, c: fin, pub: pub(end, 75), roe: o.NetIncomeCommonStockholders / avg, ni: o.NetIncomeCommonStockholders, avg, roeQ: null, tipo: "ejercicio" });
  }
  return { bal, roe, ni };
}

// ROE de 12 meses con el resultado de 12 meses que publica Yahoo, en los cierres en que faltan trimestres (a Macro le falta
// el cuarto de 2025): es la suma nominal de los cuatro trimestres, así que en Argentina queda un poco por debajo del real
export function roeConTrailing(bal, ys, conv, hechos, hoyS) {
  const out = [], B = bal.filter(b => b.bv > 0);
  for (const [end, o] of Object.entries(ys.t || {})) {
    const n = o.NetIncomeCommonStockholders;
    if (!isFinite(n) || hechos.some(r => Math.abs(dias(r.end, end)) <= 10)) continue;
    const bEnd = B.find(x => Math.abs(dias(x.end, end)) <= 10), b = B.filter(x => dias(x.end, end) >= -10 && dias(x.end, end) <= 375);
    if (!bEnd || b.length < 2) continue;
    const avg = b.reduce((a, x) => a + x.bv * conv(x.c, bEnd.c), 0) / b.length;
    out.push({ end, c: bEnd.c, pub: Math.min(Math.max(bEnd.pub, tOf(end) + 60 * DAY), hoyS), roe: n / avg, ni: n, avg, roeQ: null, tipo: "12m" });
  }
  return out;
}

// une fuentes: por fecha de cierre manda la primera que lo tiene (±10 días)
export function unirObs(listas) {
  const out = [];
  for (const L of listas) for (const x of L) if (!out.some(y => Math.abs(dias(y.end, x.end)) <= 10)) out.push(x);
  return out.sort((a, b) => a.end.localeCompare(b.end));
}

// ---- series semanales de un banco
// precio: Map semana → cierre. conv(c, t): de pesos de la fecha c a pesos del momento t (segundos); en EE.UU., 1.
// splits: [{ date, ratio }] (las acciones de un balance anterior a un split se multiplican por el ratio)
export function semanal({ price, bal, roe, conv, splits = [], weeks, hoyS, maxBal = 200, maxRoe = 200 }) {
  const MAX_BAL = maxBal * DAY, MAX_ROE = maxRoe * DAY;
  const B = bal.filter(b => b.bv > 0 && b.sh > 0).sort((a, b) => a.pub - b.pub || a.end.localeCompare(b.end));
  const R = roe.slice().sort((a, b) => a.pub - b.pub || a.end.localeCompare(b.end));
  const pb = [], ptb = [], ro = [], cap = [], bvT = [], tbvT = [], niT = [], avgT = [];
  let i = -1, j = -1;
  for (const w of weeks) {
    const t = Math.min(MONDAY0 + w * WEEK + 4 * DAY, hoyS);
    while (i + 1 < B.length && B[i + 1].pub <= t) i++;
    while (j + 1 < R.length && R[j + 1].pub <= t) j++;
    // de dos balances publicados, el de cierre más reciente
    const b = i >= 0 ? B.slice(0, i + 1).reduce((m, x) => x.end > m.end ? x : m) : null;
    const r = j >= 0 ? R.slice(0, j + 1).reduce((m, x) => x.end > m.end || (x.end === m.end && x.tipo === "12m") ? x : m) : null;
    const p = price.get(w);
    let c = null, bv = null, tbv = null;
    if (b && p > 0 && t - tOf(b.end) <= MAX_BAL) {
      const f = conv(b.c, t), sp = splits.filter(s => s.date > tOf(b.end)).reduce((a, s) => a * s.ratio, 1);
      c = p * b.sh * sp; bv = b.bv * f; tbv = b.tbv * f;
    }
    cap.push(c); bvT.push(bv); tbvT.push(tbv);
    pb.push(c != null && bv > 0 ? c / bv : null);
    ptb.push(c != null && tbv > 0 ? c / tbv : null);
    const rOk = r && t - tOf(r.end) <= MAX_ROE;
    ro.push(rOk ? r.roe : null);
    niT.push(rOk ? r.ni * conv(r.c, t) : null); avgT.push(rOk ? r.avg * conv(r.c, t) : null);
  }
  return { pb, ptb, roe: ro, cap, bvT, tbvT, niT, avgT };
}

// agregado de un grupo por semana: suma de capitalizaciones / suma de valores libro; ROE = suma de resultados / suma de
// patrimonios promedio. Solo las semanas en que las que tienen dato pesan al menos minCov de la capitalización de hoy.
export function agregado(series, syms, n, minCov = 0.85) {
  const capHoy = s => { const c = series[s]?.cap || []; for (let k = c.length - 1; k >= 0; k--) if (c[k] != null) return c[k]; return 0; };
  const tot = syms.reduce((a, s) => a + capHoy(s), 0);
  const pb = [], ptb = [], roe = [];
  for (let k = 0; k < n; k++) {
    let M = 0, B = 0, T = 0, cov = 0, N = 0, A = 0, covR = 0;
    for (const s of syms) {
      const x = series[s]; if (!x) continue;
      if (x.cap[k] != null && x.bvT[k] > 0) { M += x.cap[k]; B += x.bvT[k]; T += x.tbvT[k] > 0 ? x.tbvT[k] : x.bvT[k]; cov += capHoy(s); }
      if (x.niT[k] != null && x.avgT[k] > 0) { N += x.niT[k]; A += x.avgT[k]; covR += capHoy(s); }
    }
    const ok = cov >= tot * minCov && tot > 0;
    pb.push(ok && B > 0 ? +(M / B).toFixed(3) : null);
    ptb.push(ok && T > 0 ? +(M / T).toFixed(3) : null);
    roe.push(covR >= tot * minCov && A > 0 ? +(N / A * 100).toFixed(2) : null);
  }
  return { pb, ptb, roe };
}

// ---- red
async function getJSON(f, url, headers, tries = 3) {
  for (let a = 0; ; a++) {
    try {
      const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), 30000);
      const r = await f(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(tm));
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (a >= tries - 1) throw e;
      await new Promise(res => setTimeout(res, 1500 * (a + 1)));
    }
  }
}
const precioDe = chart => {
  const ts = chart?.timestamp || [], cl = chart?.indicators?.quote?.[0]?.close || [], m = new Map();
  ts.forEach((t, i) => { if (cl[i] > 0) m.set(weekOf(t), cl[i]); });
  const splits = Object.values(chart?.events?.splits || {}).map(s => ({ date: s.date, ratio: s.numerator / s.denominator })).filter(s => s.ratio > 0 && isFinite(s.ratio));
  return { m, splits };
};
const r3 = v => v == null ? null : +v.toFixed(3), r2 = v => v == null ? null : +v.toFixed(2);

export async function main({ root = new URL("../", import.meta.url), fetchImpl = globalThis.fetch, now = new Date(), log = console.log,
  secUA = process.env.SEC_UA || "tradingweb research@example.com", modo = process.env.MODO || "diario", secGapMs = 150 } = {}) {
  if (modo === "diagnostico") return diagnostico({ fetchImpl, log, secUA });
  const hoyS = Math.floor(now.getTime() / 1000), errores = {};
  const spx = JSON.parse(await readFile(new URL("spx.json", root), "utf8"));
  const indec = JSON.parse(await readFile(new URL("indec.json", root), "utf8"));
  const ipc = ipcDe(indec);
  if (!ipc) throw new Error("indec.json sin el IPC nacional");
  const conv = (c, t) => ipc.at(typeof t === "number" ? t : tOf(t) + DAY - 1) / ipc.at(tOf(c) + DAY - 1);
  const US = spx.list.filter(c => US_SUBS[c.sub]).map(c => ({ s: c.s, n: c.n, cik: c.cik, sub: c.sub }));
  if (US.length < 8) throw new Error(`spx.json con ${US.length} bancos`);
  let lastSec = 0;
  const secGet = async url => { for (;;) { const w = lastSec + secGapMs - Date.now(); if (w <= 0) break; await new Promise(r => setTimeout(r, w)); } lastSec = Date.now(); return getJSON(fetchImpl, url, { "User-Agent": secUA, Accept: "application/json" }); };
  let ys = null;
  try { ys = await yahooSession(fetchImpl); } catch (e) { log("Yahoo (sesión): " + e.message); }
  const yH = { "User-Agent": UA, Accept: "application/json", ...(ys ? { Cookie: ys.cookie } : {}) }, cr = ys ? `&crumb=${encodeURIComponent(ys.crumb)}` : "";
  const p1 = Date.UTC(2009, 11, 28) / 1000;
  const chartDe = sym => getJSON(fetchImpl, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${hoyS}&interval=1wk&events=splits`, { "User-Agent": UA, Accept: "application/json" }).then(j => j?.chart?.result?.[0] || null);
  const tipos = [...["quarterly", "annual"].flatMap(p => Y_TIPOS.map(t => p + t)), "trailingNetIncomeCommonStockholders"].join(",");
  const yFund = sym => getJSON(fetchImpl, `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${tipos}&period1=${Date.UTC(2015, 0, 1) / 1000}&period2=${hoyS + DAY}${cr}`, yH);

  const weeks = []; for (let w = W0; w <= weekOf(hoyS); w++) weeks.push(w);
  const series = {}, bancos = {};
  const resumen = (x, b, bal, roe, precio, monedaConv, maxRoe) => {
    const k = weeks.length - 1, ultBal = bal.filter(y => y.pub <= hoyS && y.bv > 0).sort((a, c) => a.end.localeCompare(c.end)).pop();
    const vig = roe.filter(y => y.pub <= hoyS && hoyS - tOf(y.end) <= maxRoe * DAY);
    const ultR = vig.slice().sort((a, c) => a.end.localeCompare(c.end) || (a.tipo === "12m") - (c.tipo === "12m")).pop();
    const ult12 = vig.filter(y => y.tipo === "12m").sort((a, c) => a.end.localeCompare(c.end)).pop();
    return { precio: precio != null ? +precio.toFixed(2) : null, cap: x.cap[k] != null ? Math.round(x.cap[k]) : null, pb: r3(x.pb[k]), ptb: r3(x.ptb[k]),
      bv: x.bvT[k] != null ? Math.round(x.bvT[k]) : null, tbv: x.tbvT[k] != null ? Math.round(x.tbvT[k]) : null,
      balance: ultBal ? ultBal.end : null, fuente: ultBal ? ultBal.src : null, ajusteIPC: ultBal && monedaConv ? r3(conv(ultBal.c, hoyS)) : null,
      roe: ultR ? r2(ultR.roe * 100) : null, roeCierre: ultR ? ultR.end : null, roeTipo: ultR ? ultR.tipo : null, roeQ: ult12?.roeQ != null ? r2(ult12.roeQ * 100) : null, roeQCierre: ult12?.roeQ != null ? ult12.end : null };
  };
  // EE.UU.
  for (const c of US) {
    try {
      const [facts, chart, yj] = await Promise.all([secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`), chartDe(c.s), yFund(c.s).catch(e => { errores[c.s + " Yahoo"] = e.message; return null; })]);
      if (!facts || !chart) { errores[c.s] = facts ? "sin precios" : "sin EDGAR"; continue; }
      const sec = usDesdeEdgar(facts), ultSec = sec.bal.length ? sec.bal[sec.bal.length - 1].end : null, yah = usDesdeYahoo(yahooSerie(yj), ultSec, hoyS);
      const bal = [...sec.bal, ...yah.bal], ni = [...sec.ni, ...yah.ni.filter(q => !sec.ni.some(z => Math.abs(dias(z.end, q.end)) <= 10))].sort((a, b) => a.end.localeCompare(b.end));
      const roe = roeTrimestral(bal, ni, () => 1), { m, splits } = precioDe(chart);
      const x = semanal({ price: m, bal, roe, conv: () => 1, splits, weeks, hoyS, maxBal: 200, maxRoe: 200 });
      series[c.s] = x;
      bancos[c.s] = { n: c.n, pais: "us", grupo: US_SUBS[c.sub], moneda: "USD", pb: x.pb.map(r3), ptb: x.ptb.map(r3), roe: x.roe.map(v => v == null ? null : r2(v * 100)),
        ult: resumen(x, c, bal, roe, chart?.meta?.regularMarketPrice ?? [...m.values()].pop(), false, 200), trimestres: bal.length };
      log(`${c.s}: ${sec.bal.length} balances de la SEC (${sec.bal[0]?.end} a ${ultSec})${yah.bal.length ? ` y ${yah.bal.length} de Yahoo (${yah.bal.map(b => b.end).join(" ")})` : ""}, ${roe.length} ROE, P/VL ${bancos[c.s].ult.pb}, P/VL tangible ${bancos[c.s].ult.ptb}, ROE ${bancos[c.s].ult.roe}%`);
    } catch (e) { errores[c.s] = e.message; log(`${c.s}: ${e.message}`); }
  }
  // Argentina
  for (const c of AR) {
    try {
      const [facts, chart, yj] = await Promise.all([c.cik ? secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`) : null, chartDe(c.px), yFund(c.px).catch(e => { errores[c.s + " Yahoo"] = e.message; return null; })]);
      if (!chart) { errores[c.s] = "sin precios"; continue; }
      const yser = yahooSerie(yj), sec = facts ? arDesdeEdgar(facts) : { bal: [], roe: [] }, yah = arDesdeYahoo(yser, hoyS);
      // por cierre: el trimestre de Yahoo, después el 20-F, después el ejercicio de Yahoo (reexpresado)
      const bal = unirObs([yah.bal.filter(b => b.src === "Yahoo trimestral"), sec.bal, yah.bal.filter(b => b.src === "Yahoo anual")]);
      // acciones que faltan: las del balance más cercano que las tenga
      for (const b of bal) if (!b.sh) { const o = bal.filter(y => y.sh).sort((p, q) => Math.abs(dias(p.end, b.end)) - Math.abs(dias(q.end, b.end)))[0]; if (o) b.sh = o.sh; }
      // ROE: 12 meses con los trimestres (Yahoo, con los balances del 20-F para el promedio) y, para atrás, los ejercicios
      const r12 = roeTrimestral(bal, yah.ni, conv);
      const roe = [...r12, ...roeConTrailing(bal, yser, conv, r12, hoyS), ...unirObs([sec.roe, yah.roe])];
      const { m, splits } = precioDe(chart);
      const x = semanal({ price: m, bal, roe, conv, splits, weeks, hoyS, maxBal: 470, maxRoe: 470 });
      series[c.s] = x;
      bancos[c.s] = { n: c.n, pais: "ar", grupo: AR_AGREGADO.includes(c.s) ? "ar" : "arOtros", moneda: "ARS", px: c.px, pb: x.pb.map(r3), ptb: x.ptb.map(r3), roe: x.roe.map(v => v == null ? null : r2(v * 100)),
        ult: resumen(x, c, bal, roe, chart?.meta?.regularMarketPrice ?? [...m.values()].pop(), true, 470),
        balances: bal.map(b => [b.end, b.src, Math.round(b.bv / 1e6), b.c]) };
      log(`${c.s}: balances ${bal.map(b => b.end + "(" + b.src.split(" ")[0] + ")").join(" ")}; ROE ${roe.map(r => r.end + " " + (r.roe * 100).toFixed(1) + "% " + r.tipo).join(", ")}; P/VL ${bancos[c.s].ult.pb}`);
    } catch (e) { errores[c.s] = e.message; log(`${c.s}: ${e.message}`); }
  }
  const nAr = AR_AGREGADO.filter(s => series[s]).length, nUs = US.filter(c => series[c.s]).length;
  if (nAr < 3 || nUs < 8) throw new Error(`Faltan bancos: ${nAr} argentinos y ${nUs} de EE.UU. (${JSON.stringify(errores)})`);
  const grupos = {
    ar: { n: "Bancos argentinos", desc: "Galicia, Macro, BBVA y Supervielle", ...agregado(series, AR_AGREGADO, weeks.length) },
    us: { n: "Bancos de EE.UU.", desc: "los del S&P 500: grandes y regionales", ...agregado(series, US.map(c => c.s), weeks.length) },
    usDiv: { n: "Bancos grandes de EE.UU.", desc: US.filter(c => c.sub === "Diversified Banks").map(c => c.s).join(", "), ...agregado(series, US.filter(c => c.sub === "Diversified Banks").map(c => c.s), weeks.length) },
    usReg: { n: "Bancos regionales de EE.UU.", desc: US.filter(c => c.sub === "Regional Banks").map(c => c.s).join(", "), ...agregado(series, US.filter(c => c.sub === "Regional Banks").map(c => c.s), weeks.length) },
  };
  // la primera semana con algún dato
  const first = Math.min(...Object.values(grupos).map(g => g.pb.findIndex(v => v != null)).filter(i => i >= 0));
  const cut = a => a.slice(first);
  for (const g of Object.values(grupos)) { g.pb = cut(g.pb); g.ptb = cut(g.ptb); g.roe = cut(g.roe); }
  for (const b of Object.values(bancos)) { b.pb = cut(b.pb); b.ptb = cut(b.ptb); b.roe = cut(b.roe); }
  const out = { version: VERSION, asOf: now.toISOString(), week0: weeks[first], monday0: MONDAY0, weeks: weeks.length - first,
    ipc: { desde: ipc.desde, hasta: ipc.ult },
    fuente: "SEC (EDGAR), Yahoo Finance e INDEC", grupos, bancos, errores };
  await writeFile(new URL("bancos.json", root), JSON.stringify(out));
  log(`bancos.json: ${Object.keys(bancos).length} bancos, ${out.weeks} semanas desde ${isoOf(MONDAY0 + out.week0 * WEEK)}; errores: ${JSON.stringify(errores)}`);
  return out;
}

// ---- diagnóstico: qué trae cada fuente (solo en el log)
const TIPOS_DIAG = ["StockholdersEquity", "CommonStockEquity", "TangibleBookValue", "NetIncomeCommonStockholders", "OrdinarySharesNumber"];
export async function diagnostico({ fetchImpl = globalThis.fetch, log = console.log, secUA = "tradingweb research@example.com" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  let s = null;
  try { s = await yahooSession(fetchImpl); log("Yahoo: sesión OK"); } catch (e) { log("Yahoo sesión: " + e.message); }
  const H = { "User-Agent": UA, Accept: "application/json", ...(s ? { Cookie: s.cookie } : {}) }, cr = s ? `&crumb=${encodeURIComponent(s.crumb)}` : "";
  // etiquetas de patrimonio, preferidas y acciones de los bancos de EE.UU. que se ven raros
  const spx = JSON.parse(await readFile(new URL("../spx.json", import.meta.url), "utf8")).list;
  for (const sym of ["BAC", "C", "TFC", "JPM"]) {
    const c = spx.find(x => x.s === sym); if (!c) continue;
    await new Promise(r => setTimeout(r, 300));
    const r = await fetchImpl(`https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`, { headers: { "User-Agent": secUA, Accept: "application/json" } });
    if (!r.ok) { log(`${sym}: companyfacts HTTP ${r.status}`); continue; }
    const g = (await r.json()).facts?.["us-gaap"] || {};
    log(`\n=== ${sym} (CIK ${c.cik})`);
    for (const [tag, o] of Object.entries(g)) {
      if (!/Equity|Preferred|SharesOutstanding|Goodwill|Intangible|AvailableToCommon/.test(tag) || /Method|Investment|Securities|Compensation|Award|Option|Increase|Decrease|Issued|Repurchase|Dividend|Adjustment|Changes|Unrealized|Accumulated|Tax|Fair|Reclass|Contracts|Plan|Fund/.test(tag)) continue;
      for (const [u, a] of Object.entries(o.units || {})) {
        const inst = a.filter(e => !e.start), recientes = a.filter(e => e.end >= "2025-06-30");
        if (!recientes.length) continue;
        const ult = a.slice().sort((x, y) => x.end.localeCompare(y.end) || x.filed.localeCompare(y.filed)).pop();
        log(`  ${tag} [${u}] ${a.length} (${inst.length} saldos), último ${ult.end} ${ult.val} ${ult.form} ${ult.filed}; desde 2025-06: ${[...new Set(recientes.map(e => e.end))].sort().join(" ")}`);
      }
    }
  }
  for (const sym of AR.map(c => c.px)) {
    const types = ["quarterly", "annual"].flatMap(p => TIPOS_DIAG.map(t => p + t)).join(",");
    try {
      const j = await getJSON(fetchImpl, `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types}&period1=946684800&period2=${now + DAY}${cr}`, H);
      const y = yahooSerie(j);
      log(`${sym}: trimestres ${Object.keys(y.q).sort().join(" ")}; ejercicios ${Object.keys(y.a).sort().join(" ")}`);
    } catch (e) { log(`${sym}: ${e.message}`); }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().then(() => {}, e => { console.error(e); process.exit(1); });
