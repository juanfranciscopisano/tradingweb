
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

let yfCookie = "";
let yfCrumb  = "";

async function refreshCrumb() {
  try {
    const r1 = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36" },
      redirect: "follow",
    });
    const cookies = r1.headers.get("set-cookie") || "";
    yfCookie = cookies.split(",").map(c => c.split(";")[0]).join("; ");

    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
        "Cookie": yfCookie,
      },
    });
    yfCrumb = await r2.text();
    console.log("Crumb OK:", yfCrumb, "| Cookie len:", yfCookie.length);
    return yfCrumb.length > 3;
  } catch (e) {
    console.error("refreshCrumb error:", e.message);
    return false;
  }
}

function yfHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finance.yahoo.com/",
    "Cookie": yfCookie,
  };
}

async function yfFetch(url) {
  const sep = url.includes("?") ? "&" : "?";
  const fullUrl = `${url}${sep}crumb=${encodeURIComponent(yfCrumb)}`;
  let res = await fetch(fullUrl, { headers: yfHeaders() });
  if (res.status === 401 || res.status === 403) {
    console.log("Auth error, refreshing crumb...");
    await refreshCrumb();
    res = await fetch(`${url}${sep}crumb=${encodeURIComponent(yfCrumb)}`, { headers: yfHeaders() });
  }
  if (!res.ok) throw new Error(`Yahoo returned ${res.status}`);
  return res.json();
}

app.get("/", (req, res) => res.json({ status: "ok", crumb: yfCrumb.length > 3 ? "ready" : "missing" }));

app.get("/api/quote", async (req, res) => {
  try {
    const { symbols } = req.query;
    const data = await yfFetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&lang=en-US&region=US`);
    res.json(data);
  } catch (err) {
    console.error("Quote error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/spark", async (req, res) => {
  try {
    const { symbols } = req.query;
    const data = await yfFetch(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=1y&interval=1d`);
    res.json(data);
  } catch (err) {
    console.error("Spark error:", err.message);
    res.status(500).json({ error: err.message });
  }
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
      yfFetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&lang=en-US&region=US`),
      yfFetch(`https://query1.finance.yahoo.com/v1/finance/search?q=markets+fed+economy&newsCount=10&lang=en-US&region=US&enableFuzzyQuery=false`).catch(() => ({ news: [] })),
      fetchEffr()
    ]);

    res.json({ quotes: quotesData.quoteResponse?.result || [], news: newsData.news || [], zqTickers, effr });
  } catch(e) {
    console.error("overview:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/pebg", async (req, res) => {
  try {
    const sym = (req.query.symbol || "").toUpperCase().trim();
    if(!sym) return res.status(400).json({ error: "symbol required" });

    const now = Math.floor(Date.now()/1000);
    const from = now - 10*365*86400;

    const [priceData, epsData, summaryData] = await Promise.all([
      yfFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3y`),
      yfFetch(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${sym}?type=quarterlyEpsActual&period1=${from}&period2=${now}`),
      yfFetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=defaultKeyStatistics,financialData,price`)
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
      const fb = await yfFetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=earningsHistory`);
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
  } catch(e) {
    console.error("pebg:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, async () => {
  console.log("Server running on port", PORT);
  await refreshCrumb();
  setInterval(refreshCrumb, 30 * 60 * 1000);
});
