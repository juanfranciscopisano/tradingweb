// Arma fundamentals.json (P/E, fw P/E, P/B y market cap) para el Screener, el Heatmap, Cartera y P/E Hist.
// Corre en GitHub Actions una vez por día (.github/workflows/fundamentals.yml).
//   1) Yahoo v7/quote con cookie + crumb pedidos desde la IP del runner (cambia en cada corrida).
//   2) Lo que Yahoo no trae: Finnhub /stock/metric (60 llamadas/min en el plan gratis).
//   3) Lo que ninguna trae hoy: se arrastra del archivo anterior marcado como "stale".
// Guarda el precio de referencia (p) para que la página reescale los ratios con el precio en vivo.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FIELDS = "shortName,longName,regularMarketPrice,marketCap,trailingPE,forwardPE,priceToBook";
const num = v => (typeof v === "number" && isFinite(v)) ? v : null;
const pos = v => (num(v) != null && v > 0) ? v : null;

// tickers de la página (lista fija de respaldo, Cartera y top 50) más la composición actual del S&P 500 (spx.json)
function tickersFrom(html, spx = []) {
  const arr = name => {
    const m = html.match(new RegExp(`(?:const|let) ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
  };
  return [...new Set([...spx, ...arr("TKS"), ...arr("CARTERA_TICKERS"), ...arr("TOP50_TICKERS")])];
}

async function yahooSession(f) {
  const r1 = await f("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const raw = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [r1.headers.get("set-cookie")].filter(Boolean);
  const cookie = raw.map(c => c.split(";")[0]).filter(Boolean).join("; ");
  if (!cookie) throw new Error("Yahoo no devolvió cookie");
  for (const host of ["query1", "query2"]) {
    const r2 = await f(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, { headers: { "User-Agent": UA, Cookie: cookie } });
    const crumb = (await r2.text()).trim();
    if (r2.ok && crumb && crumb.length <= 20 && !/[\s<{]/.test(crumb)) return { cookie, crumb };
  }
  throw new Error("Yahoo no devolvió crumb");
}

async function fromYahoo(f, symbols, today, sleep) {
  const out = {};
  const s = await yahooSession(f);
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${chunk.map(encodeURIComponent).join(",")}`
      + `&fields=${FIELDS}&crumb=${encodeURIComponent(s.crumb)}`;
    let r = await f(url, { headers: { "User-Agent": UA, Cookie: s.cookie, Accept: "application/json" } });
    if (r.status === 429) { await sleep(5000); r = await f(url, { headers: { "User-Agent": UA, Cookie: s.cookie, Accept: "application/json" } }); }
    if (!r.ok) throw new Error(`Yahoo quote HTTP ${r.status} en la tanda ${i / 50 + 1}`);
    const j = await r.json();
    for (const q of j?.quoteResponse?.result || []) {
      const e = { n: q.shortName || q.longName || null, p: pos(q.regularMarketPrice), pe: pos(q.trailingPE), fpe: pos(q.forwardPE),
        pb: pos(q.priceToBook), mc: pos(q.marketCap), src: "yahoo", d: today };
      if (e.pe || e.fpe || e.pb || e.mc) out[q.symbol] = e;
    }
    await sleep(300);
  }
  return out;
}

async function fromFinnhub(f, symbols, key, today, sleep, delayMs) {
  const out = {};
  const pick = (o, ks) => { for (const k of ks) { const v = num(o?.[k]); if (v != null) return v; } return null; };
  for (const sym of symbols) {
    const url = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all`;
    let r = await f(url, { headers: { "X-Finnhub-Token": key } });
    if (r.status === 429) { await sleep(61000); r = await f(url, { headers: { "X-Finnhub-Token": key } }); }
    if (r.ok) {
      const m = (await r.json())?.metric || {};
      const mcM = pick(m, ["marketCapitalization"]);
      const e = { n: null, p: null,
        pe: pos(pick(m, ["peTTM", "peExclExtraTTM", "peBasicExclExtraTTM", "peInclExtraTTM", "peNormalizedAnnual"])),
        fpe: pos(pick(m, ["forwardPE", "peForward"])),
        pb: pos(pick(m, ["pbQuarterly", "pbAnnual", "ptbvQuarterly"])),
        mc: mcM ? mcM * 1e6 : null, src: "finnhub", d: today };
      if (e.pe || e.fpe || e.pb || e.mc) out[sym] = e;
    }
    await sleep(delayMs);
  }
  return out;
}

export async function main({ root = new URL("../", import.meta.url), fetchImpl = globalThis.fetch, now = new Date(),
  finnhubKey = process.env.FINNHUB_KEY || "", sleep = ms => new Promise(r => setTimeout(r, ms)), delayMs = 1100, log = console.log } = {}) {
  const today = now.toISOString().slice(0, 10);
  let spx = [];
  try { spx = JSON.parse(await readFile(new URL("spx.json", root), "utf8")).list.map(x => x.s); } catch (e) { console.log("spx.json: " + e.message); }
  const symbols = tickersFrom(await readFile(new URL("index.html", root), "utf8"), spx);
  if (symbols.length < 50) throw new Error(`Encontré solo ${symbols.length} tickers en index.html`);

  let prev = {};
  try { prev = JSON.parse(await readFile(new URL("fundamentals.json", root), "utf8")).data || {}; } catch (_) { /* primera corrida */ }

  let yahoo = {};
  try { yahoo = await fromYahoo(fetchImpl, symbols, today, sleep); }
  catch (e) { log(`Yahoo falló: ${e.message}`); }
  log(`Yahoo: ${Object.keys(yahoo).length}/${symbols.length}`);

  const missing = symbols.filter(s => !yahoo[s]);
  let fh = {};
  if (missing.length && finnhubKey) {
    log(`Finnhub para ${missing.length} tickers (~${Math.ceil(missing.length * delayMs / 60000)} min)`);
    fh = await fromFinnhub(fetchImpl, missing, finnhubKey, today, sleep, delayMs);
  } else if (missing.length) log("Sin FINNHUB_KEY: no hay segunda fuente");

  const data = {};
  let carried = 0;
  for (const s of [...symbols].sort()) {
    if (yahoo[s]) data[s] = yahoo[s];
    else if (fh[s]) data[s] = { ...fh[s], n: prev[s]?.n ?? null };
    else if (prev[s]) { data[s] = { ...prev[s], stale: true }; carried++; }
  }
  const fresh = Object.keys(yahoo).length + Object.keys(fh).length;
  if (!fresh) throw new Error("Ninguna fuente devolvió datos hoy: no toco fundamentals.json");

  const counts = { yahoo: Object.keys(yahoo).length, finnhub: Object.keys(fh).length, arrastrados: carried, sinDatos: symbols.length - Object.keys(data).length };
  await writeFile(new URL("fundamentals.json", root), JSON.stringify({ asOf: now.toISOString(), counts, data }) + "\n");
  log(`OK: ${JSON.stringify(counts)}`);
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
