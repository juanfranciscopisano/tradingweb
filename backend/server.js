// tradingweb1 — backend sin crumb de Yahoo.
// Precios y series: Yahoo v7/spark y v8/chart (no piden cookie ni crumb).
// EPS trimestral: SEC EDGAR (US GAAP) y Finnhub para los que presentan 20-F (NU, PAM...).
// P/E, fw P/E, P/B y market cap NO salen de acá: los baja una vez por día la GitHub Action
// del repo de Pages (scripts/fundamentals.mjs -> fundamentals.json).
import express from "express";
import nodeFetch from "node-fetch";
import cors from "cors";
import { readFileSync } from "node:fs";
import { rawFromFacts, makeSplitFactor, gaapQuarterly, normalizedQuarterly, mergeRaw, cashDebt, quality, quarterSeries, PREDECESSOR_CIK, EPS_PER_SHARE_DIV } from "./edgar.mjs";

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

async function edgarRaw(sym) {
  return cached(`edgar:${sym}`, 12 * 3600 * 1000, async () => {
    try {
      const cik = await cikFor(sym);
      if (!cik) return null;
      const raw = rawFromFacts(await secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`));
      const pre = PREDECESSOR_CIK[sym];   // XOM se reorganizó como holding: la historia está en el CIK anterior
      return pre ? mergeRaw(raw, rawFromFacts(await secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pre}.json`).catch(() => null))) : raw;
    } catch (e) {
      console.log(`pebg ${sym}: EDGAR error ${e.message}`);
      return null;
    }
  }, d => d != null && d.eps.length >= 4);
}

