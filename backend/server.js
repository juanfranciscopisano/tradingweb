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
    const ctrl1 = new AbortController();
    setTimeout(() => ctrl1.abort(), 8000);
    const r1 = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36" },
      redirect: "follow",
      signal: ctrl1.signal,
    });
    const cookies = r1.headers.get("set-cookie") || "";
    yfCookie = cookies.split(",").map(c => c.split(";")[0]).join("; ");

    const ctrl2 = new AbortController();
    setTimeout(() => ctrl2.abort(), 8000);
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
        "Cookie": yfCookie,
      },
      signal: ctrl2.signal,
    });
    yfCrumb = await r2.text();
    if(yfCrumb.length > 20 || yfCrumb.includes(" ") || yfCrumb.includes("<") || yfCrumb.includes("{")) {
      console.error("Bad crumb rejected:", yfCrumb.slice(0,30));
      yfCrumb = "";
      return false;
    }
    console.log("Crumb OK:", yfCrumb.slice(0,10), "| Cookie len:", yfCookie.length);
    return true;
  } catch (e) {
    console.error("refreshCrumb error:", e.message);
    return false;
  }
}

// Run crumb retry loop independently at top level
async function crumbLoop() {
  for(let i = 0; i < 8; i++) {
    if(i > 0) {
      const wait = i * 10000; // 10s, 20s, 30s...
      console.log(`Crumb retry ${i+1}/8 in ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
    const ok = await refreshCrumb();
    if(ok) { console.log("Crumb ready after attempt", i+1); return; }
  }
  console.error("Could not get crumb after 8 attempts");
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

    const [priceData, summaryData] = await Promise.all([
      yfFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3y&events=earnings`),
      yfFetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=defaultKeyStatistics,financialData,price`).catch(() => null)
    ]);

    const chart = priceData.chart?.result?.[0];
    if(!chart) throw new Error("No price data");
    const timestamps = chart.timestamp || [];
    const closes = chart.indicators?.quote?.[0]?.close || [];
    const prices = timestamps.map((t,i) => ({ date: t, close: closes[i] })).filter(p => p.close != null);

    // EPS from chart events (upcoming/recent only — usually no historical epsActual)
    let eps = [];
    const earningsEvents = chart.events?.earnings;
    if(earningsEvents) {
      const fromEvents = Object.values(earningsEvents)
        .filter(e => e.epsActual != null && !isNaN(e.epsActual))
        .map(e => ({ date: e.date, eps: e.epsActual }))
        .sort((a,b) => a.date - b.date);
      if(fromEvents.length) eps = fromEvents;
      console.log(`pebg ${sym}: events.earnings has ${Object.keys(earningsEvents).length} entries, ${fromEvents.length} with epsActual`);
    }

    // Primary: fundamentals-timeseries (full historical EPS) — try query2 without crumb
    if(eps.length < 8) {
      try {
        const tsUrl = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${sym}?type=quarterlyEpsActual&period1=${from}&period2=${now}&lang=en-US&region=US`;
        // Try without crumb first (this endpoint sometimes doesn't need it)
        const tsRaw = await fetch(tsUrl, { headers: yfHeaders() });
        console.log(`pebg ${sym}: fundamentals-timeseries status=${tsRaw.status}`);
        if(tsRaw.ok) {
          const tsData = await tsRaw.json();
          const tsResult = tsData?.timeseries?.result?.[0];
          const tsEps = (tsResult?.quarterlyEpsActual || [])
            .filter(e => e?.reportedValue?.raw != null)
            .map(e => ({ date: Math.floor(new Date(e.asOfDate).getTime()/1000), eps: e.reportedValue.raw }))
            .sort((a,b) => a.date - b.date);
          console.log(`pebg ${sym}: fundamentals-timeseries returned ${tsEps.length} EPS quarters`);
          if(tsEps.length > eps.length) eps = tsEps;
        } else {
          const errText = await tsRaw.text();
          console.log(`pebg ${sym}: fundamentals-timeseries error body:`, errText.slice(0,100));
        }
      } catch(e) { console.log(`pebg ${sym}: fundamentals-timeseries exception:`, e.message); }
    }

    // Fallback: earnings module (earningsChart.quarterly — typically 5-6 quarters)
    if(eps.length < 4) {
      try {
        const eData = await yfFetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=earnings,earningsHistory`);
        const qEps = eData?.quoteSummary?.result?.[0]?.earnings?.earningsChart?.quarterly || [];
        const fromEarnings = qEps
          .filter(e => e.actual?.raw != null)
          .map(e => {
            // date format: "1Q2024" -> parse
            const m = e.date?.match(/(\d)Q(\d{4})/);
            const qDate = m ? new Date(parseInt(m[2]), parseInt(m[1])*3, 1).getTime()/1000 : 0;
            return { date: qDate, eps: e.actual.raw };
          })
          .filter(e => e.date > 0)
          .sort((a,b) => a.date - b.date);
        // Also get earningsHistory
        const hist = eData?.quoteSummary?.result?.[0]?.earningsHistory?.history || [];
        const fromHist = hist.filter(e => e.epsActual?.raw != null)
          .map(e => ({ date: e.quarter?.raw || 0, eps: e.epsActual.raw }))
          .sort((a,b) => a.date - b.date);
        // Merge, deduplicate by closest date
        const merged = [...fromEarnings, ...fromHist]
          .sort((a,b) => a.date - b.date)
          .filter((e,i,arr) => i===0 || Math.abs(e.date - arr[i-1].date) > 30*86400);
        console.log(`pebg ${sym}: earnings module=${fromEarnings.length}, earningsHistory=${fromHist.length}, merged=${merged.length}`);
        if(merged.length > eps.length) eps = merged;
      } catch(e) { console.log(`pebg ${sym}: earnings fallback exception:`, e.message); }
    }

    const result = summaryData?.quoteSummary?.result?.[0];
    const priceInfo = result?.price || {};
    const keyStats = result?.defaultKeyStatistics || {};
    const finData = result?.financialData || {};
    const meta = chart.meta || {};
    console.log(`pebg ${sym}: ${prices.length} prices, ${eps.length} EPS quarters`);

    res.json({
      symbol: sym, shortName: priceInfo.shortName || meta.longName || sym,
      prices, eps, epsCount: eps.length,
      currentPrice: priceInfo.regularMarketPrice?.raw || meta.regularMarketPrice,
      currentPE: keyStats.trailingPE?.raw,
      epsTrailingTwelveMonths: finData.epsTrailingTwelveMonths?.raw,
    });
  } catch(e) {
    console.error("pebg:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  crumbLoop(); // runs independently, doesn't block server startup
  setInterval(refreshCrumb, 30 * 60 * 1000);
});
