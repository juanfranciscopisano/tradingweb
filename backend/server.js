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

app.get("/debug", (req, res) => res.json({
  finnhub: process.env.FINNHUB_KEY ? "set (len=" + process.env.FINNHUB_KEY.length + ")" : "missing",
  crumb: yfCrumb.length > 3 ? "ready" : "missing"
}));

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

    const FINNHUB_KEY = process.env.FINNHUB_KEY || "";

    const [priceData, fhData, summaryData] = await Promise.all([
      yfFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3y`),
      FINNHUB_KEY
        ? fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${sym}&limit=40&token=${FINNHUB_KEY}`).then(r => r.json()).catch(() => null)
        : Promise.resolve(null),
      yfFetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=defaultKeyStatistics,financialData,price,earningsHistory`).catch(() => null)
    ]);

    const chart = priceData.chart?.result?.[0];
    if(!chart) throw new Error("No price data for " + sym);
    const timestamps = chart.timestamp || [];
    const closes = chart.indicators?.quote?.[0]?.close || [];
    const prices = timestamps.map((t,i) => ({ date: t, close: closes[i] })).filter(p => p.close != null);

    // Finnhub quarterly EPS — full history, sorted oldest first
    let eps = [];
    if(Array.isArray(fhData) && fhData.length > 0) {
      eps = fhData
        .filter(e => e.actual != null && e.period)
        .map(e => ({
          date: Math.floor(new Date(e.period).getTime() / 1000),
          eps: e.actual
        }))
        .sort((a,b) => a.date - b.date);
      console.log(`pebg ${sym}: Finnhub returned ${eps.length} EPS quarters`);
    } else {
      console.log(`pebg ${sym}: Finnhub data invalid:`, JSON.stringify(fhData)?.slice(0,100));
    }

    // Fallback: earningsHistory from Yahoo (last 4 quarters)
    if(eps.length < 4) {
      const result = summaryData?.quoteSummary?.result?.[0];
      const hist = result?.earningsHistory?.history || [];
      const fbEps = hist
        .filter(e => e.epsActual?.raw != null)
        .map(e => ({ date: e.quarter?.raw || 0, eps: e.epsActual.raw }))
        .sort((a,b) => a.date - b.date);
      if(fbEps.length > eps.length) {
        eps = fbEps;
        console.log(`pebg ${sym}: fallback to earningsHistory, ${eps.length} quarters`);
      }
    }

    const result = summaryData?.quoteSummary?.result?.[0];
    const priceInfo = result?.price || {};
    const keyStats = result?.defaultKeyStatistics || {};
    const finData = result?.financialData || {};
    const meta = chart.meta || {};

    console.log(`pebg ${sym}: ${prices.length} prices, ${eps.length} EPS quarters`);

    res.json({
      symbol: sym,
      shortName: priceInfo.shortName || meta.longName || sym,
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
