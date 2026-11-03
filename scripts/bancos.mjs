// Bancos: precio / valor libro y ROE de los bancos argentinos y de EE.UU. (bancos.json).
// Por ahora solo el modo diagnóstico: qué trae cada fuente, para elegir con qué armar las series.
import { pathToFileURL } from "node:url";
import { yahooSession } from "./fundamentals.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DAY = 86400;

async function getJSON(f, url, headers) {
  const r = await f(url, { headers });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) { /* no es JSON */ }
  return { status: r.status, j, txt: j ? null : txt.slice(0, 200) };
}

const TIPOS = ["StockholdersEquity", "CommonStockEquity", "TangibleBookValue", "NetIncomeCommonStockholders", "NetIncome",
  "OrdinarySharesNumber", "ShareIssued", "GoodwillAndOtherIntangibleAssets", "TotalAssets"];

export async function diagnostico({ fetchImpl = globalThis.fetch, log = console.log, secUA = process.env.SEC_UA || "tradingweb research@example.com" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  let s = null;
  try { s = await yahooSession(fetchImpl); log("Yahoo: sesión OK"); } catch (e) { log("Yahoo sesión: " + e.message); }
  const H = { "User-Agent": UA, Accept: "application/json", ...(s ? { Cookie: s.cookie } : {}) }, cr = s ? `&crumb=${encodeURIComponent(s.crumb)}` : "";
  const syms = ["GGAL", "BMA", "BBAR", "SUPV", "GGAL.BA", "BMA.BA", "BBAR.BA", "SUPV.BA", "BPAT.BA", "BHIP.BA", "VALO.BA", "JPM"];
  for (const sym of syms) {
    log(`\n=== ${sym}`);
    // fundamentos trimestrales, anuales y de 12 meses
    const types = ["quarterly", "annual", "trailing"].flatMap(p => TIPOS.map(t => p + t)).join(",");
    try {
      const { status, j, txt } = await getJSON(fetchImpl, `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types}&period1=946684800&period2=${now + DAY}${cr}`, H);
      if (!j) { log(`timeseries HTTP ${status}: ${txt}`); }
      else for (const r of j?.timeseries?.result || []) {
        const t = r?.meta?.type?.[0], a = (r[t] || []).filter(Boolean);
        if (!a.length) continue;
        const l = a[a.length - 1];
        log(`  ${t}: ${a.length} datos, ${a[0].asOfDate} a ${l.asOfDate}, ${l.currencyCode || "-"} ${l.periodType || ""}, último ${l.reportedValue?.raw}` + (a.length > 1 ? `, anterior ${a[a.length - 2].asOfDate} ${a[a.length - 2].reportedValue?.raw}` : ""));
      }
    } catch (e) { log("timeseries: " + e.message); }
    // estadísticas clave
    try {
      const { status, j } = await getJSON(fetchImpl, `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=defaultKeyStatistics,financialData,price${cr}`, H);
      const q = j?.quoteSummary?.result?.[0];
      if (!q) log(`quoteSummary HTTP ${status}`);
      else {
        const v = o => o?.raw ?? o ?? null;
        log(`  quoteSummary: precio ${v(q.price?.regularMarketPrice)} ${q.price?.currency}, cap ${v(q.price?.marketCap)}, bookValue ${v(q.defaultKeyStatistics?.bookValue)}, P/B ${v(q.defaultKeyStatistics?.priceToBook)}, acciones ${v(q.defaultKeyStatistics?.sharesOutstanding)}, ROE ${v(q.financialData?.returnOnEquity)}, moneda contable ${q.financialData?.financialCurrency}, último trimestre ${v(q.defaultKeyStatistics?.mostRecentQuarter)}`);
      }
    } catch (e) { log("quoteSummary: " + e.message); }
    // historia de precios semanal
    try {
      const { status, j } = await getJSON(fetchImpl, `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=max&interval=1wk`, { "User-Agent": UA });
      const c = j?.chart?.result?.[0], ts = c?.timestamp || [];
      log(ts.length ? `  precios semanales: ${ts.length}, desde ${new Date(ts[0] * 1000).toISOString().slice(0, 10)}, moneda ${c.meta?.currency}` : `  precios: HTTP ${status}`);
    } catch (e) { log("chart: " + e.message); }
  }
  // EDGAR: los ADR presentan el 20-F con NIIF (ifrs-full)
  try {
    const t = await (await fetchImpl("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": secUA } })).json();
    const cik = Object.fromEntries(Object.values(t).map(x => [x.ticker, String(x.cik_str).padStart(10, "0")]));
    for (const sym of ["GGAL", "BMA", "BBAR", "SUPV", "BPAT", "BHIP"]) {
      log(`\n=== EDGAR ${sym} (CIK ${cik[sym] || "no está"})`);
      if (!cik[sym]) continue;
      await new Promise(r => setTimeout(r, 300));
      const r = await fetchImpl(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik[sym]}.json`, { headers: { "User-Agent": secUA, Accept: "application/json" } });
      if (!r.ok) { log("  companyfacts HTTP " + r.status); continue; }
      const j = await r.json();
      log("  taxonomías: " + Object.keys(j.facts || {}).join(", "));
      for (const [tax, tags] of Object.entries(j.facts || {})) for (const [tag, o] of Object.entries(tags)) {
        if (!/^(Equity|EquityAttributableToOwnersOfParent|ProfitLoss|ProfitLossAttributableToOwnersOfParent|NumberOfSharesOutstanding|EntityCommonStockSharesOutstanding|BasicEarningsLossPerShare|IntangibleAssetsAndGoodwill|Goodwill|IntangibleAssetsOtherThanGoodwill|StockholdersEquity|NetIncomeLoss)$/.test(tag)) continue;
        for (const [u, a] of Object.entries(o.units || {})) {
          const ends = [...new Set(a.map(e => e.end))].sort(), forms = [...new Set(a.map(e => e.form))].join("/"), l = a.slice().sort((x, y) => x.end.localeCompare(y.end) || x.filed.localeCompare(y.filed)).pop();
          const cortos = a.filter(e => e.start && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 < 200).length;
          log(`  ${tax}:${tag} [${u}] ${a.length} datos, ${ends.length} fechas ${ends[0]} a ${ends[ends.length - 1]}, formularios ${forms}, períodos cortos ${cortos}, último ${l.val} (${l.form} ${l.filed})`);
        }
      }
    }
  } catch (e) { log("EDGAR: " + e.message); }
  // BCRA: hasta qué mes está publicada la información de entidades financieras (PDF mensual)
  for (const m of ["202606", "202607", "202608", "202609"]) {
    try { const r = await fetchImpl(`https://www.bcra.gob.ar/archivos/Pdfs/PublicacionesEstadisticas/Entidades/${m}e.pdf`, { method: "HEAD", headers: { "User-Agent": UA } }); log(`BCRA entidades ${m}: HTTP ${r.status} ${r.headers.get("content-length") || ""}`); }
    catch (e) { log(`BCRA entidades ${m}: ${e.message}`); }
  }
}

export async function main({ modo = process.env.MODO || "diagnostico", log = console.log } = {}) {
  if (modo === "diagnostico") return diagnostico({ log });
  throw new Error("Modo sin implementar: " + modo);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch(e => { console.error(e); process.exit(1); });
