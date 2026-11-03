// Empresas argentinas del MSCI MERVAL: P/E y P/BV semanales para P/E histórico y el panel del Merval.
// Por ahora, solo el diagnóstico de las fuentes (MODO=diagnostico): qué trae la SEC (20-F con NIIF) de las que tienen
// ADR, qué trae Yahoo de cada una (en BYMA y el ADR) y qué lista BYMA de sus balances. Todo va al log.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { yahooSession } from "./fundamentals.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DAY = 86400;

// las 19 del MSCI MERVAL desde el 19/10/2026 (La Nación, 17/10/2026): con ADR, el ticker de Nueva York
export const MERVAL = [
  { s: "YPFD", n: "YPF", adr: "YPF" },
  { s: "PAMP", n: "Pampa Energía", adr: "PAM" },
  { s: "GGAL", n: "Grupo Financiero Galicia", adr: "GGAL" },
  { s: "BMA", n: "Banco Macro", adr: "BMA" },
  { s: "TGSU2", n: "Transportadora de Gas del Sur", adr: "TGS" },
  { s: "CEPU", n: "Central Puerto", adr: "CEPU" },
  { s: "BBAR", n: "BBVA Argentina", adr: "BBAR" },
  { s: "BYMA", n: "Bolsas y Mercados Argentinos" },
  { s: "TXAR", n: "Ternium Argentina" },
  { s: "LOMA", n: "Loma Negra", adr: "LOMA" },
  { s: "CRES", n: "Cresud", adr: "CRESY" },
  { s: "EDN", n: "Edenor", adr: "EDN" },
  { s: "ALUA", n: "Aluar" },
  { s: "SUPV", n: "Grupo Supervielle", adr: "SUPV" },
  { s: "VALO", n: "Banco de Valores" },
  { s: "TRAN", n: "Transener" },
  { s: "ECOG", n: "Ecogas Inversiones" },
  { s: "TGNO4", n: "Transportadora de Gas del Norte" },
  { s: "METR", n: "Metrogas" },
];

async function getJSON(f, url, opts = {}, tries = 3) {
  for (let a = 0; ; a++) {
    try {
      const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), 30000);
      const r = await f(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tm));
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (a >= tries - 1) throw e;
      await new Promise(res => setTimeout(res, 1500 * (a + 1)));
    }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SEC_TAGS = ["EquityAttributableToOwnersOfParent", "Equity", "ProfitLossAttributableToOwnersOfParent", "ProfitLoss",
  "BasicEarningsLossPerShare", "DilutedEarningsLossPerShare", "WeightedAverageShares", "AdjustedWeightedAverageShares",
  "NumberOfSharesOutstanding", "Revenue", "ProfitLossFromOperatingActivities"];
const Y_TIPOS = ["DilutedEPS", "BasicEPS", "NetIncomeCommonStockholders", "StockholdersEquity", "CommonStockEquity", "OrdinarySharesNumber", "DilutedAverageShares", "EBITDA", "TotalRevenue"];

