
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// v8/finance/chart works without crumb from cloud IPs
async function yfChart(symbol, interval = "1d", range = "1y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=false`;
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`Yahoo ${r.status} for ${symbol}`);
  return r.json();
}

// Batch quotes via v7 — try without crumb first, works sometimes
async function yfQuote(symbols) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&lang=en-US&region=US`;
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json", "Referer": "https://finance.yahoo.com/" } });
  if (!r.ok) throw new Error(`Yahoo quote ${r.status}`);
  return r.json();
}

app.get("/", (req, res) => res.json({ status: "ok", mode: "no-crumb" }));

// Quote — used by screener (bulk) and compare price bar
app.get("/api/quote", async (req, res) => {
  try {
    const data = await yfQuote(req.query.symbols);
    res.json(data);
  } catch(e) {
    // Fallback: fetch each symbol via v8/chart and extract last quote
    try {
      const syms = (req.query.symbols || "").split(",").filter(Boolean);
      const results = await Promise.allSettled(syms.map(s => yfChart(s, "1d", "5d")));
      const quotes = results.map((r, i) => {
        if (r.status !== "fulfilled") return null;
        const c = r.value.chart?.result?.[0];
        if (!c) return null;
        const meta = c.meta || {};
        const closes = c.indicators?.quote?.[0]?.close || [];
        const validCloses = closes.filter(x => x != null);
        const prev = validCloses[validCloses.length - 2];
        const curr = meta.regularMarketPrice || validCloses[validCloses.length - 1];
        const chgPct = prev && curr ? (curr - prev) / prev * 100 : null;
        return {
          symbol: syms[i],
          shortName: meta.longName || meta.shortName || syms[i],
          regularMarketPrice: curr,
          regularMarketChangePercent: chgPct,
          marketCap: meta.marketCap,
          trailingPE: meta.trailingPE,
          sector: null,
        };
      }).filter(Boolean);
      res.json({ quoteResponse: { result: quotes } });
    } catch(e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// Spark — historical closes for return calculations (screener)
app.get("/api/spark", async (req, res) => {
  try {
    const syms = (req.query.symbols || "").split(",").filter(Boolean).slice(0, 20);
    const results = await Promise.allSettled(syms.map(s => yfChart(s, "1d", "1y")));
    const spark = { spark: { result: [] } };
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      const c = r.value.chart?.result?.[0];
      if (!c) return;
      spark.spark.result.push({
        symbol: syms[i],
        response: [{ timestamp: c.timestamp, indicators: c.indicators }]
      });
    });
    res.json(spark);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Overview — indices, futures, commodities, treasuries, news
app.get("/api/overview", async (req, res) => {
  try {
    const OV_SYMS = [
      "^GSPC","^IXIC","^DJI","^RUT","ES=F","NQ=F","YM=F","RTY=F","^VIX",
      "^STOXX50E","^GDAXI","^FTSE","^N225","^HSI","^MERV",
      "GC=F","CL=F","BZ=F","SI=F","HG=F","NG=F",
      "^IRX","^FVX","^TNX","^TYX"
    ];

    const MONTH_CODES = ["F","G","H","J","K","M","N","Q","U","V","X","Z"];
    const now = new Date();
    const zqTickers = [];
    for(let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      zqTickers.push(`ZQ${MONTH_CODES[d.getMonth()]}${String(d.getFullYear()).slice(-2)}.CBT`);
    }

    const allSyms = [...OV_SYMS, ...zqTickers];

    // Fetch all via v8/chart (no crumb needed)
    const results = await Promise.allSettled(allSyms.map(s => yfChart(s, "1d", "5d")));
    const quotes = [];
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      const c = r.value.chart?.result?.[0];
      if (!c) return;
      const meta = c.meta || {};
      const closes = c.indicators?.quote?.[0]?.close || [];
      const valid = closes.filter(x => x != null);
      const curr = meta.regularMarketPrice || valid[valid.length-1];
      const prev = meta.previousClose || meta.chartPreviousClose || valid[valid.length-2];
      const chg = curr && prev ? curr - prev : null;
      const chgPct = curr && prev ? (curr-prev)/prev*100 : null;
      quotes.push({
        symbol: allSyms[i],
        shortName: meta.longName || meta.shortName || allSyms[i],
        regularMarketPrice: curr,
        regularMarketChange: chg,
        regularMarketChangePercent: chgPct,
      });
    });

    // EFFR from FRED
    let effr = null;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 4000);
      const fr = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=EFFR",
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
      const csv = await fr.text();
      const lines = csv.trim().split("\n").filter(l => !l.startsWith("DATE"));
      const last = lines[lines.length-1]?.split(",");
      if(last && last[1] && last[1] !== ".") effr = parseFloat(last[1]);
    } catch(e) {}

    // News via search (try without crumb)
    let news = [];
    try {
      const nr = await fetch(
        "https://query1.finance.yahoo.com/v1/finance/search?q=markets+fed+economy&newsCount=10&lang=en-US&region=US",
        { headers: { "User-Agent": UA, "Referer": "https://finance.yahoo.com/" } }
      );
      const nd = await nr.json();
      news = nd.news || [];
    } catch(e) {}

    res.json({ quotes, news, zqTickers, effr });
  } catch(e) {
    console.error("overview:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// PEBG — price history + quarterly EPS
app.get("/api/pebg", async (req, res) => {
  try {
    const sym = (req.query.symbol || "").toUpperCase().trim();
    if(!sym) return res.status(400).json({ error: "symbol required" });

    const now = Math.floor(Date.now()/1000);
    const from = now - 10*365*86400;

    const [priceRes, epsRes, summaryRes] = await Promise.allSettled([
      yfChart(sym, "1d", "3y"),
      fetch(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${sym}?type=quarterlyEpsActual&period1=${from}&period2=${now}`,
        { headers: { "User-Agent": UA } }).then(r => r.json()),
      fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=defaultKeyStatistics,financialData,price`,
        { headers: { "User-Agent": UA } }).then(r => r.json())
    ]);

    const priceData = priceRes.status === "fulfilled" ? priceRes.value : null;
    if(!priceData) throw new Error("No price data");

    const chart = priceData.chart?.result?.[0];
    const timestamps = chart?.timestamp || [];
    const closes = chart?.indicators?.quote?.[0]?.close || [];
    const prices = timestamps.map((t,i) => ({ date: t, close: closes[i] })).filter(p => p.close != null);

    // EPS from timeseries
    let eps = [];
    if(epsRes.status === "fulfilled") {
      const tsResult = epsRes.value?.timeseries?.result?.[0];
      const epsRaw = tsResult?.quarterlyEpsActual || [];
      eps = epsRaw
        .filter(e => e?.reportedValue?.raw != null)
        .map(e => ({ date: Math.floor(new Date(e.asOfDate).getTime()/1000), eps: e.reportedValue.raw }))
        .sort((a,b) => a.date - b.date);
    }

    // Fallback EPS from earningsHistory
    if(eps.length < 2 && summaryRes.status === "fulfilled") {
      const hist = summaryRes.value?.quoteSummary?.result?.[0]?.earningsHistory?.history || [];
      eps = hist
        .filter(e => e.epsActual?.raw != null)
        .map(e => ({ date: e.quarter?.raw || 0, eps: e.epsActual.raw }))
        .sort((a,b) => a.date - b.date);
    }

    const result = summaryRes.status === "fulfilled" ? summaryRes.value?.quoteSummary?.result?.[0] : null;
    const priceInfo = result?.price || {};
    const keyStats = result?.defaultKeyStatistics || {};
    const finData = result?.financialData || {};
    const meta = chart?.meta || {};

    res.json({
      symbol: sym,
      shortName: priceInfo.shortName || meta.longName || sym,
      prices, eps,
      currentPrice: priceInfo.regularMarketPrice?.raw || meta.regularMarketPrice,
      currentPE: keyStats.trailingPE?.raw,
      epsTrailingTwelveMonths: finData.epsTrailingTwelveMonths?.raw,
      epsCount: eps.length
    });
  } catch(e) {
    console.error("pebg:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log("Server on port", PORT));
