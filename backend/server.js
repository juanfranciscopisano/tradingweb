// tradingweb1 — backend sin crumb de Yahoo.
// Precios y series: Yahoo v7/spark y v8/chart (no piden cookie ni crumb).
// EPS trimestral: SEC EDGAR (US GAAP) y Finnhub para los que presentan 20-F (NU, PAM...).
// P/E, fw P/E, P/B y market cap NO salen de acá: los baja una vez por día la GitHub Action
// del repo de Pages (scripts/fundamentals.mjs -> fundamentals.json).
import express from "express";
import nodeFetch from "node-fetch";
import cors from "cors";
import { readFileSync } from "node:fs";

const fetch = globalThis.fetch || nodeFetch; // Node 18+ trae fetch nativo
const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";
const SEC_UA = process.env.SEC_UA || "tradingweb research@example.com"; // la SEC pide un contacto real: definir SEC_UA en Render
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const YH_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const BOOT = Date.now();

// ---------------------------------------------------------------- cache en memoria
// Muchos visitantes -> una sola llamada por clave y TTL. Un resultado "flojo"
// (keepIf da false, p.ej. EDGAR caído) se guarda solo 2 minutos para reintentar pronto.
const cache = new Map();
const inflight = new Map();
async function cached(key, ttlMs, producer, keepIf = () => true) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const data = await producer();
    const ttl = keepIf(data) ? ttlMs : Math.min(ttlMs, 2 * 60 * 1000);
    cache.set(key, { expires: Date.now() + ttl, data });
    if (cache.size > 3000) for (const [k, v] of cache) if (v.expires < Date.now()) cache.delete(k);
    return data;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function getJSON(url, { headers = {}, timeout = 9000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}

function parseSyms(raw, max = 200) {
  return [...new Set(String(raw || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean))].slice(0, max);
}

// ---------------------------------------------------------------- Yahoo (sin crumb)
async function yahoo(path) {
  let last;
  for (const h of YH_HOSTS) {
    try {
      return await getJSON(`https://${h}${path}`, { headers: { "User-Agent": UA, "Accept": "application/json" } });
    } catch (e) { last = e; if (e.status === 404) break; }
  }
  throw last;
}

// v7/spark acepta hasta 20 símbolos por llamada y trae la misma estructura que v8/chart.
async function sparkChunk(syms, range, interval) {
  const j = await yahoo(`/v7/finance/spark?symbols=${syms.map(encodeURIComponent).join(",")}&range=${range}&interval=${interval}`);
  if (j?.spark?.error) throw new Error(j.spark.error.description || "spark error");
  const out = {};
  for (const r of j?.spark?.result || []) {
    const resp = r.response?.[0];
    if (resp?.meta) out[r.symbol] = resp;
  }
  return out;
}

async function chartOne(sym, range, interval) {
  const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`);
  return j?.chart?.result?.[0] || null;
}

// Series para muchos símbolos: tandas de 20 por spark; si una tanda falla, chart símbolo por símbolo.
async function series(symbols, range, interval) {
  const uniq = [...new Set(symbols.filter(Boolean))];
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 20) chunks.push(uniq.slice(i, i + 20));
  let failures = 0, lastErr = null;
  const maps = await mapLimit(chunks, 3, async (ch) => {
    try { return await sparkChunk(ch, range, interval); }
    catch (e) {
      failures++; lastErr = e;
      console.error(`spark falló (${e.message}); paso a chart por símbolo`);
      const o = {};
      await mapLimit(ch, 4, async (s) => {
        try { const r = await chartOne(s, range, interval); if (r?.meta) o[s] = r; } catch (_) { /* símbolo sin datos */ }
      });
      return o;
    }
  });
  const out = Object.assign({}, ...maps);
  if (!Object.keys(out).length && failures === chunks.length && lastErr) throw lastErr;
  return out;
}

// Cierre anterior a partir de la serie diaria (por si meta no trae la variación del día).
function prevClose(resp) {
  const m = resp.meta || {};
  const ts = resp.timestamp || [];
  const cl = resp.indicators?.quote?.[0]?.close || [];
  const pts = ts.map((t, i) => [t, cl[i]]).filter(p => p[1] != null && isFinite(p[1]));
  if (!pts.length) return null;
  const off = m.gmtoffset || 0;
  const day = t => Math.floor((t + off) / 86400);
  const last = pts[pts.length - 1];
  if (m.regularMarketTime && day(last[0]) >= day(m.regularMarketTime)) return pts.length > 1 ? pts[pts.length - 2][1] : null;
  return last[1];
}

// Arma el mismo objeto que daba v7/quote en los campos que usa el frontend.
// OJO: meta.chartPreviousClose es el cierre ANTERIOR A LA VENTANA (no el de ayer), por eso no se usa.
function quoteFrom(sym, resp) {
  const m = resp?.meta || {};
  const price = m.regularMarketPrice;
  if (price == null || !isFinite(price)) return null;
  let chg = m.fulldayChange;
  let pct = m.fulldayChangePercent ?? m.regularMarketChangePercent;
  if (chg == null || pct == null) {
    const prev = prevClose(resp);
    if (prev) { chg = price - prev; pct = (price - prev) / prev * 100; }
    else if (pct != null) { chg = price - price / (1 + pct / 100); }
  }
  return {
    symbol: sym,
    shortName: m.shortName || m.longName || sym,
    longName: m.longName || m.shortName || sym,
    currency: m.currency,
    instrumentType: m.instrumentType,
    regularMarketPrice: price,
    regularMarketChange: chg ?? null,
    regularMarketChangePercent: pct ?? null,
    regularMarketPreviousClose: chg != null ? price - chg : null,
    regularMarketTime: m.regularMarketTime ?? null,
    fiftyTwoWeekHigh: m.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: m.fiftyTwoWeekLow ?? null,
  };
}

// ---------------------------------------------------------------- FRED (EFFR y rango de la Fed)
async function fredLast(id) {
  return cached(`fred:${id}`, 6 * 3600 * 1000, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      if (!r.ok) return null;
      const lines = (await r.text()).trim().split(/\r?\n/);
      for (let i = lines.length - 1; i > 0; i--) {
        const [date, v] = lines[i].split(",");
        const x = parseFloat(v);
        if (isFinite(x)) return { date, value: x };
      }
      return null;
    } finally { clearTimeout(t); }
  }, d => d != null).catch(() => null);
}

// EFFR y rango objetivo: API oficial de la Fed de Nueva York (FRED queda de respaldo).
async function nyfedEffr() {
  return cached("nyfed:effr", 3 * 3600 * 1000, async () => {
    const j = await getJSON("https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json",
      { headers: { "User-Agent": UA, "Accept": "application/json" }, timeout: 8000 });
    const r = j?.refRates?.[0];
    if (!r || !isFinite(r.percentRate)) return null;
    return { effr: r.percentRate, date: r.effectiveDate,
      lo: isFinite(r.targetRateFrom) ? r.targetRateFrom : null, hi: isFinite(r.targetRateTo) ? r.targetRateTo : null };
  }, d => d != null).catch(() => null);
}

// ---------------------------------------------------------------- SEC EDGAR (con freno: la SEC admite 10 req/s)
let secActive = 0, secLastStart = 0;
const secWaiters = [];
async function secSlot() {
  for (;;) {
    const gap = Date.now() - secLastStart;
    if (secActive < 4 && gap >= 130) { secActive++; secLastStart = Date.now(); return; }
    await new Promise(r => { secWaiters.push(r); setTimeout(r, Math.max(30, 130 - gap)); });
  }
}
function secRelease() { secActive--; const w = secWaiters.shift(); if (w) w(); }
async function secJSON(url) {
  await secSlot();
  try { return await getJSON(url, { headers: { "User-Agent": SEC_UA, "Accept": "application/json" }, timeout: 20000 }); }
  finally { secRelease(); }
}

async function cikFor(sym) {
  const map = await cached("sec:tickers", 24 * 3600 * 1000, async () => {
    const j = await secJSON("https://www.sec.gov/files/company_tickers.json");
    const m = {};
    for (const c of Object.values(j || {})) m[String(c.ticker).toUpperCase()] = String(c.cik_str).padStart(10, "0");
    return m;
  }, m => Object.keys(m).length > 1000);
  return map[sym] || map[sym.replace(/\./g, "-")] || null;
}

// ---- EDGAR: EPS contable y normalizado ----
// Los datos crudos se cachean por ticker; el ajuste por splits se hace en cada pedido con los splits de Yahoo.
// Splits: EDGAR guarda cada trimestre tal como se presentó. Si un split ocurrió DESPUÉS del cierre del
// trimestre y DESPUÉS de presentado el dato, ese dato está sin ajustar (los precios de Yahoo sí están
// ajustados), así que se divide por el ratio. Si la empresa lo volvió a presentar después del split, ya
// viene reexpresado y no se toca.
const EDGAR_TAGS = {
  eps: [["EarningsPerShareDiluted"], "USD/shares"],
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
function rawFromFacts(facts) {
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

function makeSplitFactor(splits) {
  return (end, filed) => {
    const tEnd = Date.parse(end) / 1000, tFiled = filed ? Date.parse(filed) / 1000 : 0;
    let f = 1;
    for (const s of splits) if (s.date > tEnd && s.date > tFiled) f *= s.ratio;
    return f;
  };
}

// trimestre calendario por el punto medio del período (sirve para ejercicios que no cierran en diciembre)
const qkeyOf = end => { const d = new Date(Date.parse(end) - 45 * 86400000); return d.getUTCFullYear() + "Q" + (Math.floor(d.getUTCMonth() / 3) + 1); };

// EPS diluido trimestral (contable). Q1-Q3 salen de los frames CY####Q#; el trimestre faltante se
// deriva como anual menos YTD (soporta cierres de ejercicio no calendario).
function gaapQuarterly(raw, splitFactor, symbol) {
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
function normalizedQuarterly(raw, splitFactor, gaap, symbol) {
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

async function edgarRaw(sym) {
  return cached(`edgar:${sym}`, 12 * 3600 * 1000, async () => {
    try {
      const cik = await cikFor(sym);
      if (!cik) return null;
      return rawFromFacts(await secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`));
    } catch (e) {
      console.log(`pebg ${sym}: EDGAR error ${e.message}`);
      return null;
    }
  }, d => d != null && d.eps.length >= 4);
}

