import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// Headers que imitan un browser — sin esto Yahoo bloquea
const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://finance.yahoo.com",
  "Referer": "https://finance.yahoo.com/",
};

app.get("/api/quote", async (req, res) => {
  try {
    const { symbols } = req.query;
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&lang=en-US&region=US`;
    const response = await fetch(url, { headers: YF_HEADERS });
    if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Quote error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/spark", async (req, res) => {
  try {
    const { symbols } = req.query;
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=1y&interval=1d`;
    const response = await fetch(url, { headers: YF_HEADERS });
    if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Spark error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.listen(PORT, () => console.log("Server running on port", PORT));
