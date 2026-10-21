// tradingweb1 — backend sin crumb de Yahoo.
// Precios y series: Yahoo v7/spark y v8/chart (no piden cookie ni crumb).
// EPS trimestral: SEC EDGAR (US GAAP) y Finnhub para los que presentan 20-F (NU, PAM...).
// P/E, fw P/E, P/B y market cap NO salen de acá: los baja una vez por día la GitHub Action
// del repo de Pages (scripts/fundamentals.mjs -> fundamentals.json).
import express from "express";
import nodeFetch from "node-fetch";
import cors from "cors";

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

// EPS diluido trimestral desde companyfacts. Q1-Q3 salen de los frames CY####Q#; el trimestre
// faltante se deriva como anual menos YTD (soporta cierres de ejercicio no calendario).
function quarterlyFromFacts(facts, symbol) {
  const epsData = facts?.facts?.["us-gaap"]?.EarningsPerShareDiluted?.units?.["USD/shares"] || [];
  const quarterly = {}, annualByYear = {}, ytdQ1ByYear = {}, ytdQ2ByYear = {}, ytdQ3ByYear = {};
  const ts = d => Math.floor(new Date(d).getTime() / 1000);

  epsData.forEach(e => {
    const endYear = String(new Date(e.end).getFullYear());
    if (!e.frame) {
      if (e.fp === "Q1" && e.form === "10-Q") {
        if (!ytdQ1ByYear[endYear] || Math.abs(e.val) > Math.abs(ytdQ1ByYear[endYear].val)) ytdQ1ByYear[endYear] = { date: ts(e.end), val: e.val, end: e.end };
      } else if (e.fp === "Q2" && e.form === "10-Q") {
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
    .filter(e => !isNaN(e.eps))
    .sort((a, b) => a.date - b.date)
    .filter((e, i, arr) => i === arr.findIndex(x => x.frame === e.frame));
  console.log(`pebg ${symbol}: EDGAR ${out.length} trimestres`);
  return out;
}

async function edgarEPS(sym) {
  return cached(`edgar:${sym}`, 12 * 3600 * 1000, async () => {
    try {
      const cik = await cikFor(sym);
      if (!cik) return [];
      const facts = await secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
      return quarterlyFromFacts(facts, sym);
    } catch (e) {
      console.log(`pebg ${sym}: EDGAR error ${e.message}`);
      return [];
    }
  }, a => a.length >= 4);
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

const SPARK_RANGES = ["5d", "1mo", "3mo", "6mo", "ytd", "1y", "2y"];
app.get("/api/spark", async (req, res) => {
  const syms = parseSyms(req.query.symbols);
  if (!syms.length) return res.status(400).json({ error: "symbols required" });
  const range = SPARK_RANGES.includes(req.query.range) ? req.query.range : "1y";
  try {
    const data = await cached(`spark:${range}:${syms.join(",")}`, 10 * 60 * 1000, async () => {
      const m = await series(syms, range, "1d");
      const result = syms.filter(s => m[s]).map(s => ({
        symbol: s,
        quote: quoteFrom(s, m[s]),
        response: [{ timestamp: m[s].timestamp || [], indicators: { quote: [{ close: m[s].indicators?.quote?.[0]?.close || [] }] } }],
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
  "^STOXX50E", "^GDAXI", "^FTSE", "^N225", "^HSI", "^MERV",
  "GC=F", "CL=F", "BZ=F", "SI=F", "HG=F", "NG=F",
  "^IRX", "^FVX", "^TNX", "^TYX",
];

app.get("/api/overview", async (req, res) => {
  try {
    const payload = await cached("overview", 60 * 1000, async () => {
      const zq = zqTickers();
      const syms = [...OV_SYMBOLS, ...zq];
      const [m, effr, lo, hi] = await Promise.all([
        series(syms, "5d", "1d"),
        fredLast("EFFR"),
        fredLast("DFEDTARL"),
        fredLast("DFEDTARU"),
      ]);
      return {
        quotes: syms.map(s => m[s] && quoteFrom(s, m[s])).filter(Boolean),
        zqTickers: zq,
        effr: effr?.value ?? null,
        effrDate: effr?.date ?? null,
        fedTarget: (lo && hi) ? { lo: lo.value, hi: hi.value, date: hi.date } : null,
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
    const payload = await cached(`pebg:${sym}`, 30 * 60 * 1000, async () => {
      const [chart, edgar] = await Promise.all([chartOne(sym, "3y", "1d"), edgarEPS(sym)]);
      if (!chart) throw new Error("Sin precios para " + sym);
      const ts = chart.timestamp || [];
      const closes = chart.indicators?.quote?.[0]?.close || [];
      const prices = ts.map((t, i) => ({ date: t, close: closes[i] })).filter(p => p.close != null);

      // EDGAR (GAAP) manda; Finnhub completa trimestres que EDGAR todavía no tiene o reemplaza si no hay 10-Q (20-F).
      const toQKey = t => { const d = new Date(t * 1000); return d.getUTCFullYear() + "Q" + (Math.floor(d.getUTCMonth() / 3) + 1); };
      let eps, source;
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
      const meta = chart.meta || {};
      const last4 = eps.slice(-4);
      return {
        symbol: sym,
        shortName: meta.shortName || meta.longName || sym,
        prices,
        eps: eps.map(e => ({ date: e.date, eps: e.eps })),
        epsCount: eps.length,
        epsSource: source,
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
    const cik = await cikFor(sym);
    if (!cik) return res.json({ error: "ticker not found" });
    const facts = await secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
    const epsData = facts?.facts?.["us-gaap"]?.EarningsPerShareDiluted?.units?.["USD/shares"] || [];
    const recent = epsData
      .filter(e => e.form === "10-Q" || e.form === "10-K")
      .sort((a, b) => a.end.localeCompare(b.end))
      .slice(-24)
      .map(e => ({ end: e.end, fp: e.fp, fy: e.fy, val: e.val, frame: e.frame || "", form: e.form }));
    res.json({ cik, sym, count: epsData.length, recent });
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