async function edgarEPS(sym, splits = []) {
  const raw = await edgarRaw(sym);
  if (!raw) return { gaap: [], norm: [] };
  const f = makeSplitFactor(splits);
  const gaap = gaapQuarterly(raw, f, sym);
  const n = normalizedQuarterly(raw, f, gaap, sym);
  return { gaap, norm: n.eps, normMethod: n.method };
}

// ---------------------------------------------------------------- EPS cargado a mano
// data/eps_manual.json: trimestres relevados de los 6-K/20-F para los que EDGAR no estructura
// por trimestre (NU, PAM). Se edita a mano; el backend lo lee al arrancar.
let MANUAL_EPS = {};
try {
  MANUAL_EPS = JSON.parse(readFileSync(new URL("./data/eps_manual.json", import.meta.url), "utf8"));
} catch (e) {
  console.log("eps_manual.json: " + e.message);
}
function manualEPS(sym) {
  const m = MANUAL_EPS[sym];
  if (!m || !Array.isArray(m.trimestres)) return null;
  const rows = m.trimestres
    .filter(r => r.fin && isFinite(r.eps))
    .map(r => ({ date: Math.floor(Date.parse(r.fin + "T00:00:00Z") / 1000), eps: +r.eps, adj: r.epsAjustado }))
    .sort((a, b) => a.date - b.date);
  if (rows.length < 4) return null;
  return {
    gaap: rows.map(r => ({ date: r.date, eps: r.eps })),
    // donde la empresa no publicó ajustado, el contable
    norm: m.normalizado ? rows.map(r => ({ date: r.date, eps: r.adj != null && isFinite(r.adj) ? +r.adj : r.eps })) : [],
    normNote: m.normalizado || null,
  };
}

