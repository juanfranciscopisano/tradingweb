import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// ── Yahoo Finance necesita cookie + crumb desde 2024 ──
let yfCookie = "";
let yfCrumb  = "";

async function refreshCrumb() {
  try {
    // 1) Obtener cookie
    const r1 = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36" },
      redirect: "follow",
    });
    const cookies = r1.headers.get("set-cookie") || "";
    // Extraer A3 o cualquier cookie de sesión
    yfCookie = cookies.split(",").map(c => c.split(";")[0]).join("; ");

    // 2) Obtener crumb usando la cookie
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
  // Agregar crumb al URL
  const sep = url.includes("?") ? "&" : "?";
  const fullUrl = `${url}${sep}crumb=${encodeURIComponent(yfCrumb)}`;

  let res = await fetch(fullUrl, { headers: yfHeaders() });

  // Si falla, refrescar crumb y reintentar
  if (res.status === 401 || res.status === 403) {
    console.log("Auth error, refreshing crumb...");
    await refreshCrumb();
    const retryUrl = `${url}${sep}crumb=${encodeURIComponent(yfCrumb)}`;
    res = await fetch(retryUrl, { headers: yfHeaders() });
  }

  if (!res.ok) throw new Error(`Yahoo returned ${res.status}`);
  return res.json();
}

// ── Endpoints ──
app.get("/", (req, res) => res.json({ status: "ok", crumb: yfCrumb.length > 3 ? "ready" : "missing" }));

app.get("/api/quote", async (req, res) => {
  try {
    const { symbols } = req.query;
    const data = await yfFetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&lang=en-US&region=US`
    );
    res.json(data);
  } catch (err) {
    console.error("Quote error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/spark", async (req, res) => {
  try {
    const { symbols } = req.query;
    const data = await yfFetch(
      `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=1y&interval=1d`
    );
    res.json(data);
  } catch (err) {
    console.error("Spark error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Iniciar ──
app.listen(PORT, async () => {
  console.log("Server running on port", PORT);
  await refreshCrumb();
  // Refrescar crumb cada 30 minutos
  setInterval(refreshCrumb, 30 * 60 * 1000);
});
