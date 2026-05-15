
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
let yfCookie = "";
let yfCrumb  = "";

async function refreshCrumb() {
  try {
    const r1 = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA }, redirect: "follow"
    });
    yfCookie = (r1.headers.get("set-cookie") || "").split(",").map(c => c.split(";")[0]).join("; ");
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, "Cookie": yfCookie }
    });
    const text = await r2.text();
    if(text.length > 20 || text.includes(" ") || text.includes("<")) {
      console.error("Bad crumb:", text.slice(0,30));
      yfCrumb = "";
      return false;
    }
    yfCrumb = text;
    console.log("Crumb OK:", yfCrumb.slice(0,10));
    return true;
  } catch(e) {
    console.error("refreshCrumb:", e.message);
    return false;
  }
}

function yh() {
  return {
    "User-Agent": UA,
    "Accept": "application/json",
    "Referer": "https://finance.yahoo.com/",
    "Cookie": yfCookie,
  };
}

async function yf(url) {
  const u = url + (url.includes("?") ? "&" : "?") + `crumb=${encodeURIComponent(yfCrumb)}`;
  let r = await fetch(u, { headers: yh() });
  if(r.status === 401 || r.status === 403) {
    await refreshCrumb();
    r = await fetch(url + (url.includes("?") ? "&" : "?") + `crumb=${encodeURIComponent(yfCrumb)}`, { headers: yh() });
  }
  if(!r.ok) throw new Error(`Yahoo ${r.status}`);
  return r.json();
}

app.get("/", (req, res) => res.json({ status: "ok", crumb: yfCrumb.length > 3 ? "ready" : "missing" }));

app.get("/api/quote", async (req, res) => {
  try {
    const data = await yf(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${req.query.symbols}&lang=en-US&region=US`);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/spark", async (req, res) => {
  try {
    const data = await yf(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${req.query.symbols}&range=1y&interval=1d`);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/overview", async (req, res) => {
  try {
    const MONTH_CODES = ["F","G","H","J","K","M","N","Q","U","V","X","Z"];
    const now = new Date();
    const zqTickers = [];
    for(let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      zqTickers.push(`ZQ${MONTH_CODES[d.getMonth()]}${String(d.getFullYear()).slice(-2)}.CBT`);
    }
    const symbols = [
      "^GSPC","^IXIC","^DJI","^RUT","ES=F","NQ=F","YM=F","RTY=F","^VIX",
      "^STOXX50E","^GDAXI","^FTSE","^N225","^HSI","^MERV",
      "GC=F","CL=F","BZ=F","SI=F","HG=F","NG=F",
      "^IRX","^FVX","^TNX","^TYX",
      ...zqTickers
    ].join(",");

    const fetchEffr = async () => {
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=EFFR",
          { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
        const csv = await r.text();
        const lines = csv.trim().split("\n").filter(l => !l.startsWith("DATE"));
        const last = lines[lines.length-1]?.split(",");
        return (last && last[1] && last[1] !== ".") ? parseFloat(last[1]) : null;
      } catch(e) { return null; }
    };

    const [quotesData, newsData, effr] = await Promise.all([
      yf(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&lang=en-US&region=US`),
      yf(`https://query1.finance.yahoo.com/v1/finance/search?q=markets+fed+economy&newsCount=10&lang=en-US&region=US&enableFuzzyQuery=false`).catch(() => ({ news: [] })),
      fetchEffr()
    ]);

    res.json({ quotes: quotesData.quoteResponse?.result || [], news: newsData.news || [], zqTickers, effr });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/pebg", async (req, res) => {
  try {
    const sym = (req.query.symbol || "").toUpperCase().trim();
    if(!sym) return res.status(400).json({ error: "symbol required" });

    const now = Math.floor(Date.now()/1000);
    const from = now - 10*365*86400;

    const [priceData, epsData, summaryData] = await Promise.all([
      yf(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3y`),
      yf(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${sym}?type=quarterlyEpsActual&period1=${from}&period2=${now}`),
      yf(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=defaultKeyStatistics,financialData,price`)
    ]);

    const chart = priceData.chart?.result?.[0];
    if(!chart) throw new Error("No price data");
    const timestamps = chart.timestamp || [];
    const closes = chart.indicators?.quote?.[0]?.close || [];
    const prices = timestamps.map((t,i) => ({ date: t, close: closes[i] })).filter(p => p.close != null);

    const tsResult = epsData?.timeseries?.result?.[0];
    let eps = (tsResult?.quarterlyEpsActual || [])
      .filter(e => e?.reportedValue?.raw != null)
      .map(e => ({ date: Math.floor(new Date(e.asOfDate).getTime()/1000), eps: e.reportedValue.raw }))
      .sort((a,b) => a.date - b.date);

    if(eps.length < 2) {
      const fb = await yf(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=earningsHistory`);
      const hist = fb?.quoteSummary?.result?.[0]?.earningsHistory?.history || [];
      eps = hist.filter(e => e.epsActual?.raw != null)
        .map(e => ({ date: e.quarter?.raw || 0, eps: e.epsActual.raw }))
        .sort((a,b) => a.date - b.date);
    }

    const result = summaryData.quoteSummary?.result?.[0];
    const priceInfo = result?.price || {};
    const keyStats = result?.defaultKeyStatistics || {};
    const finData = result?.financialData || {};

    res.json({
      symbol: sym, shortName: priceInfo.shortName || sym,
      prices, eps, epsCount: eps.length,
      currentPrice: priceInfo.regularMarketPrice?.raw,
      currentPE: keyStats.trailingPE?.raw,
      epsTrailingTwelveMonths: finData.epsTrailingTwelveMonths?.raw,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, async () => {
  console.log("Server on port", PORT);
  // Retry until crumb is obtained
  for(let i = 0; i < 10; i++) {
    const ok = await refreshCrumb();
    if(ok) break;
    console.log(`Retry ${i+1}/10 in 5s...`);
    await new Promise(r => setTimeout(r, 5000));
  }
  setInterval(refreshCrumb, 20 * 60 * 1000);
});