// ---------------------------------------------------------------- Finnhub
async function finnhub(path) {
  if (!FINNHUB_KEY) throw new Error("FINNHUB_KEY no configurada");
  return getJSON(`https://finnhub.io/api/v1${path}`, { headers: { "X-Finnhub-Token": FINNHUB_KEY }, timeout: 9000 });
}

// EPS de los últimos trimestres (ajustado, como el earningsHistory que daba Yahoo).
async function finnhubEPS(sym) {
  return cached(`fh:eps:${sym}`, 12 * 3600 * 1000, async () => {
    try {
      const arr = await finnhub(`/stock/earnings?symbol=${encodeURIComponent(sym)}`);
      return (Array.isArray(arr) ? arr : [])
        .filter(e => e.actual != null && e.period)
        .map(e => ({ date: Math.floor(Date.parse(e.period + "T00:00:00Z") / 1000), eps: +e.actual }))
        .filter(e => isFinite(e.date) && isFinite(e.eps))
        .sort((a, b) => a.date - b.date);
    } catch (e) {
      console.log(`pebg ${sym}: Finnhub error ${e.message}`);
      return [];
    }
  }, a => a.length > 0);
}

// ---------------------------------------------------------------- rutas
app.get("/", (req, res) => res.json({ status: "ok", uptimeMin: Math.round((Date.now() - BOOT) / 60000) }));

