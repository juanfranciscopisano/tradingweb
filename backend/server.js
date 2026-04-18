
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
    // Step 1: get cookies from fc.yahoo.com (minimal headers, no overflow)
    const r1 = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA },
      redirect: "follow",
    });
    yfCookie = (r1.headers.get("set-cookie") || "").split(",").map(c => c.split(";")[0]).join("; ");

    // Step 2: get crumb
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, "Cookie": yfCookie },
    });
    const text = (await r2.text()).trim();

    // Valid crumb: short, no spaces, no HTML, not an error message
    const isValid = text.length >= 3 && text.length <= 20
      && !text.includes(" ") && !text.includes("<")
      && !text.toLowerCase().includes("too") && !text.toLowerCase().includes("error");

    if (isValid) {
      yfCrumb = text;
      console.log("Crumb OK:", yfCrumb.slice(0, 10));
      return true;
    }

    // Fallback: try query2 which has separate rate limiting
    const r3 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, "Cookie": yfCookie },
    });
    const text2 = (await r3.text()).trim();
    const isValid2 = text2.length >= 3 && text2.length <= 20
      && !text2.includes(" ") && !text2.includes("<")
      && !text2.toLowerCase().includes("too");

    if (isValid2) {
      yfCrumb = text2;
      console.log("Crumb (q2) OK:", yfCrumb.slice(0, 10));
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
  for(let i = 0; i < 5; i++) {
    ok = await refreshCrumb();
    if(ok) break;
    const wait = (i + 1) * 4000;
    console.log(`Crumb attempt ${i+1} failed, waiting ${wait/1000}s...`);
    await new Promise(r => setTimeout(r, wait));
  }
  if(!ok) console.error("WARNING: No crumb after 5 attempts");
  setInterval(async () => {
    const ok = await refreshCrumb();
    if(!ok) setTimeout(refreshCrumb, 8000);
  }, 25 * 60 * 1000);
});