export async function diagnostico({ fetchImpl = globalThis.fetch, log = console.log, secUA = "tradingweb research@example.com", solo = null } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const lista = solo ? MERVAL.filter(c => solo.includes(c.s)) : MERVAL;
  // ---- SEC
  const secH = { headers: { "User-Agent": secUA, Accept: "application/json" } };
  let tick = {};
  try {
    const j = await getJSON(fetchImpl, "https://www.sec.gov/files/company_tickers.json", secH);
    for (const c of Object.values(j || {})) tick[String(c.ticker).toUpperCase()] = String(c.cik_str).padStart(10, "0");
    log(`SEC: ${Object.keys(tick).length} tickers`);
  } catch (e) { log("SEC tickers: " + e.message); }
  for (const c of [...lista.filter(c => c.adr), { s: "NU", adr: "NU" }]) {
    const cik = tick[c.adr];
    if (!cik) { log(`\n=== ${c.s}/${c.adr}: sin CIK`); continue; }
    await sleep(250);
    let facts;
    try { facts = await getJSON(fetchImpl, `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, secH); } catch (e) { log(`\n=== ${c.adr}: ${e.message}`); continue; }
    const fam = Object.keys(facts?.facts || {});
    log(`\n=== ${c.s}/${c.adr} CIK ${cik} ${facts?.entityName || ""}: taxonomías ${fam.map(k => k + "(" + Object.keys(facts.facts[k]).length + ")").join(" ")}`);
    const f = facts?.facts?.["ifrs-full"] || {};
    for (const tag of SEC_TAGS) {
      const o = f[tag]; if (!o) continue;
      for (const [u, a] of Object.entries(o.units || {})) {
        const inst = a.filter(e => !e.start), dur = a.filter(e => e.start);
        const anual = dur.filter(e => (Date.parse(e.end) - Date.parse(e.start)) / 864e5 > 350);
        const corto = dur.filter(e => (Date.parse(e.end) - Date.parse(e.start)) / 864e5 < 200);
        const forms = [...new Set(a.map(e => e.form))].join("/");
        log(`  ${tag} [${u}] ${a.length} hechos (${inst.length} saldos, ${anual.length} anuales, ${corto.length} de menos de 200 días) ${forms}; cierres ${[...new Set(a.map(e => e.end))].sort().slice(0, 1)}…${[...new Set(a.map(e => e.end))].sort().slice(-1)}`);
        // primera presentación de cada cierre (lo que se supo entonces)
        const first = new Map();
        for (const e of (inst.length ? inst : anual)) { const k = e.end + (e.start || ""); const p = first.get(k); if (!p || e.filed < p.filed) first.set(k, e); }
        if (/Equity$|ProfitLoss|EarningsLoss|WeightedAverageShares|NumberOfShares/.test(tag))
          log("    " + [...first.values()].sort((x, y) => x.end.localeCompare(y.end)).map(e => `${e.start ? e.start.slice(0, 7) + "→" : ""}${e.end} ${+e.val.toPrecision(5)} (${e.form} ${e.filed})`).join("; "));
      }
    }
    const dei = facts?.facts?.dei || {};
    for (const tag of ["EntityCommonStockSharesOutstanding"]) for (const [u, a] of Object.entries(dei[tag]?.units || {})) log(`  dei:${tag} [${u}] ` + a.map(e => `${e.end} ${e.val}`).join("; "));
  }
  // ---- Yahoo
  let s = null;
  try { s = await yahooSession(fetchImpl); log("\nYahoo: sesión OK"); } catch (e) { log("\nYahoo sesión: " + e.message); }
  const H = { headers: { "User-Agent": UA, Accept: "application/json", ...(s ? { Cookie: s.cookie } : {}) } }, cr = s ? `&crumb=${encodeURIComponent(s.crumb)}` : "";
  const syms = lista.flatMap(c => [c.s + ".BA", ...(c.adr ? [c.adr] : [])]);
  try {
    const fields = "shortName,currency,financialCurrency,regularMarketPrice,marketCap,sharesOutstanding,trailingPE,priceToBook,epsTrailingTwelveMonths,bookValue,forwardPE";
    const j = await getJSON(fetchImpl, `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${syms.map(encodeURIComponent).join(",")}&fields=${fields}${cr}`, H);
    for (const q of j?.quoteResponse?.result || []) log(`quote ${q.symbol}: ${q.shortName} ${q.currency}/${q.financialCurrency} p=${q.regularMarketPrice} mc=${q.marketCap} acc=${q.sharesOutstanding} PE=${q.trailingPE} PB=${q.priceToBook} EPS12=${q.epsTrailingTwelveMonths} BV=${q.bookValue} fPE=${q.forwardPE}`);
  } catch (e) { log("quote: " + e.message); }
  for (const sym of syms) {
    await sleep(400);
    const types = ["quarterly", "annual", "trailing"].flatMap(p => Y_TIPOS.map(t => p + t)).join(",");
    try {
      const j = await getJSON(fetchImpl, `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types}&period1=946684800&period2=${now + DAY}${cr}`, H);
      const res = j?.timeseries?.result || [], lineas = [];
      for (const r of res) {
        const t = r?.meta?.type?.[0], pts = (r[t] || []).filter(x => x && x.asOfDate && isFinite(x.reportedValue?.raw));
        if (!pts.length) continue;
        lineas.push(`${t}: ${pts.map(x => `${x.asOfDate} ${+(+x.reportedValue.raw).toPrecision(5)}${x.currencyCode ? "" : ""}`).join(", ")} [${[...new Set(pts.map(x => x.currencyCode))].join("/")}]`);
      }
      log(`\nYahoo ${sym}: ${lineas.length ? "" : "sin datos"}`);
      for (const l of lineas) log("  " + l);
    } catch (e) { log(`Yahoo ${sym}: ${e.message}`); }
  }
  // ---- BYMA: balances presentados (fechas de cierre y de presentación)
  for (const c of lista.filter(c => !c.adr).slice(0, 3)) {
    try {
      const r = await fetchImpl("https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/bnown/seriesHistoricas/balances", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ symbol: c.s }) });
      const txt = await r.text();
      log(`\nBYMA balances ${c.s}: HTTP ${r.status} ${txt.length} bytes: ${txt.slice(0, 1200)}`);
    } catch (e) { log(`BYMA balances ${c.s}: ${e.message}`); }
  }
}

export async function main({ fetchImpl = globalThis.fetch, log = console.log, secUA = process.env.SEC_UA || "tradingweb research@example.com", modo = process.env.MODO || "diario" } = {}) {
  if (modo === "diagnostico" || modo === "diario") return diagnostico({ fetchImpl, log, secUA, solo: process.env.SOLO ? process.env.SOLO.split(",") : null });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().then(() => {}, e => { console.error(e); process.exit(1); });