app.get("/debug", (req, res) => res.json({
  status: "ok",
  uptimeMin: Math.round((Date.now() - BOOT) / 60000),
  finnhub: FINNHUB_KEY ? `set (len=${FINNHUB_KEY.length})` : "missing",
  secUA: process.env.SEC_UA ? "custom" : "default (definir SEC_UA)",
  cacheEntries: cache.size,
}));

app.get("/api/quote", async (req, res) => {
  const syms = parseSyms(req.query.symbols);
  if (!syms.length) return res.status(400).json({ error: "symbols required" });
  try {
    const data = await cached(`quote:${syms.join(",")}`, 45 * 1000, async () => {
      const m = await series(syms, "5d", "1d");
      return { quoteResponse: { result: syms.map(s => m[s] && quoteFrom(s, m[s])).filter(Boolean), error: null } };
    }, d => d.quoteResponse.result.length > 0);
    res.json(data);
  } catch (e) {
    console.error("quote:", e.message);
    res.status(502).json({ error: "Yahoo " + e.message });
  }
});

const SPARK_RANGES = ["1d", "5d", "1mo", "3mo", "6mo", "ytd", "1y", "2y"];
const SPARK_INTERVALS = ["1d", "5m", "15m", "30m", "60m"];
app.get("/api/spark", async (req, res) => {
  const syms = parseSyms(req.query.symbols);
  if (!syms.length) return res.status(400).json({ error: "symbols required" });
  let range = SPARK_RANGES.includes(req.query.range) ? req.query.range : "1y";
  const interval = SPARK_INTERVALS.includes(req.query.interval) ? req.query.interval : "1d";
  if (interval !== "1d" && !["1d", "5d"].includes(range)) range = "1d"; // Yahoo da intradiario solo para ventanas cortas
  try {
    const ttl = interval === "1d" ? 10 * 60 * 1000 : 2 * 60 * 1000;
    const data = await cached(`spark:${range}:${interval}:${syms.join(",")}`, ttl, async () => {
      const m = await series(syms, range, interval);
      const result = syms.filter(s => m[s]).map(s => ({
        symbol: s,
        quote: quoteFrom(s, m[s]),
        // chartPreviousClose: cierre previo a la ventana (con range=1d, el de ayer)
        response: [{ meta: { chartPreviousClose: m[s].meta?.chartPreviousClose ?? null }, timestamp: m[s].timestamp || [], indicators: { quote: [{ close: m[s].indicators?.quote?.[0]?.close || [] }] } }],
      }));
      return { spark: { result, error: null } };
    }, d => d.spark.result.length > 0);
    res.json(data);
  } catch (e) {
    console.error("spark:", e.message);
    res.status(502).json({ error: "Yahoo " + e.message });
  }
});

const MONTH_CODES = "FGHJKMNQUVXZ";
function zqTickers(n = 9) {
  const now = new Date();
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    out.push(`ZQ${MONTH_CODES[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(-2)}.CBT`);
  }
  return out;
}

const OV_SYMBOLS = [
  "^GSPC", "^IXIC", "^DJI", "^RUT", "ES=F", "NQ=F", "YM=F", "RTY=F", "^VIX",
  "^STOXX50E", "^GDAXI", "^N225", "^HSI", "^MERV", "DX-Y.NYB",
  "GC=F", "CL=F", "BZ=F", "SI=F", "HG=F", "NG=F",
  "^IRX", "^FVX", "^TNX", "^TYX",
];

