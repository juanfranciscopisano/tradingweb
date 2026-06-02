import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let yfCookie = "";
let yfCrumb  = "";
let crumbFetching = false;

app.get("/", (req, res) => res.json({ status: "ok", crumb: yfCrumb.length > 3 ? "ready" : "missing" }));
app.get("/debug", (req, res) => res.json({ crumb: yfCrumb.length > 3 ? "ready" : "missing", crumbFetching }));
app.get("/refresh-crumb", async (req, res) => {
  if(!crumbFetching) crumbLoop();
  res.json({ status: "started" });
});

async function refreshCrumb() {
  if(crumbFetching) return yfCrumb.length > 3;
  crumbFetching = true;
  try {
    const r1 = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA }, redirect: "follow"
    });
    yfCookie = (r1.headers.get("set-cookie") || "").split(",").map(c => c.split(";")[0]).join("; ");

    await new Promise(r => setTimeout(r, 2000));

    for(const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
      const r2 = await fetch(`https://${host}/v1/test/getcrumb`, {
        headers: { "User-Agent": UA, "Cookie": yfCookie }
      });
      const t = (await r2.text()).trim();
      const valid = t.length >= 3 && t.length <= 20
        && !t.includes(" ") && !t.includes("<")
        && !t.toLowerCase().includes("too")
        && !t.toLowerCase().includes("error");
      if(valid) {
        yfCrumb = t;
        console.log("Crumb OK:", yfCrumb.slice(0,8));
        crumbFetching = false;
        return true;
      }
      console.log(`Bad crumb (${host}):`, t.slice(0,30));
      await new Promise(r => setTimeout(r, 2000));
    }
    crumbFetching = false;
    return false;
  } catch(e) {
    console.error("refreshCrumb:", e.message);
    crumbFetching = false;
    return false;
  }
}

app.listen(PORT, async () => {
  console.log("Server on port", PORT);
  // Wait 30s before first attempt — avoids rate limiting on startup
  const tryWithDelay = async (attempt, delay) => {
    await new Promise(r => setTimeout(r, delay));
    console.log(`Crumb attempt ${attempt}...`);
    const ok = await refreshCrumb();
    if(ok) {
      console.log("Crumb ready after attempt", attempt);
    } else if(attempt < 10) {
      const next = Math.min(delay * 2, 120000);
      console.log(`Attempt ${attempt} failed, next in ${Math.round(next/1000)}s`);
      tryWithDelay(attempt + 1, next);
    } else {
      console.error("Giving up after 10 attempts");
    }
  };
  tryWithDelay(1, 30000);
  // Refresh every 20 min
  setInterval(async () => {
    const ok = await refreshCrumb();
    if(!ok) {
      console.log("Scheduled refresh failed, retrying in 2 min...");
      setTimeout(refreshCrumb, 120000);
    }
  }, 20 * 60 * 1000);
});
