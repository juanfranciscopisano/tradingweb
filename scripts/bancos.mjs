// Arma bancos.json: precio / valor libro (P/BV), P/BV tangible y ROE, semana a semana, de los bancos argentinos y de los
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
//
// Costo del capital (CAPM), cada semana y el de hoy: EE.UU., nominal = bono del Tesoro a 10 años + beta × prima de
// riesgo; Argentina, real = bono del Tesoro indexado (TIPS) a 10 años + riesgo país + beta × prima. Beta: regresión
// semanal de 5 años del agregado de bancos de EE.UU. contra el S&P 500, para los dos países. Prima: la implícita del
// S&P 500 que publica Damodaran cada mes. Tasas de FRED; riesgo país de argentinadatos.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { yahooSession } from "./fundamentals.mjs";
import { readXlsx, unzip, toISO, parseFredCsv } from "./macro.mjs";
import { mesDe } from "./bcra.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DAY = 86400, WEEK = 7 * DAY;
export const MONDAY0 = Date.UTC(1990, 0, 1) / 1000;          // las semanas se cuentan como en multiples.json
export const weekOf = t => Math.floor((t - MONDAY0) / WEEK);
export const W0 = weekOf(Date.UTC(2000, 0, 3) / 1000);        // primera semana de las series
const tOf = d => Math.floor(Date.parse(d + "T00:00:00Z") / 1000);
const isoOf = t => new Date(t * 1000).toISOString().slice(0, 10);
export const VERSION = 4;   // 2: precio semanal de cada banco; 3: costo del capital (ke); 4: historia desde 2000 con el BCRA

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
// Antes del primer dato del INDEC, la serie histórica de bcra.json (hist: { m0: "YYYYMM", v }), en la misma escala
export function ipcDe(indec, hist = null) {
  const I = indec?.datos?.ipc_nacional, s = (I?.series || []).find(x => /^nacional$/i.test(x.region || "") && /nivel general/i.test(x.descripcion || ""));
  if (!s || !I.d0) return null;
  const [y0, m0] = I.d0.split("-").map(Number), pts = [], fin = (y, m) => Date.UTC(y, m, 0) / 1000 + DAY - 1;   // fin de cada mes (m de 1 a 12)
  if (hist?.m0 && Array.isArray(hist.v)) {
    const hy = +hist.m0.slice(0, 4), hm = +hist.m0.slice(4, 6), lim = fin(y0, m0);
    hist.v.forEach((v, i) => { const t = fin(hy, hm + i); if (v > 0 && t < lim) pts.push([t, v]); });
  }
  s.v.forEach((v, i) => { if (v > 0) pts.push([fin(y0, m0 + i), v]); });
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
  // cada valor está en moneda del cierre del 20-F en que se presentó primero: los de 2017 salen como comparativos del de
  // 2018, reexpresados a diciembre de 2018 (NIC 29), y se llevan con el IPC desde ahí, no desde su fecha
  const finDe = new Map();
  for (const e of f[eqTag]?.units?.ARS || []) if (!e.start && e.end && e.accn && !(finDe.get(e.accn) >= e.end)) finDe.set(e.accn, e.end);
  const bal = [];
  for (const [end, e] of [...eq].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (e.val <= 0) continue;
    const it = intg.get(end)?.val ?? ((gw.get(end)?.val || 0) + (io.get(end)?.val || 0));
    const anual = end.slice(5) === "12-31";
    bal.push({ end, c: finDe.get(e.accn) || end, bv: e.val, tbv: e.val - it, sh: shOf(end), pub: Math.min(pubDe(end, e.filed, anual ? 75 : 60), tOf(end) + (anual ? 75 : 60) * DAY), src: "SEC 20-F" });
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
// Cada ejercicio de Yahoo viene como comparativo del balance del año siguiente (reexpresado a ese cierre) y el último, en
// su moneda: contra el balance del BCRA, 2022 en pesos de diciembre de 2023, 2023 en los de 2024 y 2024 y 2025 en los de
// 2025 (Patagonia e Hipotecario dan iguales a menos de 1% así; con todo en moneda del último, 2022 daba un tercio)
export const monedaYahoo = (end, fin) => { const sig = `${+end.slice(0, 4) + 1}${end.slice(4)}`; return sig < fin ? sig : fin; };
export function arDesdeYahoo(ys, hoyS, conv = null) {
  const bal = [], fin = Object.keys(ys.a).sort().pop();
  const bvDe = o => o.CommonStockEquity ?? o.StockholdersEquity;
  const pub = (end, lag) => Math.min(tOf(end) + lag * DAY, hoyS);
  for (const [end, o] of Object.entries(ys.q)) if (bvDe(o) > 0) bal.push({ end, c: end, bv: bvDe(o), tbv: o.TangibleBookValue ?? bvDe(o), sh: o.OrdinarySharesNumber || null, pub: pub(end, end.slice(5) === "12-31" ? 75 : 60), src: "Yahoo trimestral" });
  for (const [end, o] of Object.entries(ys.a)) if (bvDe(o) > 0) bal.push({ end, c: monedaYahoo(end, fin), bv: bvDe(o), tbv: o.TangibleBookValue ?? bvDe(o), sh: o.OrdinarySharesNumber || null, pub: pub(end, 75), src: "Yahoo anual" });
  // resultados trimestrales (para el ROE de 12 meses, que se arma con todas las fuentes juntas) y ROE de cada ejercicio:
  // resultado / promedio del patrimonio de cierre y de apertura (los dos en la misma moneda)
  const ni = Object.entries(ys.q).filter(([, o]) => isFinite(o.NetIncomeCommonStockholders)).map(([end, o]) => ({ end, c: end, val: o.NetIncomeCommonStockholders, pub: pub(end, end.slice(5) === "12-31" ? 75 : 60) })).sort((a, b) => a.end.localeCompare(b.end));
  const roe = [];
  const A = Object.entries(ys.a).sort((a, b) => a[0].localeCompare(b[0]));
  for (let i = 1; i < A.length; i++) {
    const [end, o] = A[i], [endP, oP] = A[i - 1];
    if (!isFinite(o.NetIncomeCommonStockholders) || !(bvDe(o) > 0) || !(bvDe(oP) > 0) || dias(endP, end) < 350 || dias(endP, end) > 380) continue;
    // el patrimonio de apertura, a la moneda del ejercicio (el resultado viene en la misma que su cierre)
    const c = monedaYahoo(end, fin), cP = monedaYahoo(endP, fin), avg = (bvDe(o) + bvDe(oP) * (conv && cP !== c ? conv(cP, c) : 1)) / 2;
    roe.push({ end, c, pub: pub(end, 75), roe: o.NetIncomeCommonStockholders / avg, ni: o.NetIncomeCommonStockholders, avg, roeQ: null, tipo: "ejercicio" });
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

// ---- Argentina antes de los 20-F y de Yahoo: el balance mensual del BCRA (bcra.json). Es el del banco: Macro, BBVA,
// Hipotecario y Patagonia cotizan como banco; Galicia cotiza como grupo y el banco es una aproximación, con las acciones
// del grupo (20-F de 2006: 1.092.407.017 desde el canje de julio de 2000 y 1.241.407.017 desde el aumento del 13/5/2004).
// Macro, desde diciembre de 2003, cuando Bansud (la que cotizaba) y Macro se fusionan en la entidad 285: antes, en ese
// código está el Macro que no cotizaba (36 millones de acciones contra 609). Cada mes vale desde 60 días después de su cierre
export const BCRA_MAP = {
  GGAL: { cod: "00007", aprox: true, acciones: [["2000-07-01", 1092407017], ["2004-05-13", 1241407017]] },
  BMA: { cod: "00285", desde: "200312" }, BBAR: { cod: "00017" },
  // Hipotecario y Patagonia no presentan 20-F: el BCRA hasta su último mes (contra Yahoo da lo mismo a menos de 1% en
  // 2024 y 2025, y es mensual en vez de un ejercicio por año); Yahoo, solo los trimestres posteriores
  BHIP: { cod: "00044", todo: true }, BPAT: { cod: "00034", todo: true },
};
const finDeMes = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(4, 6), 0)).toISOString().slice(0, 10);
export function balancesBcra(bcra, s, hastaBal, hastaRoe) {
  const m = BCRA_MAP[s], e = m && bcra?.entidades?.[m.cod];
  if (!e || !bcra.m0) return { bal: [], roe: [] };
  const bal = [];
  e.pn.forEach((pn, i) => {
    const mes = mesDe(i, bcra.m0), end = finDeMes(mes);
    if ((m.desde && mes < m.desde) || !(pn > 0) || (hastaBal && end >= hastaBal)) return;
    let sh = e.acciones?.[i] > 0 ? e.acciones[i] * 1000 : null;
    if (m.acciones) { const a = m.acciones.filter(([d]) => d <= end).pop(); sh = a ? a[1] : null; }
    if (!sh) return;
    bal.push({ end, pub: tOf(end) + 60 * DAY, bv: pn * 1000, tbv: (pn - Math.max(0, e.intang?.[i] || 0)) * 1000, sh, c: end, src: "BCRA" });
  });
  const roe = (e.ejercicios || []).filter(x => x.roeReal != null && (!m.desde || x.fin >= m.desde)).map(x => {
    const end = finDeMes(x.fin), r = x.roeReal / 100;
    const avg = (x.pnPromReal ?? x.pnProm) * 1000;
    return { end, pub: tOf(end) + 60 * DAY, roe: r, tipo: "ejercicio", ni: r * avg, avg, c: end, src: "BCRA" };
  }).filter(r => !hastaRoe || r.end < hastaRoe);
  return { bal, roe };
}

// ---- series semanales de un banco
// precio: Map semana → cierre. conv(c, t): de pesos de la fecha c a pesos del momento t (segundos); en EE.UU., 1.
// splits: [{ date, ratio }] (las acciones de un balance anterior a un split se multiplican por el ratio)
export function semanal({ price, bal, roe, conv, splits = [], weeks, hoyS, maxBal = 200, maxRoe = 200 }) {
  const MAX_BAL = maxBal * DAY, MAX_ROE = maxRoe * DAY;
  const B = bal.filter(b => b.bv > 0 && b.sh > 0).sort((a, b) => a.pub - b.pub || a.end.localeCompare(b.end));
  const R = roe.slice().sort((a, b) => a.pub - b.pub || a.end.localeCompare(b.end));
  const pb = [], ptb = [], ro = [], cap = [], bvT = [], tbvT = [], niT = [], avgT = [], px = [];
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
    cap.push(c); bvT.push(bv); tbvT.push(tbv); px.push(p > 0 ? p : null);
    pb.push(c != null && bv > 0 ? c / bv : null);
    ptb.push(c != null && tbv > 0 ? c / tbv : null);
    const rOk = r && t - tOf(r.end) <= MAX_ROE;
    ro.push(rOk ? r.roe : null);
    niT.push(rOk ? r.ni * conv(r.c, t) : null); avgT.push(rOk ? r.avg * conv(r.c, t) : null);
  }
  return { pb, ptb, roe: ro, cap, bvT, tbvT, niT, avgT, px };
}

// agregado de un grupo por semana: suma de capitalizaciones / suma de valores libro; ROE = suma de resultados / suma de
// patrimonios promedio. Solo las semanas en que las que tienen dato pesan al menos minCov de la capitalización de hoy.
export function agregado(series, syms, n, minCov = 0.85) {   // el argentino usa 0,5: para atrás no estaban todos
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

// ---- costo del capital
export const FRED_CSV = id => "https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + id + "&cosd=2005-01-01";
export const RP_URL = "https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais";
export const ERP_HOME = "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/home.htm";
export const ERP_MES = "https://pages.stern.nyu.edu/~adamodar/pc/implprem/ERPbymonth.xlsx";
const MESES_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// la prima de la página de Damodaran: "Implied ERP on November 1, 2026 = 4.41% (Trailing 12 month, with adjusted payout)".
// Publica varias, con distintos flujos de caja; se usa esa, la principal, o si no está, la primera
export function erpDeHome(html) {
  const txt = String(html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
  const all = [...txt.matchAll(/Implied ERP (?:on|for) ([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s*=\s*(\d+(?:\.\d+)?)\s*%\s*(\([^)]*\))?/gi)];
  const m = all.find(x => /trailing 12 month/i.test(x[5] || "") && /adjusted payout/i.test(x[5] || "")) || all[0];
  if (!m) return null;
  const mes = MESES_EN.indexOf(m[1].toLowerCase()) + 1, v = +m[4];
  if (!mes || !(v > 0 && v < 20)) return null;
  return { fecha: `${m[3]}-${String(mes).padStart(2, "0")}-${m[2].padStart(2, "0")}`, erp: v };
}
// fecha de una planilla de EE.UU.: número de serie de Excel, ISO, m/d/aaaa o "Sep-08" / "September 2008" (el día 1). Los
// libros hechos en Mac pueden contar los días desde 1904 (la planilla de Damodaran): son 1.462 días más
export function fechaUS(v, d1904 = false) {
  if (typeof v === "number") return toISO(d1904 ? v + 1462 : v);
  const s = String(v ?? "").trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) return `${m[3].length === 2 ? 2000 + +m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if ((m = s.match(/^([A-Za-z]{3,})\.?[\s-]+(\d{2}|\d{4})$/))) {
    const k = MESES_EN.findIndex(x => x.startsWith(m[1].toLowerCase().slice(0, 3)));
    return k >= 0 ? `${m[2].length === 2 ? 2000 + +m[2] : m[2]}-${String(k + 1).padStart(2, "0")}-01` : null;
  }
  return null;
}
// si el libro cuenta las fechas desde 1904
export const fecha1904 = buf => { try { return /<workbookPr\b[^>]*\bdate1904="(1|true)"/i.test(unzip(buf)["xl/workbook.xml"]?.toString("utf8") || ""); } catch (e) { return false; } };
// la planilla mensual (ERPbymonth.xlsx, hoja "Historical ERP"): la fila de encabezados con la fecha y columnas de ERP; la
// de los últimos 12 meses con payout ajustado o sostenible (la principal de la página, desde 2016) y, en los meses que no
// la tiene, la de los últimos 12 meses sin ajustar (la que publicaba antes) más la diferencia promedio entre las dos en
// los primeros 12 meses que están las dos, para que no salte. En % (0,0441 → 4,41)
export function erpDeExcel(hojas, d1904 = false) {
  for (const [hoja, filas] of Object.entries(hojas || {})) {
    for (let h = 0; h < Math.min(filas.length, 40); h++) {
      const head = (filas[h] || []).map(c => typeof c === "string" ? c.replace(/\s+/g, " ").trim() : "");
      const iF = head.findIndex(c => /^(start of (the )?month|month|date|fecha)\b/i.test(c));
      const cols = head.map((c, i) => /\bERP\b|risk premium/i.test(c) ? i : -1).filter(i => i >= 0 && i !== iF);
      if (iF < 0 || !cols.length) continue;
      const t12 = i => /t12 ?m|trailing 12/i.test(head[i]) && !/payout|riskfree|adj/i.test(head[i]);
      const iE = cols.find(i => /(adjusted|sustainable) payout/i.test(head[i])) ?? cols.find(t12) ?? cols[0], iR = cols.find(i => i !== iE && t12(i));
      const num = v => typeof v === "number" && isFinite(v) && v > 0 ? (v < 1 ? v * 100 : v) : null;
      const filasOk = filas.slice(h + 1).map(r => ({ d: fechaUS(r?.[iF], d1904), a: num(r?.[iE]), b: iR != null ? num(r?.[iR]) : null })).filter(x => x.d && (x.a != null || x.b != null)).sort((x, y) => x.d.localeCompare(y.d));
      const ambas = filasOk.filter(x => x.a != null && x.b != null).slice(0, 12);
      const ajuste = ambas.length ? ambas.reduce((t, x) => t + x.a - x.b, 0) / ambas.length : 0;
      const serie = filasOk.map(x => ({ fecha: x.d, erp: +(x.a ?? x.b + ajuste).toFixed(2) })), deRespaldo = filasOk.filter(x => x.a == null).length;
      if (serie.length >= 12) return { serie, hoja, columna: head[iE], respaldo: iR != null ? head[iR] : null, deRespaldo, ajuste: +ajuste.toFixed(2) };
    }
  }
  return null;
}
// riesgo país de argentinadatos: [{ fecha, valor }] en puntos básicos
export function rpDeArgentinadatos(j) {
  return (Array.isArray(j) ? j : []).filter(x => x && /^\d{4}-\d\d-\d\d$/.test(x.fecha || "") && isFinite(x.valor) && x.valor > 0)
    .map(x => [x.fecha, +x.valor]).sort((a, b) => a[0].localeCompare(b[0]));
}
// el último dato de cada semana hasta el viernes (la semana en curso, hasta hoy), si no tiene más de maxDias
export function porSemana(obs, weeks, hoyS, maxDias = 10) {
  const out = []; let j = -1;
  for (const w of weeks) {
    const t = Math.min(MONDAY0 + w * WEEK + 4 * DAY, hoyS), d = isoOf(t);
    while (j + 1 < obs.length && obs[j + 1][0] <= d) j++;
    out.push(j >= 0 && t - tOf(obs[j][0]) <= maxDias * DAY ? obs[j][1] : null);
  }
  return out;
}
// rendimiento semanal del agregado: cada banco pesado por su capitalización de la semana anterior
export function rendimientos(series, syms, n, minBancos = 5) {
  const out = new Array(n).fill(null);
  for (let k = 1; k < n; k++) {
    let W = 0, R = 0, c = 0;
    for (const s of syms) {
      const x = series[s]; if (!x) continue;
      const p0 = x.px[k - 1], p1 = x.px[k], w = x.cap[k - 1];
      if (p0 > 0 && p1 > 0 && w > 0) { W += w; R += w * (p1 / p0 - 1); c++; }
    }
    if (c >= minBancos) out[k] = R / W;
  }
  return out;
}
// beta de cada semana: regresión de los rendimientos de las últimas `ventana` semanas contra el mercado (al menos `minimo`)
export function betaRodante(rb, rm, ventana = 260, minimo = 104) {
  const n = rb.length, beta = new Array(n).fill(null), obs = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    let c = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = Math.max(0, k - ventana + 1); i <= k; i++) {
      const x = rm[i], y = rb[i];
      if (x == null || y == null) continue;
      c++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const vx = sxx - sx * sx / (c || 1);
    if (c >= minimo && vx > 0) { beta[k] = (sxy - sx * sy / c) / vx; obs[k] = c; }
  }
  return { beta, obs };
}
// costo del capital: EE.UU. = 10 años + beta × prima; Argentina = TIPS + riesgo país (puntos básicos / 100) + beta × prima
export function costoCapital({ ust, tips, rp, erp, beta }) {
  const us = [], ar = [];
  for (let k = 0; k < beta.length; k++) {
    const b = beta[k], e = erp[k], prima = b != null && e != null ? b * e : null;
    us.push(prima != null && ust[k] != null ? r2(ust[k] + prima) : null);
    ar.push(prima != null && tips[k] != null && rp[k] != null ? r2(tips[k] + rp[k] / 100 + prima) : null);
  }
  return { us, ar };
}
// baja todo y arma las series semanales y el de hoy. Lo que no se puede bajar queda como estaba en el bancos.json
// anterior (con su fecha) y se anota en errores
export async function datosKe({ fetchImpl, weeks, hoyS, series, usSyms, chartDe, prev, log = () => {} }) {
  const errores = {}, H = { "User-Agent": "Mozilla/5.0 (tradingweb; costo del capital)" };
  const bajar = async (url, bin) => {
    const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), 60000);
    try { const r = await fetchImpl(url, { headers: H, signal: ctrl.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return bin ? Buffer.from(await r.arrayBuffer()) : await r.text(); }
    finally { clearTimeout(tm); }
  };
  const previa = c => { const a = prev?.ke?.serie?.[c], w0 = prev?.week0; return weeks.map(w => a && w0 != null && w - w0 >= 0 && w - w0 < a.length ? a[w - w0] : null); };
  const hoyPrev = c => prev?.ke?.hoy?.comp?.[c] || null;
  const comp = {}, hoy = {};
  for (const [c, id] of [["ust", "DGS10"], ["tips", "DFII10"]]) {
    try {
      const s = parseFredCsv(await bajar(FRED_CSV(id)));
      if (s.length < 1000) throw new Error(s.length + " datos");
      comp[c] = porSemana(s, weeks, hoyS, 10); hoy[c] = { v: s.at(-1)[1], fecha: s.at(-1)[0], fuente: "FRED " + id };
    } catch (e) { errores[c] = id + ": " + e.message; comp[c] = previa(c); hoy[c] = hoyPrev(c); }
  }
  try {
    const s = rpDeArgentinadatos(JSON.parse(await bajar(RP_URL)));
    if (s.length < 1000) throw new Error(s.length + " datos");
    comp.rp = porSemana(s, weeks, hoyS, 10); hoy.rp = { v: s.at(-1)[1], fecha: s.at(-1)[0], fuente: "argentinadatos" };
  } catch (e) { errores.rp = "riesgo país: " + e.message; comp.rp = previa("rp"); hoy.rp = hoyPrev("rp"); }
  // prima: la serie mensual y, si es más nueva, la de la página
  let erpObs = null, pag = null;
  try {
    const buf = await bajar(ERP_MES, true), x = erpDeExcel(readXlsx(buf), fecha1904(buf));
    if (!x) throw new Error("no encontré la columna de la prima");
    // tiene que llegar hasta hace poco: si no, las fechas están mal leídas
    if (hoyS - tOf(x.serie.at(-1).fecha) > 75 * DAY) throw new Error("la planilla termina el " + x.serie.at(-1).fecha);
    erpObs = x.serie.map(o => [o.fecha, o.erp]);
  } catch (e) { errores.erpMes = "prima mensual: " + e.message; }
  try { pag = erpDeHome(await bajar(ERP_HOME)); if (!pag) throw new Error("no encontré la prima en la página"); }
  catch (e) { errores.erpPagina = "prima de la página: " + e.message; }
  if (erpObs) {
    if (pag && pag.fecha > erpObs.at(-1)[0]) erpObs.push([pag.fecha, pag.erp]);
    comp.erp = porSemana(erpObs, weeks, hoyS, 70);
    hoy.erp = { v: erpObs.at(-1)[1], fecha: erpObs.at(-1)[0], fuente: "Damodaran" };
  } else {
    comp.erp = previa("erp"); hoy.erp = hoyPrev("erp");
    if (pag) {   // sin la planilla: la historia anterior y, desde su fecha, la de la página
      let ult = null;
      weeks.forEach((w, k) => { const t = Math.min(MONDAY0 + w * WEEK + 4 * DAY, hoyS); if (isoOf(t) >= pag.fecha) comp.erp[k] = pag.erp; else if (comp.erp[k] != null) ult = comp.erp[k]; else if (ult != null) comp.erp[k] = ult; });
      hoy.erp = { v: pag.erp, fecha: pag.fecha, fuente: "Damodaran" };
    }
  }
  try {
    const chart = await chartDe("^GSPC");
    if (!chart) throw new Error("sin precios del S&P 500");
    const m = new Map(); (chart.timestamp || []).forEach((t, i) => { const c = chart.indicators?.quote?.[0]?.close?.[i]; if (c > 0) m.set(weekOf(t), c); });
    const pm = weeks.map(w => m.get(w) ?? null), rm = pm.map((p, k) => k && p > 0 && pm[k - 1] > 0 ? p / pm[k - 1] - 1 : null);
    const { beta, obs } = betaRodante(rendimientos(series, usSyms, weeks.length), rm);
    comp.beta = beta;
    let k = beta.length - 1; while (k >= 0 && beta[k] == null) k--;
    if (k < 0) throw new Error("menos de dos años de rendimientos");
    hoy.beta = { v: beta[k], semanas: obs[k], fecha: isoOf(Math.min(MONDAY0 + weeks[k] * WEEK + 4 * DAY, hoyS)), fuente: "regresión semanal contra el S&P 500" };
  } catch (e) { errores.beta = "beta: " + e.message; comp.beta = previa("beta"); hoy.beta = hoyPrev("beta"); }
  const ke = costoCapital(comp);
  const ok = c => hoy[c] && isFinite(hoy[c].v);
  const prima = ok("beta") && ok("erp") ? hoy.beta.v * hoy.erp.v : null;
  const usHoy = prima != null && ok("ust") ? r2(hoy.ust.v + prima) : null, arHoy = prima != null && ok("tips") && ok("rp") ? r2(hoy.tips.v + hoy.rp.v / 100 + prima) : null;
  const red = (a, d) => a.map(v => v == null ? null : +v.toFixed(d));
  for (const c of Object.keys(hoy)) if (hoy[c]) hoy[c] = { ...hoy[c], v: +hoy[c].v.toFixed(c === "beta" ? 3 : 2) };
  log(`costo del capital: EE.UU. ${usHoy}% (10 años ${hoy.ust?.v}% al ${hoy.ust?.fecha} + beta ${hoy.beta?.v} × prima ${hoy.erp?.v}% del ${hoy.erp?.fecha}), Argentina ${arHoy}% (TIPS ${hoy.tips?.v}% + riesgo país ${hoy.rp?.v} al ${hoy.rp?.fecha})` + (Object.keys(errores).length ? "; errores: " + JSON.stringify(errores) : ""));
  return {
    hoy: { us: usHoy, ar: arHoy, comp: hoy },
    serie: { us: ke.us, ar: ke.ar, ust: red(comp.ust, 2), tips: red(comp.tips, 2), rp: red(comp.rp, 0), erp: red(comp.erp, 2), beta: red(comp.beta, 3) },
    errores,
  };
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
  if (modo === "ke") return diagnosticoKe({ fetchImpl, log });
  if (modo === "bcra") return diagnosticoBcra({ fetchImpl, log });
  const hoyS = Math.floor(now.getTime() / 1000), errores = {};
  const spx = JSON.parse(await readFile(new URL("spx.json", root), "utf8"));
  const indec = JSON.parse(await readFile(new URL("indec.json", root), "utf8"));
  let bcra = null;
  try { bcra = JSON.parse(await readFile(new URL("bcra.json", root), "utf8")); } catch (e) { log("bcra.json: no está; Argentina arranca con los 20-F"); }
  const ipc = ipcDe(indec, bcra?.ipc);
  if (!ipc) throw new Error("indec.json sin el IPC nacional");
  const conv = (c, t) => ipc.at(typeof t === "number" ? t : tOf(t) + DAY - 1) / ipc.at(tOf(c) + DAY - 1);
  const US = spx.list.filter(c => US_SUBS[c.sub]).map(c => ({ s: c.s, n: c.n, cik: c.cik, sub: c.sub }));
  if (US.length < 8) throw new Error(`spx.json con ${US.length} bancos`);
  let lastSec = 0;
  const secGet = async url => { for (;;) { const w = lastSec + secGapMs - Date.now(); if (w <= 0) break; await new Promise(r => setTimeout(r, w)); } lastSec = Date.now(); return getJSON(fetchImpl, url, { "User-Agent": secUA, Accept: "application/json" }); };
  let ys = null;
  try { ys = await yahooSession(fetchImpl); } catch (e) { log("Yahoo (sesión): " + e.message); }
  const yH = { "User-Agent": UA, Accept: "application/json", ...(ys ? { Cookie: ys.cookie } : {}) }, cr = ys ? `&crumb=${encodeURIComponent(ys.crumb)}` : "";
  const p1 = Date.UTC(1999, 11, 27) / 1000;
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
      bancos[c.s] = { n: c.n, pais: "us", grupo: US_SUBS[c.sub], moneda: "USD", pb: x.pb.map(r3), ptb: x.ptb.map(r3), roe: x.roe.map(v => v == null ? null : r2(v * 100)), precio: x.px.map(r2),
        ult: resumen(x, c, bal, roe, chart?.meta?.regularMarketPrice ?? [...m.values()].pop(), false, 200), trimestres: bal.length };
      log(`${c.s}: ${sec.bal.length} balances de la SEC (${sec.bal[0]?.end} a ${ultSec})${yah.bal.length ? ` y ${yah.bal.length} de Yahoo (${yah.bal.map(b => b.end).join(" ")})` : ""}, ${roe.length} ROE, P/BV ${bancos[c.s].ult.pb}, P/BV tangible ${bancos[c.s].ult.ptb}, ROE ${bancos[c.s].ult.roe}%`);
    } catch (e) { errores[c.s] = e.message; log(`${c.s}: ${e.message}`); }
  }
  // Argentina
  for (const c of AR) {
    try {
      const [facts, chart, yj] = await Promise.all([c.cik ? secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`) : null, chartDe(c.px), yFund(c.px).catch(e => { errores[c.s + " Yahoo"] = e.message; return null; })]);
      if (!chart) { errores[c.s] = "sin precios"; continue; }
      const yser = yahooSerie(yj), sec = facts ? arDesdeEdgar(facts) : { bal: [], roe: [] }, yah = arDesdeYahoo(yser, hoyS, conv);
      // por cierre: el trimestre de Yahoo, después el 20-F, después el ejercicio de Yahoo (reexpresado)
      const bal0 = unirObs([yah.bal.filter(b => b.src === "Yahoo trimestral"), sec.bal, yah.bal.filter(b => b.src === "Yahoo anual")]);
      // para atrás, el BCRA: antes del primer balance de los 20-F o de Yahoo (en Hipotecario y Patagonia, hasta su último mes)
      const todo = !!BCRA_MAP[c.s]?.todo, roe0 = unirObs([sec.roe, yah.roe]), hist = balancesBcra(bcra, c.s, todo ? null : bal0[0]?.end, roe0[0]?.end);
      const ultBcra = hist.bal.at(-1)?.end, usados = todo && ultBcra ? bal0.filter(b => b.end > ultBcra) : bal0;
      const bal = [...hist.bal, ...usados];
      // acciones que faltan: las del balance más cercano que las tenga
      for (const b of bal) if (!b.sh) { const o = bal.filter(y => y.sh).sort((p, q) => Math.abs(dias(p.end, b.end)) - Math.abs(dias(q.end, b.end)))[0]; if (o) b.sh = o.sh; }
      // ROE: 12 meses con los trimestres (Yahoo, con los balances del 20-F para el promedio) y, para atrás, los ejercicios
      const r12 = roeTrimestral(bal, yah.ni, conv);
      const roe = [...r12, ...roeConTrailing(bal, yser, conv, r12, hoyS), ...roe0, ...hist.roe];
      const { m, splits } = precioDe(chart);
      const x = semanal({ price: m, bal, roe, conv, splits, weeks, hoyS, maxBal: 470, maxRoe: 470 });
      series[c.s] = x;
      bancos[c.s] = { n: c.n, pais: "ar", grupo: AR_AGREGADO.includes(c.s) ? "ar" : "arOtros", moneda: "ARS", ticker: c.px, pb: x.pb.map(r3), ptb: x.ptb.map(r3), roe: x.roe.map(v => v == null ? null : r2(v * 100)), precio: x.px.map(r2),
        ult: resumen(x, c, bal, roe, chart?.meta?.regularMarketPrice ?? [...m.values()].pop(), true, 470),
        balances: usados.map(b => [b.end, b.src, Math.round(b.bv / 1e6), b.c]),
        ...(hist.bal.length ? { bcra: { desde: hist.bal[0].end, hasta: hist.bal.at(-1).end, meses: hist.bal.length, aprox: !!BCRA_MAP[c.s]?.aprox, ejercicios: hist.roe.length } } : {}) };
      log(`${c.s}: ${hist.bal.length ? `BCRA ${hist.bal[0].end} a ${hist.bal.at(-1).end} (${hist.bal.length} meses, ${hist.roe.length} ejercicios); ` : ""}balances ${usados.map(b => b.end + "(" + b.src.split(" ")[0] + ")").join(" ")}; ROE ${roe.filter(r => r.src !== "BCRA").map(r => r.end + " " + (r.roe * 100).toFixed(1) + "% " + r.tipo).join(", ")}; P/BV ${bancos[c.s].ult.pb}`);
    } catch (e) { errores[c.s] = e.message; log(`${c.s}: ${e.message}`); }
  }
  const nAr = AR_AGREGADO.filter(s => series[s]).length, nUs = US.filter(c => series[c.s]).length;
  if (nAr < 3 || nUs < 8) throw new Error(`Faltan bancos: ${nAr} argentinos y ${nUs} de EE.UU. (${JSON.stringify(errores)})`);
  // costo del capital: si algo falla, lo de la corrida anterior
  let prev = null;
  try { prev = JSON.parse(await readFile(new URL("bancos.json", root), "utf8")); } catch (e) { /* primera vez */ }
  let ke = null;
  try { ke = await datosKe({ fetchImpl, weeks, hoyS, series, usSyms: US.map(c => c.s), chartDe, prev, log }); }
  catch (e) { errores.ke = e.message; log("costo del capital: " + e.message); ke = prev?.ke ? { ...prev.ke, anterior: true } : null; }
  const grupos = {
    ar: { n: "Bancos argentinos", desc: "Galicia, Macro, BBVA y Supervielle", ...agregado(series, AR_AGREGADO, weeks.length, 0.5) },
    us: { n: "Bancos de EE.UU.", desc: "los del S&P 500: grandes y regionales", ...agregado(series, US.map(c => c.s), weeks.length) },
    usDiv: { n: "Bancos grandes de EE.UU.", desc: US.filter(c => c.sub === "Diversified Banks").map(c => c.s).join(", "), ...agregado(series, US.filter(c => c.sub === "Diversified Banks").map(c => c.s), weeks.length) },
    usReg: { n: "Bancos regionales de EE.UU.", desc: US.filter(c => c.sub === "Regional Banks").map(c => c.s).join(", "), ...agregado(series, US.filter(c => c.sub === "Regional Banks").map(c => c.s), weeks.length) },
  };
  // la primera semana con algún dato (de un grupo o de un banco)
  const first = Math.min(...[...Object.values(grupos), ...Object.values(bancos)].map(g => g.pb.findIndex(v => v != null)).filter(i => i >= 0));
  const cut = a => a.slice(first);
  for (const g of Object.values(grupos)) { g.pb = cut(g.pb); g.ptb = cut(g.ptb); g.roe = cut(g.roe); }
  for (const b of Object.values(bancos)) { b.pb = cut(b.pb); b.ptb = cut(b.ptb); b.roe = cut(b.roe); b.precio = cut(b.precio); }
  // las series del costo del capital, con las mismas semanas (las de la corrida anterior ya están cortadas)
  if (ke && ke.serie && !ke.anterior) for (const c of Object.keys(ke.serie)) ke.serie[c] = cut(ke.serie[c]);
  if (ke) ke.fuentes = { ust: "FRED (DGS10)", tips: "FRED (DFII10)", rp: "argentinadatos", erp: "Damodaran, prima implícita del S&P 500", beta: "agregado de bancos de EE.UU. contra el S&P 500, semanal, 5 años" };
  const out = { version: VERSION, asOf: now.toISOString(), week0: weeks[first], monday0: MONDAY0, weeks: weeks.length - first,
    ipc: { desde: ipc.desde, hasta: ipc.ult },
    fuente: "SEC (EDGAR), Yahoo Finance e INDEC", grupos, bancos, ke, errores };
  await writeFile(new URL("bancos.json", root), JSON.stringify(out));
  log(`bancos.json: ${Object.keys(bancos).length} bancos, ${out.weeks} semanas desde ${isoOf(MONDAY0 + out.week0 * WEEK)}; errores: ${JSON.stringify(errores)}`);
  return out;
}

