import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

let yfCookie = "";
let yfCrumb  = "";
let crumbFetching = false;
let crumbBusy = false;            // true for the WHOLE retry loop, so /api requests never poke Yahoo during a quiet window
let crumbCooldownUntil = 0;       // on a 429, stop hitting Yahoo until this time so the IP's rate limit can reset
const COOLDOWN_MS = 30 * 60 * 1000;
let crumb429Count = 0;            // consecutive rate-limited attempts; caps the retry chain so it can't run forever
const MAX_429_ATTEMPTS = 6;       // after 6 tries (1 every 30 min ~ 2.5 h) give up until redeploy or /refresh-crumb

// ---- In-memory response cache: many visitors collapse into ONE upstream Yahoo call per key/TTL ----
const cache = new Map();      // key -> { expires, data }
const inflight = new Map();   // key -> Promise (dedupe concurrent cache misses)
async function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if(hit && hit.expires > Date.now()) return hit.data;     // fresh hit
  if(inflight.has(key)) return inflight.get(key);          // a fetch for this exact key is already running — join it
  const p = (async () => {
    const data = await producer();
    cache.set(key, { expires: Date.now() + ttlMs, data });
    return data;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function refreshCrumb() {
  if(crumbFetching) return yfCrumb.length > 3; // already in progress
  crumbFetching = true;
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
    if(r1.status === 429 || r2.status === 429) {
      crumb429Count++;
      crumbCooldownUntil = Date.now() + COOLDOWN_MS;
      if(crumb429Count < MAX_429_ATTEMPTS) {
        console.error(`Yahoo 429 (attempt ${crumb429Count}/${MAX_429_ATTEMPTS}) — pausing ${COOLDOWN_MS/60000} min before next try`);
        setTimeout(() => { if(!crumbBusy && !crumbFetching && crumb429Count < MAX_429_ATTEMPTS) crumbLoop(); }, COOLDOWN_MS + 5000);
      } else {
        console.error(`Yahoo 429 (attempt ${crumb429Count}/${MAX_429_ATTEMPTS}) — giving up. Redeploy or hit /refresh-crumb to retry.`);
      }
      yfCrumb = "";
      crumbFetching = false;
      return false;
    }
    yfCrumb = (await r2.text()).trim();
    if(yfCrumb.length < 5 || yfCrumb.length > 20 || yfCrumb.includes(" ") || yfCrumb.includes("<") || yfCrumb.includes("{")) {
      console.error("Bad crumb rejected:", JSON.stringify(yfCrumb.slice(0,30)), "(status", r2.status + ")");
      yfCrumb = "";
      crumbFetching = false;
      return false;
    }
    console.log("Crumb OK:", yfCrumb.slice(0,10), "| Cookie len:", yfCookie.length);
    crumb429Count = 0;            // success — clear the rate-limit counter
    crumbFetching = false;
    return true;
  } catch (e) {
    console.error("refreshCrumb error:", e.message);
    crumbFetching = false;
    return false;
  }
}

// Run crumb retry loop independently at top level
async function crumbLoop() {
  if(crumbBusy) return;          // a retry loop is already running
  if(crumb429Count >= MAX_429_ATTEMPTS) { console.log("Crumb: gave up after max 429 attempts — not retrying (redeploy or /refresh-crumb)"); return; }
  crumbBusy = true;
  try {
    // Delays: 15s, 30s, 60s, 120s, 180s, 240s, 300s (up to 15 min total)
    const delays = [0, 15000, 30000, 60000, 120000, 180000, 240000, 300000];
    for(let i = 0; i < delays.length; i++) {
      if(Date.now() < crumbCooldownUntil) {
        console.log(`Crumb cooldown active (~${Math.ceil((crumbCooldownUntil - Date.now())/60000)} min left) — stopping retries`);
        return;
      }
      if(delays[i] > 0) {
        console.log(`Crumb retry ${i+1}/${delays.length} in ${delays[i]/1000}s...`);
        await new Promise(r => setTimeout(r, delays[i]));
      }
      const ok = await refreshCrumb();
      if(ok) { console.log("Crumb ready after attempt", i+1); return; }
    }
    console.error("Could not get crumb after all attempts — will retry on next request");
  } finally {
    crumbBusy = false;
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
  // If a crumb acquisition (single fetch OR the retry loop) is in flight, wait
  // for it instead of firing our own — never poke Yahoo during a quiet window.
  if(yfCrumb.length <= 3 && (crumbBusy || crumbFetching)) {
    for(let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5000));
      if(yfCrumb.length > 3) break;
    }
  }
  const sep = url.includes("?") ? "&" : "?";
  let res = await fetch(`${url}${sep}crumb=${encodeURIComponent(yfCrumb)}`, { headers: yfHeaders() });
  if (res.status === 401 || res.status === 403) {
    if(!crumbBusy && !crumbFetching && Date.now() >= crumbCooldownUntil && crumb429Count < MAX_429_ATTEMPTS) {
      // crumb genuinely expired and nothing is recovering it — refresh once
      console.log("Auth error, refreshing crumb...");
      await refreshCrumb();
    } else {
      // a loop/refresh is already running — wait briefly, don't add load
      await new Promise(r => setTimeout(r, 5000));
    }
    res = await fetch(`${url}${sep}crumb=${encodeURIComponent(yfCrumb)}`, { headers: yfHeaders() });
  }
  if (!res.ok) throw new Error(`Yahoo returned ${res.status}`);
  return res.json();
}

