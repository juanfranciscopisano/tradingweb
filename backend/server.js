
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

let yfCookie = "";
let yfCrumb  = "";

// Multiple strategies to get a valid crumb
async function refreshCrumb() {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

  // Strategy 1: scrape crumb from Yahoo Finance HTML
  try {
    const r = await fetch("https://finance.yahoo.com/", {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    const html = await r.text();
    yfCookie = (r.headers.get("set-cookie") || "").split(",").map(c => c.split(";")[0]).join("; ");
    const m = html.match(/"crumb"\s*:\s*"([^"]{5,20})"/);
    if (m) {
      yfCrumb = m[1].replace(/\\u002F/g, "/");
      console.log("Crumb S1 OK:", yfCrumb.slice(0, 10));
      return true;
    }
  } catch(e) { console.log("S1 failed:", e.message); }

  // Strategy 2: v8 chart endpoint (sometimes returns crumb in response)
  try {
    await new Promise(r => setTimeout(r, 2000));
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d", {
      headers: { "User-Agent": UA, "Cookie": yfCookie },
    });
    const setCookie = r.headers.get("set-cookie") || "";
    if (setCookie) yfCookie = setCookie.split(",").map(c => c.split(";")[0]).join("; ");
    // Now try crumb endpoint
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, "Cookie": yfCookie },
    });
    const text = (await r2.text()).trim();
    if (text && text.length <= 20 && !text.includes(" ") && !text.includes("<") && !text.toLowerCase().includes("too")) {
      yfCrumb = text;
      console.log("Crumb S2 OK:", yfCrumb.slice(0, 10));
      return true;
    }
    console.log("S2 crumb bad:", text.slice(0, 30));
  } catch(e) { console.log("S2 failed:", e.message); }

  // Strategy 3: query2 (different rate limit pool)
  try {
    await new Promise(r => setTimeout(r, 3000));
    const r = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, "Cookie": yfCookie },
    });
    const text = (await r.text()).trim();
    if (text && text.length <= 20 && !text.includes(" ") && !text.includes("<") && !text.toLowerCase().includes("too")) {
      yfCrumb = text;
      console.log("Crumb S3 OK:", yfCrumb.slice(0, 10));
      return true;
    }
  } catch(e) { console.log("S3 failed:", e.message); }

  console.error("All crumb strategies failed");
  return false;
}

function yh() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finance.yahoo.com/",
    "Cookie": yfCookie,
  };
}

async function yf(url) {
  // Try with crumb first
  if (yfCrumb) {
    const u = url + (url.includes("?") ? "&" : "?") + `crumb=${encodeURIComponent(yfCrumb)}`;
    const r = await fetch(u, { headers: yh() });
    if (r.status === 401 || r.status === 403) {
      await refreshCrumb();
      const r2 = await fetch(url + (url.includes("?") ? "&" : "?") + `crumb=${encodeURIComponent(yfCrumb)}`, { headers: yh() });
      if (!r2.ok) throw new Error(`Yahoo ${r2.status}`);
      return r2.json();
    }
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    return r.json();
  }
  // Try without crumb (works for some endpoints)
  const r = await fetch(url, { headers: yh() });
  if (!r.ok) throw new Error(`Yahoo ${r.status} (no crumb)`);
  return r.json();
}

app.get("/", (req, res) => res.json({ status: "ok", crumb: yfCrumb.length > 3 ? "ready" : "missing", crumbPreview: yfCrumb.slice(0,5) }));

app.get("/api/quote", async (req, res) => {
  try {
    const data = await yf(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${req.query.symbols}&lang=en-US&region=US`);
    res.json(data);
  } catch (e) {
    console.error("quote:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/spark", async (req, res) => {
  try {
    const data = await yf(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${req.query.symbols}&range=1y&interval=1d`);
    res.json(data);
  } catch (e) {
    console.error("spark:", e.message);
    res.status(500).json({ error: e.message });
  }
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
      '^GSPC','^IXIC','^DJI','^RUT',
      'ES=F','NQ=F','YM=F','RTY=F','^VIX',
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
        const last = lines[lines.length - 1]?.split(',');
        return (last && last[1] && last[1] !== '.') ? parseFloat(last[1]) : null;
      } catch(e) { return null; }
    };

    const [quotesData, newsData, effr] = await Promise.all([
      yf(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&lang=en-US&region=US`),
      yf(`https://query1.finance.yahoo.com/v1/finance/search?q=markets+fed+economy&newsCount=10&lang=en-US&region=US&enableFuzzyQuery=false`).catch(() => ({ news: [] })),
      fetchEffr()
    ]);

    res.json({
      quotes: quotesData.quoteResponse?.result || [],
      news: newsData.news || [],
      zqTickers,
      effr
    });
  } catch (e) {
    console.error("overview:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, async () => {
  console.log("Server on port", PORT);
  let ok = false;
  for(let i = 0; i < 8; i++) {
    ok = await refreshCrumb();
    if(ok) break;
    const wait = Math.min((i + 1) * 5000, 30000);
    console.log(`Crumb attempt ${i+1} failed, waiting ${wait/1000}s...`);
    await new Promise(r => setTimeout(r, wait));
  }
  if(!ok) console.error("WARNING: Starting without crumb — requests will fail until refresh");
  // Refresh every 25 minutes
  setInterval(async () => {
    const ok = await refreshCrumb();
    if(!ok) setTimeout(refreshCrumb, 10000);
  }, 25 * 60 * 1000);
});