// ---- diagnóstico de los datos por entidad del BCRA (los que usa su sitio: indicadores, estados contables y situación de
// deudores), para ver si se pueden leer desde acá. Solo en el log
export const BCRA_ENT = { AAA00: "Sistema financiero", "00007": "Galicia", "00285": "Macro", "00017": "BBVA", "00027": "Supervielle", "00034": "Patagonia", "00044": "Hipotecario", "00198": "Valores" };
export async function diagnosticoBcra({ fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const ep = c => [["indicadores", `https://www.bcra.gob.ar/api/endpoints/indicadores-economicos.php?action=indicadores&category=${c}`],
    ["estados", `https://www.bcra.gob.ar/api/endpoints/entidades-financieras-estados-contables.php?category=${c}&lang=es`],
    ["deudores", `https://www.bcra.gob.ar/api/endpoints/entidades-financieras-situacion-deudores.php?category=${c}&lang=es`]];
  let ok = 0, mal = 0;
  for (const [c, n] of Object.entries(BCRA_ENT)) {
    for (const [k, url] of ep(c)) {
      try {
        const r = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0 (tradingweb; datos de bancos)", Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
        const txt = await r.text(), ct = r.headers.get("content-type") || "", cf = r.headers.get("cf-mitigated") || "";
        let j = null; try { j = JSON.parse(txt); } catch (e) { /* no es JSON */ }
        if (!r.ok || !j || j.success === false) { mal++; log(`${n} ${k}: HTTP ${r.status} ${ct}${cf ? " cf-mitigated " + cf : ""}; ${txt.slice(0, 160).replace(/\s+/g, " ")}`); continue; }
        ok++;
        const per = j.columnas ? Object.values(j.columnas) : j.fechas || [];
        let extra = "";
        if (k === "indicadores") { const f = t => Object.values(j.secciones || {}).flat().find(x => x.in_titulo.startsWith(t)); extra = ["A9", "A16", "R1", "C1"].map(t => { const x = f(t + " "); return x ? `${t} ${x.in_c5}` : t + " —"; }).join(", "); }
        if (k === "estados") { const pn = (j.filas || []).find(x => /P A T R I M O N I O/.test(x.titulo)); extra = "patrimonio " + (pn ? pn.valores.at(-1) : "—"); }
        if (k === "deudores") { const s4 = (j.filas || []).find(x => /^TF\.Sit\.4/.test(x.titulo)); extra = "situación 4 " + (s4 ? s4.valores.at(-1) : "—") + "%"; }
        log(`${n} ${k}: ${j.en_nombre || j.entidad || j.codigo || ""}, ${j.fecha_actualizacion?.texto || ""}, períodos ${per.join(" ")}; ${extra}`);
      } catch (e) { mal++; log(`${n} ${k}: ${e.message}`); }
      await new Promise(r => setTimeout(r, 400));
    }
  }
  log(`BCRA: ${ok} respuestas bien, ${mal} mal`);
}

// ---- diagnóstico del costo del capital: qué trae cada fuente, crudo y leído (solo en el log)
export async function diagnosticoKe({ fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const H = { "User-Agent": "Mozilla/5.0 (tradingweb; costo del capital)" };
  const bajar = async (url, bin) => { const r = await fetchImpl(url, { headers: H, signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error("HTTP " + r.status); return bin ? Buffer.from(await r.arrayBuffer()) : r.text(); };
  for (const id of ["DGS10", "DFII10"]) {
    try { const s = parseFredCsv(await bajar(FRED_CSV(id))); log(`${id}: ${s.length} datos, de ${s[0]?.join(" ")} a ${s.at(-1)?.join(" ")}`); } catch (e) { log(`${id}: ${e.message}`); }
  }
  try { const s = rpDeArgentinadatos(JSON.parse(await bajar(RP_URL))); log(`riesgo país: ${s.length} datos, de ${s[0]?.join(" ")} a ${s.at(-1)?.join(" ")}; últimos ${s.slice(-5).map(x => x.join(" ")).join(", ")}`); } catch (e) { log("riesgo país: " + e.message); }
  try {
    const html = await bajar(ERP_HOME), i = html.search(/Implied ERP/i);
    log("página de Damodaran: " + JSON.stringify(erpDeHome(html)) + "; texto: " + (i >= 0 ? html.slice(i, i + 400).replace(/\s+/g, " ") : "sin 'Implied ERP'"));
  } catch (e) { log("página de Damodaran: " + e.message); }
  try {
    const buf = await bajar(ERP_MES, true), hojas = readXlsx(buf), d1904 = fecha1904(buf);
    log(`fechas desde ${d1904 ? 1904 : 1900}`);
    for (const [n, filas] of Object.entries(hojas)) {
      log(`hoja "${n}": ${filas.length} filas`);
      filas.slice(0, 4).forEach((f, i) => log(`  ${i + 1}: ${JSON.stringify(f || []).slice(0, 400)}`));
      if (filas.length) log(`  última: ${JSON.stringify(filas.at(-1) || []).slice(0, 400)}`);
    }
    const x = erpDeExcel(hojas, d1904);
    log("leída: " + (x ? `${x.serie.length} meses, hoja "${x.hoja}", columna "${x.columna}" (${x.deRespaldo} meses con "${x.respaldo}" ${x.ajuste >= 0 ? "+" : ""}${x.ajuste}), de ${JSON.stringify(x.serie[0])} a ${JSON.stringify(x.serie.at(-1))}` : "no encontré la columna"));
  } catch (e) { log("planilla mensual de Damodaran: " + e.message); }
  try {
    const j = await getJSON(fetchImpl, `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1mo&interval=1wk`, { "User-Agent": UA, Accept: "application/json" });
    const r = j?.chart?.result?.[0]; log("S&P 500 semanal: " + (r ? r.timestamp.map((t, i) => isoOf(t) + " " + r.indicators.quote[0].close[i]?.toFixed(2)).join(", ") : "sin datos"));
  } catch (e) { log("S&P 500: " + e.message); }
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
