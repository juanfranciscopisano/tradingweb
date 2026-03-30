import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// Endpoint: quotes
app.get("/api/quote", async (req, res) => {
  try {
    const { symbols } = req.query;

    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&lang=en-US&region=US`;

    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Error fetching quote data" });
  }
});

// Endpoint: spark (histórico)
app.get("/api/spark", async (req, res) => {
  try {
    const { symbols } = req.query;

    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=1y&interval=1d`;

    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Error fetching spark data" });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
