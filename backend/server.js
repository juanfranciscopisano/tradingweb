
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

let yfCookie = "";
let yfCrumb  = "";

async function refreshCrumb() {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
  try {
    // Fetch Yahoo Finance page and extract crumb from HTML (avoids rate-limiting on crumb endpoint)
    const r1 = await fetch("https://finance.yahoo.com/quote/AAPL/", {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
    });
    const html = await r1.text();
    yfCookie = (r1.headers.get("set-cookie") || "").split(",").map(c => c.split(";")[0]).join("; ");

    // Crumb is embedded in page JS as "crumb":"XXXXXXXXXXX"
    const m = html.match(/"crumb"\s*:\s*"([^"]{5,20})"/);
    if (m) {
      yfCrumb = m[1].replace(/\\u002F/g, "/");
      console.log("Crumb from HTML:", yfCrumb.slice(0, 10));
      return true;
    }

    // Fallback: dedicated endpoint with cookies
    await new Promise(r => setTimeout(r, 1500));
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, "Cookie": yfCookie },
    });
    const text = (await r2.text()).trim();
    if (text && text.length <= 20 && !text.includes(" ") && !text.includes("<")) {
      yfCrumb = text;
      console.log("Crumb from endpoint:", yfCrumb.slice(0, 10));
      return true;
    }
    console.error("Bad crumb:", text.slice(0, 40));
    return false;
  } catch (e) {
    console.error("refreshCrumb:", e.message);
    return false;
  }
}

function yh() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://finance.yahoo.com/",
    "Cookie": yfCookie,
  };
}

async function yf(url) {
  const u = url + (url.includes("?") ? "&" : "?") + `crumb=${encodeURIComponent(yfCrumb)}`;
  let r = await fetch(u, { headers: yh() });
  if (r.status === 401 || r.status === 403) {
    await refreshCrumb();
    r = await fetch(url + (url.includes("?") ? "&" : "?") + `crumb=${encodeURIComponent(yfCrumb)}`, { headers: yh() });
  }
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  return r.json();
}

app.get("/", (req, res) => res.json({ status: "ok", crumb: yfCrumb.length > 3 ? "ready" : "missing" }));

// Bulk quote
app.get("/api/quote", async (req, res) => {
  try {
    const data = await yf(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${req.query.symbols}&lang=en-US&region=US`
    );
    res.json(data);
  } catch (e) {
    console.error("quote:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Spark
app.get("/api/spark", async (req, res) => {
  try {
    const data = await yf(
      `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${req.query.symbols}&range=1y&interval=1d`
    );
    res.json(data);
  } catch (e) {
    console.error("spark:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Overview: indices, futures, commodities, treasuries, Fed futures, news
app.get("/api/overview", async (req, res) => {
  try {
    // Build ZQ tickers for next 6 months dynamically
    const MONTH_CODES = ['F','G','H','J','K','M','N','Q','U','V','X','Z'];
    const now = new Date();
    const zqTickers = [];
    for(let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const code = MONTH_CODES[d.getMonth()];
      const yr = String(d.getFullYear()).slice(-2);
      zqTickers.push(`ZQ${code}${yr}.CBT`);
    }

    const symbols = [
      '^GSPC','^IXIC','^DJI','^RUT',                // US real indices
      'ES=F','NQ=F','YM=F','RTY=F','^VIX',           // US futures + VIX
      '^STOXX50E','^GDAXI','^FTSE','^N225','^HSI','^MERV', // World
      'GC=F','CL=F','BZ=F','SI=F','HG=F','NG=F',     // Commodities
      '^IRX','^FVX','^TNX','^TYX',                   // Treasuries 13w/5y/10y/30y
      ...zqTickers                                    // Fed Funds futures
    ].join(',');

    // Fetch EFFR from FRED with 3s timeout - non-blocking
    const fetchEffr = async () => {
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(
          'https://fred.stlouisfed.org/graph/fredgraph.csv?id=EFFR',
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal }
        );
        const csv = await r.text();
        const lines = csv.trim().split('\n').filter(l => !l.startsWith('DATE'));
        const last = lines[lines.length - 1]?.split(',');
        return (last && last[1] && last[1] !== '.') ? parseFloat(last[1]) : null;
      } catch (e) {
        console.log('EFFR fetch failed:', e.message);
        return null;
      }
    };

    const [quotesData, newsData, effr] = await Promise.all([
      yf(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&lang=en-US&region=US`),
      yf(`https://query1.finance.yahoo.com/v1/finance/search?q=markets+fed+economy&newsCount=10&lang=en-US&region=US&enableFuzzyQuery=false`).catch(() => ({ news: [] })),
      fetchEffr()  // never throws, returns null on failure
    ]);

    res.json({
      quotes: quotesData.quoteResponse?.result || [],
      news: newsData.news || [],
      zqTickers,
      effr  // Effective Fed Funds Rate from FRED
    });
  } catch (e) {
    console.error("overview:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Revenue growth — fetches financialData module for each symbol in parallel
// Accepts up to 20 symbols per call to avoid rate limiting
app.get("/api/revgrowth", async (req, res) => {
  try {
    const symbols = (req.query.symbols || "").split(",").filter(Boolean).slice(0, 20);

    const results = await Promise.allSettled(
      symbols.map(sym =>
        yf(`https://query1.finance.yahoo.com/v11/finance/quoteSummary/${sym}?modules=financialData`)
          .then(d => {
            const fd = d?.quoteSummary?.result?.[0]?.financialData;
            return {
              symbol: sym,
              revenueGrowth: fd?.revenueGrowth?.raw ?? null,
            };
          })
      )
    );

    const out = {};
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        out[symbols[i]] = r.value.revenueGrowth;
      } else {
        out[symbols[i]] = null;
      }
    });

    res.json(out);
  } catch (e) {
    console.error("revgrowth:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, async () => {
  console.log("Server on port", PORT);
  // Try to get crumb with retries
  let ok = false;
  for(let i=0; i<5; i++) {
    ok = await refreshCrumb();
    if(ok) break;
    const wait = (i+1) * 3000;
    console.log(`Crumb failed, retrying in ${wait/1000}s...`);
    await new Promise(r => setTimeout(r, wait));
  }
  // Refresh every 20 minutes
  setInterval(async () => {
    const ok = await refreshCrumb();
    if(!ok) setTimeout(refreshCrumb, 5000); // retry once if fails
  }, 20 * 60 * 1000);
});