app.get("/", (req, res) => res.json({ status: "ok", crumb: yfCrumb.length > 3 ? "ready" : "missing" }));

app.get("/debug", (req, res) => res.json({
  finnhub: process.env.FINNHUB_KEY ? "set (len=" + process.env.FINNHUB_KEY.length + ")" : "missing",
  crumb: yfCrumb.length > 3 ? "ready" : "missing",
  crumbFetching,
  attempts429: crumb429Count,
  gaveUp: crumb429Count >= MAX_429_ATTEMPTS,
  cooldownMinLeft: Math.max(0, Math.ceil((crumbCooldownUntil - Date.now()) / 60000))
}));

// Manual crumb refresh endpoint
app.get("/refresh-crumb", async (req, res) => {
  if(crumbBusy || crumbFetching) return res.json({ status: "already fetching" });
  crumb429Count = 0;            // manual retry — clear the give-up state and cooldown
  crumbCooldownUntil = 0;
  crumbLoop();
  res.json({ status: "crumb refresh started" });
});

app.get("/debug-edgar", async (req, res) => {
  try {
    const sym = (req.query.symbol || "META").toUpperCase();
    const tickerMap = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": "tradingweb research@example.com" }
    }).then(r => r.json());
    const entry = Object.values(tickerMap).find(c => c.ticker.toUpperCase() === sym);
    if(!entry) return res.json({ error: "ticker not found" });
    const cik = String(entry.cik_str).padStart(10, '0');
    const facts = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      headers: { "User-Agent": "tradingweb research@example.com" }
    }).then(r => r.json());
    const epsData = facts?.facts?.["us-gaap"]?.EarningsPerShareDiluted?.units?.["USD/shares"] || [];
    const recent = epsData
      .filter(e => e.form === "10-Q" || e.form === "10-K")
      .sort((a,b) => a.end.localeCompare(b.end))
      .slice(-24)
      .map(e => ({ end: e.end, fp: e.fp, fy: e.fy, val: e.val, frame: e.frame||'', form: e.form }));
    res.json({ cik, sym, count: epsData.length, recent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/quote", async (req, res) => {
  try {
    const { symbols } = req.query;
    const data = await cached(`quote:${symbols}`, 45 * 1000, () =>
      yfFetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&lang=en-US&region=US`));
    res.json(data);
  } catch (err) {
    console.error("Quote error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/spark", async (req, res) => {
  try {
    const { symbols } = req.query;
    const data = await cached(`spark:${symbols}`, 10 * 60 * 1000, () =>
      yfFetch(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=1y&interval=1d`));
    res.json(data);
  } catch (err) {
    console.error("Spark error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- RSS helper (Reuters / MarketWatch) — independent of Yahoo, no crumb ----
function decodeEntities(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'").replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim();
}

async function fetchRSS(url, publisher) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if(!r.ok) { console.log(`RSS fetch failed: ${publisher} (${r.status})`); return []; }
    const xml = await r.text();
    const blocks = xml.split(/<item[\s>]/i).slice(1);
    const out = [];
    for(const b of blocks) {
      const tM = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = decodeEntities(tM ? tM[1] : "");
      if(!title) continue;
      let link = "";
      const lM = b.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
      if(lM) link = decodeEntities(lM[1]);
      if(!link) { const hM = b.match(/<link[^>]*href="([^"]+)"/i); if(hM) link = hM[1]; }
      const dM = b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || b.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i);
      let ts = 0;
      if(dM) { const p = Date.parse(decodeEntities(dM[1])); if(!isNaN(p)) ts = Math.floor(p / 1000); }
      out.push({ title, link, publisher, providerPublishTime: ts });
    }
    console.log(`RSS ${publisher}: ${out.length} items`);
    return out;
  } catch(e) {
    console.log(`RSS error ${publisher}:`, e.message);
    return [];
  }
}