app.get("/api/overview", async (req, res) => {
  try {
    const payload = await cached("overview", 60 * 1000, async () => {
      const zq = zqTickers();
      const syms = [...OV_SYMBOLS, ...zq];
      const [m, ny] = await Promise.all([series(syms, "5d", "1d"), nyfedEffr()]);
      let effr = ny?.effr ?? null, effrDate = ny?.date ?? null;
      let fedTarget = (ny && ny.lo != null && ny.hi != null) ? { lo: ny.lo, hi: ny.hi, date: ny.date } : null;
      if (effr == null || !fedTarget) {
        const [fe, lo, hi] = await Promise.all([fredLast("EFFR"), fredLast("DFEDTARL"), fredLast("DFEDTARU")]);
        if (effr == null && fe) { effr = fe.value; effrDate = fe.date; }
        if (!fedTarget && lo && hi) fedTarget = { lo: lo.value, hi: hi.value, date: hi.date };
      }
      return {
        quotes: syms.map(s => m[s] && quoteFrom(s, m[s])).filter(Boolean),
        zqTickers: zq,
        effr, effrDate, fedTarget,
      };
    }, d => d.quotes.length > 0);
    res.json(payload);
  } catch (e) {
    console.error("overview:", e.message);
    res.status(502).json({ error: "Yahoo " + e.message });
  }
});