async function edgarEPS(sym, splits = []) {
  let raw = await edgarRaw(sym);
  if (!raw) return { gaap: [], norm: [] };
  if (EPS_PER_SHARE_DIV[sym]) raw = { ...raw, eps: raw.eps.map(e => ({ ...e, val: e.val / EPS_PER_SHARE_DIV[sym] })) };
  const f = makeSplitFactor(splits);
  const gaap = gaapQuarterly(raw, f, sym);
  const n = normalizedQuarterly(raw, f, gaap, sym);
  console.log(`pebg ${sym}: normalizado (${n.method}) ${n.eps.length} trimestres, ${(n.adj || []).length} con ajustes, ${(n.flags || []).length} márgenes raros`);
  let cd = null;
  try { cd = cashDebt(raw, n.rows); } catch (e) { console.log(`pebg ${sym}: caja y deuda ${e.message}`); }
  let q = null;
  try { q = quality(raw, n.rows); } catch (e) { console.log(`pebg ${sym}: calidad ${e.message}`); }
  let ventas = [];
  try { ventas = quarterSeries(raw.rev).map(x => ({ date: Math.floor(x.t / 1000), v: Math.round(x.eps / 1e5) / 10 })); } catch (e) { /* sin ventas */ }
  return { gaap, norm: n.eps, normMethod: n.method, normAdj: n.adj || [], normFlags: n.flags || [], cd, q, ventas };
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
// data/eps_hist.json: EPS trimestral anterior a 2008 (antes de XBRL) cargado a mano desde los 10-K originales,
// tal como se publicó; al usarlo se ajusta por los splits posteriores a cada presentación.
let EPS_HIST = {};
try {
  EPS_HIST = JSON.parse(readFileSync(new URL("./data/eps_hist.json", import.meta.url), "utf8"));
} catch (e) {
  console.log("eps_hist.json: " + e.message);
}
// trimestres de eps_hist anteriores al primero de la serie, ajustados por splits
function histBefore(sym, firstDate, splits) {
  const h = EPS_HIST[sym];
  if (!h || !firstDate) return [];
  const f = makeSplitFactor(splits);
  const pre = h.trimestres.filter(q => Date.parse(q.end) / 1000 < firstDate - 30 * 86400);
  // solo si empalma: el último trimestre cargado tiene que ser el anterior al primero de EDGAR (si no, queda un hueco)
  if (!pre.length || firstDate - Date.parse(pre[pre.length - 1].end) / 1000 > 200 * 86400) return [];
  return pre.map(q => ({ date: Math.floor(Date.parse(q.end) / 1000), eps: +(q.eps / f(q.end, q.filed)).toFixed(4) }));
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

// ---------------------------------------------------------------- trimestres que la SEC todavía no tiene
// El proceso diario de múltiplos los completa con el EPS diluido contable de Yahoo y los publica en eps_ttm.json
// (campo fill). P/E histórico usa esos mismos, así el P/E de cada empresa coincide con el del screener.
const EPS_TTM_URL = process.env.EPS_TTM_URL || "https://juanfranciscopisano.github.io/tradingweb/eps_ttm.json";
let FILL = { t: 0, data: {} };
async function yahooFill(sym) {
  if (Date.now() - FILL.t > 3600 * 1000) {
    try {
      const j = await getJSON(EPS_TTM_URL, { timeout: 8000 });
      FILL = { t: Date.now(), data: (j && j.fill) || {} };
    } catch (e) { FILL = { t: Date.now() - 3000 * 1000, data: FILL.data }; }   // reintenta en 10 min
  }
  return (FILL.data[sym] || []).map(([d, eps]) => ({ date: Math.floor(Date.parse(d + "T00:00:00Z") / 1000), eps }));
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

const SPARK_RANGES = ["1d", "5d", "1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y"];
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

// ---------------------------------------------------------------- futuros de fed funds: historia diaria
// Para ver cómo cambiaron las probabilidades de cada reunión (hace 1 semana, 1 y 3 meses): los mismos contratos ZQ
// del Resumen, 6 meses de cierres diarios.
app.get("/api/fedhist", async (req, res) => {
  try {
    const payload = await cached("fedhist", 30 * 60 * 1000, async () => {
      const zq = zqTickers();
      const m = await series(zq, "6mo", "1d");
      const out = {};
      for (const [sym, r] of Object.entries(m || {})) {
        const ts = r.timestamp || [], cl = r.indicators?.quote?.[0]?.close || [];
        out[sym] = ts.map((t, i) => [t, cl[i]]).filter(x => x[1] != null && x[1] > 90 && x[1] < 100).map(([t, c]) => [t, +c.toFixed(4)]);
      }
      return { zq: out };
    }, d => Object.values(d.zq).some(a => a.length > 20));
    res.json(payload);
  } catch (e) {
    console.error("fedhist:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ---------------------------------------------------------------- Treasuries: curva oficial y cambios
// Curva par del Tesoro (cierre oficial de cada día hábil, se publica a la tarde): da 1 y 2 años, que Yahoo no tiene.
// Para 13 semanas, 5, 10 y 30 años se usan las series diarias de Yahoo (^IRX, ^FVX, ^TNX, ^TYX), las mismas del
// dato intradiario, así los cambios a 1 semana, 1, 3 y 6 meses no mezclan fuentes.
const UST_COLS = { "3 Mo": "3M", "6 Mo": "6M", "1 Yr": "1Y", "2 Yr": "2Y", "5 Yr": "5Y", "10 Yr": "10Y", "30 Yr": "30Y" };
async function treasuryYear(year) {
  return cached(`ust:${year}`, (year === new Date().getUTCFullYear() ? 30 * 60 : 24 * 3600) * 1000, async () => {
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      if (!r.ok) return [];
      const lines = (await r.text()).trim().split(/\r?\n/);
      const head = lines[0].split(",").map(h => h.replace(/"/g, "").trim());
      return lines.slice(1).map(l => {
        const c = l.split(","), [m, d, y] = c[0].split("/");
        const row = { date: `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` };
        head.forEach((h, i) => { if (UST_COLS[h] && c[i] !== "" && isFinite(+c[i])) row[UST_COLS[h]] = +c[i]; });
        return row;
      }).filter(r => r.date.length === 10);
    } finally { clearTimeout(t); }
  }, rows => rows.length > 0).catch(() => []);
}
// Curva en tiempo real: CNBC (Tradeweb), la misma fuente para todos los plazos, con su historia diaria para los cambios.
// Si CNBC no responde, la página vuelve a Yahoo y a la curva oficial.
const CNBC_UST = { "3M": "US3M", "1Y": "US1Y", "2Y": "US2Y", "5Y": "US5Y", "10Y": "US10Y", "30Y": "US30Y" };
const CNBC_HDR = { "User-Agent": UA, "Accept": "application/json" };
async function cnbcUstQuotes() {
  return cached("cnbc:ust", 45 * 1000, async () => {
    const syms = Object.values(CNBC_UST).join("%7C");
    const j = await getJSON(`https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${syms}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`, { headers: CNBC_HDR, timeout: 8000 });
    const num = v => parseFloat(String(v ?? "").replace("%", ""));
    const out = {};
    for (const r of j?.FormattedQuoteResult?.FormattedQuote || []) {
      const k = Object.keys(CNBC_UST).find(x => CNBC_UST[x] === r.symbol);
      const last = num(r.last), prev = num(r.previous_day_closing), t = Date.parse(r.last_time);
      if (k && isFinite(last) && last > 0 && last < 25) out[k] = { last, prev: isFinite(prev) ? prev : null, time: isFinite(t) ? Math.floor(t / 1000) : null };
    }
    return out;
  }, d => Object.keys(d).length > 0).catch(() => ({}));
}
async function cnbcUstHist(sym) {
  return cached(`cnbc:hist:${sym}`, 3 * 3600 * 1000, async () => {
    const j = await getJSON(`https://ts-api.cnbc.com/harmony/app/charts/1Y.json?symbol=${sym}`, { headers: CNBC_HDR, timeout: 9000 });
    return (j?.barData?.priceBars || []).map(b => [Math.floor(+b.tradeTimeinMills / 1000), +parseFloat(b.close).toFixed(3)])
      .filter(x => isFinite(x[0]) && isFinite(x[1]) && x[1] > 0).sort((a, b) => a[0] - b[0]);
  }, a => a.length > 20).catch(() => []);
}
async function cnbcUst() {
  const q = await cnbcUstQuotes();
  const keys = Object.keys(q);
  const hist = await Promise.all(keys.map(k => cnbcUstHist(CNBC_UST[k])));
  const out = {};
  keys.forEach((k, i) => { out[k] = { ...q[k], hist: hist[i] }; });
  return out;
}

app.get("/api/ust", async (req, res) => {
  try {
    const live = cnbcUst();
    const payload = await cached("ust", 5 * 60 * 1000, async () => {
      const y = new Date().getUTCFullYear();
      const [a, b, hist] = await Promise.all([treasuryYear(y - 1), treasuryYear(y), series(["^IRX", "^FVX", "^TNX", "^TYX"], "1y", "1d")]);
      const cmt = [...a, ...b].sort((p, q) => p.date.localeCompare(q.date));
      const yahoo = {};
      for (const [sym, r] of Object.entries(hist || {})) {
        const ts = r.timestamp || [], cl = r.indicators?.quote?.[0]?.close || [];
        yahoo[sym] = ts.map((t, i) => [t, cl[i]]).filter(x => x[1] != null).map(([t, c]) => [t, +c.toFixed(3)]);
      }
      return { cmt, yahoo };
    }, d => d.cmt.length > 0 || Object.keys(d.yahoo).length > 0);
    res.json({ ...payload, live: await live, liveSrc: "CNBC (Tradeweb)" });
  } catch (e) {
    console.error("ust:", e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/pebg", async (req, res) => {
  const sym = (req.query.symbol || "").toUpperCase().trim();
  if (!sym) return res.status(400).json({ error: "symbol required" });
  try {
    // años de precios: P/E Hist usa 30. El P/E arranca cuando hay 4 trimestres de EPS (la SEC tiene XBRL desde
    // 2007-2008); los precios anteriores se ven solos en la vista de precio. Cartera pide 2
    const years = Math.min(30, Math.max(1, parseInt(req.query.years, 10) || 30));
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
        // trimestres que EDGAR no tiene: primero los de Yahoo que usa el proceso de múltiplos (contables);
        // Finnhub (ajustado) solo si todavía falta: sin 10-Q (20-F) o con el último trimestre viejo (>110 días)
        const yf = edgar.length ? (await yahooFill(sym)).filter(e => !edgar.some(x => Math.abs(x.date - e.date) <= 10 * 86400)) : [];
        const sec = [...edgar, ...yf].sort((a, b) => a.date - b.date);
        const edgarStale = !sec.length || (Date.now() / 1000 - sec[sec.length - 1].date) > 110 * 86400;
        const fh = (sec.length < 4 || edgarStale) ? await finnhubEPS(sym) : [];
        if (sec.length >= 4) {
          const have = new Set(sec.map(e => toQKey(e.date)));
          const gaps = fh.filter(e => !have.has(toQKey(e.date)) && e.date > sec[sec.length - 1].date);
          eps = [...sec, ...gaps].sort((a, b) => a.date - b.date);
          source = "edgar" + (yf.length ? "+yahoo" : "") + (gaps.length ? "+finnhub" : "");
        } else {
          eps = fh.length ? fh : sec;
          source = fh.length ? "finnhub" : (sec.length ? "edgar" : "none");
        }
        // Normalizado: el operativo de EDGAR; para los que presentan 20-F, el ajustado de Finnhub (es lo único que hay)
        epsNorm = edgarAll.norm; normMethod = epsNorm.length >= 4 ? edgarAll.normMethod : null;
        if (!normMethod && source === "finnhub") { epsNorm = fh; normMethod = "ajustado"; }
      }
      // historia anterior a XBRL (10-K originales) para los que la tenemos cargada
      let histNote = null;
      if (!manual && EPS_HIST[sym] && eps.length) {
        const pre = histBefore(sym, eps[0].date, splits);
        if (pre.length) {
          eps = [...pre, ...eps];
          if (epsNorm && epsNorm.length) epsNorm = [...histBefore(sym, epsNorm[0].date, splits), ...epsNorm];
          source += "+10k";
          const d = new Date(pre[pre.length - 1].date * 1000);
          histNote = `Hasta ${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}: EPS de los 10-K originales de la SEC (contable, también en el modo normalizado)`;
        }
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
        // extraordinarios sacados del normalizado (trimestre, partida, millones de US$ antes de impuestos, efecto por acción)
        normAdj: normMethod && !manual ? (edgarAll.normAdj || []) : [],
        normFlags: normMethod && !manual ? (edgarAll.normFlags || []) : [],
        // flujo de caja de 12 meses y último balance (millones de US$), para P/FCF, EV/EBIT y deuda neta / EBITDA
        cajaDeuda: manual ? null : (edgarAll.cd || null),
        // calidad: ventas, EBIT ajustado, NOPAT, capital invertido y acciones, hoy y hace un año (millones)
        calidad: manual ? null : (edgarAll.q || null),
        // ventas trimestrales de la SEC (millones de US$), para comparar con las esperadas
        ventas: manual ? [] : (edgarAll.ventas || []),
        histNote,
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
