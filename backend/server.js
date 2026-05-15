
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
let yfCookie = "";
let yfCrumb  = "";
let crumbFetching = false;

async function refreshCrumb() {
  if(crumbFetching) return yfCrumb.length > 3;
  crumbFetching = true;
  try {
    const r1 = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA }, redirect: "follow"
    });
    yfCookie = (r1.headers.get("set-cookie") || "").split(",").map(c => c.split(";")[0]).join("; ");

    await new Promise(r => setTimeout(r, 2000));

    for(const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
      const r2 = await fetch(`https://${host}/v1/test/getcrumb`, {
        headers: { "User-Agent": UA, "Cookie": yfCookie }
      });
      const t = (await r2.text()).trim();
      const valid = t.length >= 3 && t.length <= 20
        && !t.includes(" ") && !t.includes("<")
        && !t.toLowerCase().includes("too")
        && !t.toLowerCase().includes("error");
      if(valid) {
        yfCrumb = t;
        console.log("Crumb OK:", yfCrumb.slice(0,8));
        crumbFetching = false;
        return true;
      }
      console.log(`Bad crumb (${host}):`, t.slice(0,30));
      await new Promise(r => setTimeout(r, 2000));
    }
    crumbFetching = false;
    return false;
  } catch(e) {
    console.error("refreshCrumb:", e.message);
    crumbFetching = false;
    return false;
  }
}

function headers() {
  return { "User-Agent": UA, "Accept": "application/json", "Referer": "https://finance.yahoo.com/", "Cookie": yfCookie };
}

async function yf(url) {
  // Try with crumb first
  if(yfCrumb) {
    const u = url + (url.includes("?") ? "&" : "?") + `crumb=${encodeURIComponent(yfCrumb)}`;
    const r = await fetch(u, { headers: headers() });
    if(r.ok) return r.json();
    if(r.status === 401 || r.status === 403) {
      console.log("Crumb rejected, refreshing...");
      await refreshCrumb();
    }
  }
  // Try without crumb (works on some endpoints)
  const r = await fetch(url, { headers: headers() });
  if(r.ok) return r.json();
  // Last resort: with fresh crumb
  if(yfCrumb) {
    const u = url + (url.includes("?") ? "&" : "?") + `crumb=${encodeURIComponent(yfCrumb)}`;
    const r2 = await fetch(u, { headers: headers() });
    if(!r2.ok) throw new Error(`Yahoo ${r2.status}`);
    return r2.json();
  }
  throw new Error(`Yahoo ${r.status}`);
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
    const MONTH_CODES = ['F','G','H','J','K','M','N','Q','U','V','X','Z'];
    const now = new Date();
    const zqTickers = [];
    for(let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      zqTickers.push(`ZQ${MONTH_CODES[d.getMonth()]}${String(d.getFullYear()).slice(-2)}.CBT`);
    }
    const symbols = [
      '^GSPC','^IXIC','^DJI','^RUT','ES=F','NQ=F','YM=F','RTY=F','^VIX',
      '^STOXX50E','^GDAXI','^FTSE','^N225','^HSI','^MERV',
      'GC=F','CL=F','BZ=F','SI=F','HG=F','NG=F',
      '^IRX','^FVX','^TNX','^TYX',
      ...zqTickers
    ].join(',');

    const fetchEffr = async () => {
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=EFFR',
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
        const csv = await r.text();
        const lines = csv.trim().split('\n').filter(l => !l.startsWith('DATE'));
        const last = lines[lines.length-1]?.split(',');
        return (last && last[1] && last[1] !== '.') ? parseFloat(last[1]) : null;
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
    const sym = (req.query.symbol || '').toUpperCase().trim();
    if(!sym) return res.status(400).json({ error: 'symbol required' });

    const now = Math.floor(Date.now()/1000);
    const from = now - 10*365*86400; // 10 years back for EPS history

    const [priceData, epsData, summaryData] = await Promise.all([
      yf(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3y`),
      // fundamentals-timeseries: full historical quarterly EPS
      yf(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${sym}?type=quarterlyEpsActual&period1=${from}&period2=${now}`),
      yf(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=defaultKeyStatistics,financialData,price`)
    ]);

    // Prices
    const chart = priceData.chart?.result?.[0];
    if(!chart) throw new Error('No price data');
    const timestamps = chart.timestamp || [];
    const closes = chart.indicators?.quote?.[0]?.close || [];
    const prices = timestamps.map((t,i) => ({ date: t, close: closes[i] })).filter(p => p.close != null);

    // Historical quarterly EPS from timeseries
    const tsResult = epsData?.timeseries?.result?.[0];
    const epsRaw = tsResult?.quarterlyEpsActual || [];
    let eps = epsRaw
      .filter(e => e?.reportedValue?.raw != null)
      .map(e => ({
        date: Math.floor(new Date(e.asOfDate).getTime()/1000),
        eps: e.reportedValue.raw
      }))
      .sort((a,b) => a.date - b.date);

    // Fallback: earningsHistory if timeseries empty
    if(eps.length < 2) {
      const sumFallback = await yf(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=earningsHistory`);
      const hist = sumFallback?.quoteSummary?.result?.[0]?.earningsHistory?.history || [];
      eps = hist
        .filter(e => e.epsActual?.raw != null)
        .map(e => ({ date: e.quarter?.raw || 0, eps: e.epsActual.raw }))
        .sort((a,b) => a.date - b.date);
    }

    const result = summaryData.quoteSummary?.result?.[0];
    const priceInfo = result?.price || {};
    const keyStats = result?.defaultKeyStatistics || {};
    const finData = result?.financialData || {};

    res.json({
      symbol: sym,
      shortName: priceInfo.shortName || sym,
      prices, eps,
      currentPrice: priceInfo.regularMarketPrice?.raw,
      currentPE: keyStats.trailingPE?.raw,
      forwardPE: keyStats.forwardPE?.raw,
      epsTrailingTwelveMonths: finData.epsTrailingTwelveMonths?.raw,
      epsCount: eps.length
    });
  } catch(e) {
    console.error("pebg:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, async () => {
  console.log("Server on port", PORT);

  // Background crumb loop — runs independently of request handling
  (async () => {
    const delays = [30, 60, 90, 120, 180, 240, 300, 300, 300, 300]; // seconds
    for(let i = 0; i < delays.length; i++) {
      await new Promise(r => setTimeout(r, delays[i] * 1000));
      console.log(`Crumb attempt ${i+1} (after ${delays[i]}s)...`);
      const ok = await refreshCrumb();
      if(ok) {
        console.log("Crumb obtained on attempt", i+1);
        break;
      }
    }
  })();

  // Refresh every 20 min once obtained
  setInterval(async () => {
    if(yfCrumb.length > 3) {
      const ok = await refreshCrumb();
      if(!ok) console.log("Scheduled refresh failed");
    }
  }, 20 * 60 * 1000);
});