app.get("/api/pebg", async (req, res) => {
  const sym = (req.query.symbol || "").toUpperCase().trim();
  if (!sym) return res.status(400).json({ error: "symbol required" });
  try {
    // años de precios: P/E Hist pide 16 (ventanas de hasta 15 años); Cartera pide 2 para ir más liviana
    const years = Math.min(16, Math.max(1, parseInt(req.query.years, 10) || 16));
    const payload = await cached(`pebg:${sym}:${years}`, 30 * 60 * 1000, async () => {
      const now = Math.floor(Date.now() / 1000);
      const p1 = now - Math.round(years * 365.25 * 86400);
      const chartJ = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${now}&interval=1d&events=splits`);
      const chart = chartJ?.chart?.result?.[0];
      if (!chart) throw new Error("Sin precios para " + sym);
      // splits dentro de la ventana pedida (alcanza: los EPS más viejos que la ventana no se usan)
      const splits = Object.values(chart.events?.splits || {})
        .map(s => ({ date: s.date, ratio: (s.numerator && s.denominator) ? s.numerator / s.denominator : null }))
        .filter(s => s.ratio && isFinite(s.ratio) && s.ratio > 0);
      const manual = manualEPS(sym);
      const edgarAll = manual ? { gaap: [], norm: [] } : await edgarEPS(sym, splits);
      const ts = chart.timestamp || [];
      const closes = chart.indicators?.quote?.[0]?.close || [];
      const prices = ts.map((t, i) => ({ date: t, close: closes[i] == null ? null : +closes[i].toFixed(4) })).filter(p => p.close != null);
      const edgar = edgarAll.gaap;

      // EDGAR (GAAP) manda; Finnhub completa trimestres que EDGAR todavía no tiene o reemplaza si no hay 10-Q (20-F).
      const toQKey = t => { const d = new Date(t * 1000); return d.getUTCFullYear() + "Q" + (Math.floor(d.getUTCMonth() / 3) + 1); };
      let eps, source, epsNorm, normMethod, normNote = null;
      if (manual) {
        // trimestres posteriores al último cargado a mano: Finnhub, solo si en el último trimestre que
        // tienen en común coincide (si no, viene en otra moneda o por acción local, como PAM en pesos)
        const fh = await finnhubEPS(sym);
        const mq = new Map(manual.gaap.map(e => [toQKey(e.date), e.eps]));
        const common = fh.filter(e => mq.has(toQKey(e.date))).pop();
        const ref = common ? mq.get(toQKey(common.date)) : null;
        const sameUnits = common && Math.abs(common.eps - ref) <= 0.2 * Math.max(Math.abs(ref), 0.01);
        const lastDate = manual.gaap[manual.gaap.length - 1].date;
        const extra = sameUnits ? fh.filter(e => e.date > lastDate + 20 * 86400 && !mq.has(toQKey(e.date))) : [];
        eps = [...manual.gaap, ...extra];
        source = extra.length ? "manual+finnhub" : "manual";
        epsNorm = manual.norm.length ? [...manual.norm, ...extra] : [];
        normMethod = manual.norm.length ? "ajustado_empresa" : null;
        normNote = manual.normNote;
      } else {
        // Finnhub solo si hace falta: sin 10-Q (20-F) o con el último trimestre de EDGAR viejo (>110 días)
        const edgarStale = !edgar.length || (Date.now() / 1000 - edgar[edgar.length - 1].date) > 110 * 86400;
        const fh = (edgar.length < 4 || edgarStale) ? await finnhubEPS(sym) : [];
        if (edgar.length >= 4) {
          const have = new Set(edgar.map(e => toQKey(e.date)));
          const gaps = fh.filter(e => !have.has(toQKey(e.date)) && e.date > edgar[edgar.length - 1].date);
          eps = [...edgar, ...gaps].sort((a, b) => a.date - b.date);
          source = gaps.length ? "edgar+finnhub" : "edgar";
        } else {
          eps = fh.length ? fh : edgar;
          source = fh.length ? "finnhub" : (edgar.length ? "edgar" : "none");
        }
        // Normalizado: el operativo de EDGAR; para los que presentan 20-F, el ajustado de Finnhub (es lo único que hay)
        epsNorm = edgarAll.norm; normMethod = epsNorm.length >= 4 ? edgarAll.normMethod : null;
        if (!normMethod && source === "finnhub") { epsNorm = fh; normMethod = "ajustado"; }
      }
      const meta = chart.meta || {};
      const last4 = eps.slice(-4);
      return {
        symbol: sym,
        shortName: meta.shortName || meta.longName || sym,
        prices,
        eps: eps.map(e => ({ date: e.date, eps: e.eps })),
        epsNorm: normMethod ? epsNorm.map(e => ({ date: e.date, eps: e.eps })) : [],
        normMethod,
        normNote,
        epsCount: eps.length,
        epsSource: source,
        splits: splits.map(x => ({ date: x.date, ratio: x.ratio })),
        currentPrice: meta.regularMarketPrice ?? (prices.length ? prices[prices.length - 1].close : null),
        currentPE: null,
        forwardPE: null, // el frontend lo completa con fundamentals.json
        epsTrailingTwelveMonths: last4.length === 4 ? last4.reduce((s, e) => s + e.eps, 0) : null,
      };
    }, d => d.epsCount >= 4);
    res.json(payload);
  } catch (e) {
    console.error("pebg:", sym, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/debug-edgar", async (req, res) => {
  try {
    const sym = (req.query.symbol || "META").toUpperCase();
    const raw = await edgarRaw(sym);
    if (!raw) return res.json({ error: "ticker not found o EDGAR sin datos" });
    const { gaap, norm } = await edgarEPS(sym, []);
    const nmap = new Map(norm.map(e => [e.frame, e.eps]));
    res.json({ sym, trimestres: gaap.length, normalizados: norm.length,
      ultimos: gaap.slice(-12).map(e => ({ frame: e.frame, contable: e.eps, normalizado: nmap.get(e.frame) ?? null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Para confirmar qué campos devuelve Finnhub con tu key (después del deploy: /debug-finnhub?symbol=AAPL)
app.get("/debug-finnhub", async (req, res) => {
  try {
    const sym = (req.query.symbol || "AAPL").toUpperCase();
    const [metric, earnings] = await Promise.all([
      finnhub(`/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all`).catch(e => ({ error: e.message })),
      finnhub(`/stock/earnings?symbol=${encodeURIComponent(sym)}`).catch(e => ({ error: e.message })),
    ]);
    const m = metric?.metric || {};
    const keys = Object.fromEntries(Object.entries(m).filter(([k]) => /pe|pb|eps|book|cap|forward/i.test(k)));
    res.json({ sym, metricError: metric?.error || null, metricKeys: keys, earnings: Array.isArray(earnings) ? earnings.slice(0, 4) : earnings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log("Server on port", PORT));