app.get("/api/overview", async (req, res) => {
  try {
    const payload = await cached("overview", 60 * 1000, async () => {
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

    const [quotesData, effr, ...rssResults] = await Promise.all([
      yfFetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&lang=en-US&region=US`),
      fetchEffr(),
      // Independent RSS sources — no Yahoo crumb needed
      fetchRSS('https://feeds.reuters.com/reuters/businessNews', 'Reuters'),
      fetchRSS('https://feeds.reuters.com/reuters/topNews', 'Reuters'),
      fetchRSS('https://feeds.reuters.com/reuters/marketsNews', 'Reuters'),
      fetchRSS('https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines', 'MarketWatch'),
      fetchRSS('https://feeds.content.dowjones.io/public/rss/mw_bulletins', 'MarketWatch'),
    ]);

    let normalizedNews = rssResults.flat();
    console.log('RSS news total before dedup:', normalizedNews.length);

    // If RSS failed entirely, fall back to Yahoo
    if(normalizedNews.length < 3) {
      console.log('RSS empty, falling back to Yahoo news');
      try {
        const yNews = await yfFetch('https://query1.finance.yahoo.com/v1/finance/search?q=stock+market+economy+fed&newsCount=20&lang=en-US&region=US&enableFuzzyQuery=false').catch(()=>({news:[]}));
        normalizedNews = (yNews.news||[]);
      } catch(e) { console.log('Yahoo news fallback failed:', e.message); }
    }

    // Deduplicate by title, sort newest first, take top 25
    const seenTitles = new Set();
    const allNews = normalizedNews
      .filter(n => {
        if(!n.title || seenTitles.has(n.title)) return false;
        seenTitles.add(n.title);
        return true;
      })
      .sort((a, b) => (b.providerPublishTime || 0) - (a.providerPublishTime || 0))
      .slice(0, 25);
    console.log('Final news count:', allNews.length);

    return { quotes: quotesData.quoteResponse?.result || [], news: allNews, zqTickers, effr };
    });
    res.json(payload);
  } catch(e) {
    console.error("overview:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/pebg", async (req, res) => {
  try {
    const sym = (req.query.symbol || "").toUpperCase().trim();
    if(!sym) return res.status(400).json({ error: "symbol required" });

    const payload = await cached(`pebg:${sym}`, 30 * 60 * 1000, async () => {
    // SEC EDGAR: public API, no key needed, full quarterly EPS history
    const getEdgarEPS = async (symbol) => {
      try {
        // Step 1: find CIK from ticker via SEC's public ticker map
        const tickerMap = await fetch("https://www.sec.gov/files/company_tickers.json", {
          headers: { "User-Agent": "tradingweb research@example.com" }
        }).then(r => r.json());

        const entry = Object.values(tickerMap).find(c => c.ticker.toUpperCase() === symbol);
        if(!entry) return [];

        const cik = String(entry.cik_str).padStart(10, '0');
        const factsRes = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
          headers: { "User-Agent": "tradingweb research@example.com" }
        });
        const facts = await factsRes.json();

        // EPS diluted — use frame field to get true quarterly (not YTD cumulative)
        const epsData = facts?.facts?.["us-gaap"]?.EarningsPerShareDiluted?.units?.["USD/shares"] || [];

        // Use frame="CY####Q#" entries for Q1/Q2/Q3 (true single-quarter values)
        // Derive Q4 = FY_annual - Q3_YTD, with support for all fiscal year end months
        const quarterly = {};
        const annualByYear = {};
        const ytdQ1ByYear = {};
        const ytdQ2ByYear = {};
        const ytdQ3ByYear = {};

        epsData.forEach(e => {
          const endYear = String(new Date(e.end).getFullYear());
          if(!e.frame) {
            if(e.fp === 'Q1' && e.form === '10-Q') {
              if(!e.frame && (!ytdQ1ByYear[endYear] || Math.abs(e.val) > Math.abs(ytdQ1ByYear[endYear].val)))
                ytdQ1ByYear[endYear] = { date: Math.floor(new Date(e.end).getTime()/1000), val: e.val, end: e.end };
            } else if(e.fp === 'Q2' && e.form === '10-Q') {
              if(!e.frame && (!ytdQ2ByYear[endYear] || Math.abs(e.val) > Math.abs(ytdQ2ByYear[endYear].val)))
                ytdQ2ByYear[endYear] = { date: Math.floor(new Date(e.end).getTime()/1000), val: e.val, end: e.end };
            } else if(e.fp === 'Q3' && e.form === '10-Q') {
              if(!e.frame && (!ytdQ3ByYear[endYear] || Math.abs(e.val) > Math.abs(ytdQ3ByYear[endYear].val)))
                ytdQ3ByYear[endYear] = { date: Math.floor(new Date(e.end).getTime()/1000), val: e.val, end: e.end };
            } else if(e.fp === 'FY' && e.form === '10-K') {
              if(!annualByYear[endYear] || e.end > annualByYear[endYear].end)
                annualByYear[endYear] = { date: Math.floor(new Date(e.end).getTime()/1000), val: e.val, end: e.end };
            }
          } else if(/^CY\d{4}Q\d$/.test(e.frame)) {
            if(!quarterly[e.frame] || e.end > quarterly[e.frame].end)
              quarterly[e.frame] = { date: Math.floor(new Date(e.end).getTime()/1000), eps: e.val, end: e.end };
          } else if(/^CY\d{4}$/.test(e.frame)) {
            // Use FRAME year (not endYear) so Jan-FY companies like NVDA map correctly
            const frameYr = e.frame.slice(2);
            if(!annualByYear[frameYr] || e.end > annualByYear[frameYr].end)
              annualByYear[frameYr] = { date: Math.floor(new Date(e.end).getTime()/1000), val: e.val, end: e.end };
          }
        });

        // Build result: quarters from CY frames
        const derived = Object.entries(quarterly)
          .map(([frame, v]) => ({ date: v.date, eps: v.eps, frame }));

        // Derive missing last quarter = Annual - YTD
        // Use Q3 YTD end month to determine which quarter is missing:
        //   Month <= 3 (Mar or earlier) → missing = CY Q2 e.g. Jun-FY (MSFT,NIKE)
        //   Month 4-6 (Jun or earlier)  → missing = CY Q3 e.g. Sep-FY (QCOM)
        //   Month 7-10 (Sep/Oct)        → missing = CY Q4 e.g. Dec-FY, Jan-FY (NVDA)
        Object.keys(annualByYear).forEach(yr => {
          const ann = annualByYear[yr];
          const q3ytd = ytdQ3ByYear[yr];
          if(!q3ytd || ann.date <= q3ytd.date) return;

          const ytdMonth = new Date(q3ytd.end).getMonth(); // 0-indexed
          let missingFrame, ytd;
          if(ytdMonth <= 3) {
            missingFrame = `CY${yr}Q2`;
            ytd = ytdQ2ByYear[yr] || q3ytd;
          } else if(ytdMonth <= 6) {
            missingFrame = `CY${yr}Q3`;
            ytd = q3ytd;
          } else {
            missingFrame = `CY${yr}Q4`;
            ytd = q3ytd;
          }

          if(!quarterly[missingFrame]) {
            const derivedEps = ann.val - ytd.val;
            console.log(`pebg ${symbol}: deriving ${missingFrame} = ${ann.val} - ${ytd.val} = ${derivedEps}`);
            derived.push({ date: ann.date, eps: derivedEps, frame: missingFrame });
          }
        });

        const quarterly_result = derived
          .filter(e => !isNaN(e.eps))
          .sort((a,b) => a.date - b.date)
          .filter((e,i,arr) => i === arr.findIndex(x => x.frame === e.frame));
        console.log(`pebg ${symbol}: SEC EDGAR returned ${quarterly_result.length} EPS quarters`);
        return quarterly_result;
      } catch(e) {
        console.log(`pebg ${symbol}: SEC EDGAR error:`, e.message);
        return [];
      }
    };

    const [priceData, edgarEps, summaryData] = await Promise.all([
      yfFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3y`),
      getEdgarEPS(sym),
      yfFetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=defaultKeyStatistics,financialData,price,earningsHistory,earnings`).catch(() => null)
    ]);

    const chart = priceData.chart?.result?.[0];
    if(!chart) throw new Error("No price data for " + sym);
    const timestamps = chart.timestamp || [];
    const closes = chart.indicators?.quote?.[0]?.close || [];
    const prices = timestamps.map((t,i) => ({ date: t, close: closes[i] })).filter(p => p.close != null);

    // Yahoo earningsHistory: authoritative for last 4 quarters
    const summResult = summaryData?.quoteSummary?.result?.[0];
    const hist = summResult?.earningsHistory?.history || [];
    const yahooEps = hist
      .filter(e => e.epsActual?.raw != null)
      .map(e => ({ date: e.reportDate?.raw || e.quarter?.raw || 0, eps: e.epsActual.raw }))
      .filter(e => e.date > 0)
      .sort((a,b) => a.date - b.date);

    // Match quarters by calendar period (YYYY-Q#), not by date proximity
    const toQKey = ts => {
      const d = new Date(ts * 1000);
      return d.getFullYear() + 'Q' + (Math.floor(d.getMonth() / 3) + 1);
    };

    // Merge: EDGAR (GAAP) preferred, Yahoo fills gaps EDGAR doesn't have
    let eps;
    if(edgarEps.length >= 4) {
      const edgarKeys = new Set(edgarEps.map(e => toQKey(e.date)));
      const yahooOnly = yahooEps.filter(yq => !edgarKeys.has(toQKey(yq.date)));
      eps = [...edgarEps, ...yahooOnly].sort((a,b) => a.date - b.date);
      console.log(`pebg ${sym}: EDGAR(${edgarEps.length}) + Yahoo_gap(${yahooOnly.length}) = ${eps.length} quarters`);
    } else {
      // EDGAR insufficient — use Yahoo as primary source
      eps = yahooEps.length > 0 ? yahooEps : edgarEps;
      console.log(`pebg ${sym}: Yahoo primary (${eps.length} quarters)`);
    }
    const result = summResult;
    const priceInfo = result?.price || {};
    const keyStats = result?.defaultKeyStatistics || {};
    const finData = result?.financialData || {};
    const meta = chart.meta || {};

    console.log(`pebg ${sym}: ${prices.length} prices, ${eps.length} EPS quarters`);

    return {
      symbol: sym,
      shortName: priceInfo.shortName || meta.longName || sym,
      prices, eps, epsCount: eps.length,
      currentPrice: priceInfo.regularMarketPrice?.raw || meta.regularMarketPrice,
      currentPE: keyStats.trailingPE?.raw,
      forwardPE: keyStats.forwardPE?.raw || null,
      epsTrailingTwelveMonths: finData.epsTrailingTwelveMonths?.raw,
    };
    });
    res.json(payload);
  } catch(e) {
    console.error("pebg:", e.message);
    res.status(500).json({ error: e.message });
  }
});


app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  crumbLoop();
  // Refresh crumb every 25 min (before Yahoo expires it at ~30min)
  setInterval(() => {
    if(!crumbBusy && !crumbFetching && Date.now() >= crumbCooldownUntil && crumb429Count < MAX_429_ATTEMPTS) refreshCrumb();
  }, 25 * 60 * 1000);
});
