
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
    yfCookie = (r1.headers.get("set-cookie") || "").split(",").map(c => c.split(";")[0]).join("; ");
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
        "Cookie": yfCookie,
      },
    });
    yfCrumb = await r2.text();
    console.log("Crumb OK:", yfCrumb.slice(0, 10));
    return yfCrumb.length > 3;
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

// Bulk quote — explicit fields to ensure revenueGrowth is included
const FIELDS = [
  "symbol","shortName","longName","regularMarketPrice","marketCap",
  "trailingPE","forwardPE","priceToBook","regularMarketChangePercent",
  "fiftyTwoWeekChangePercent","sector","revenueGrowth","earningsGrowth"
].join(",");

app.get("/api/quote", async (req, res) => {
  try {
    const data = await yf(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${req.query.symbols}&lang=en-US&region=US&fields=${FIELDS}`
    );
    res.json(data);
  } catch (e) {
    console.error("quote:", e.message);
    res.status(500).json({ error: e.message });
  }
});

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

app.listen(PORT, async () => {
  console.log("Server on port", PORT);
  await refreshCrumb();
  setInterval(refreshCrumb, 30 * 60 * 1000);
});
