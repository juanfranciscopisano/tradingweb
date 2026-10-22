// Arma multiples.json: P/E histórico semanal del S&P 500, de sus 11 sectores GICS y de cada subindustria con al
// menos 3 empresas, contable y normalizado. También actualiza spx.json (composición actual del índice).
// Corre en GitHub Actions una vez por semana (.github/workflows/multiples.yml).
//
// Cómo se calcula: P/E del grupo = suma de capitalizaciones / suma de ganancias de 12 meses, semana a semana.
//   capitalización = precio semanal (Yahoo, ajustado por splits) x acciones diluidas del último trimestre (EDGAR)
//   ganancias      = EPS de 12 meses (EDGAR, el mismo que usa P/E histórico) x esas acciones
// Las pérdidas restan, como en el EPS del índice que publica S&P. Se usan las empresas que están HOY en el índice
// (no la composición de cada fecha): hacia atrás hay sesgo de supervivencia.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { rawFromFacts, makeSplitFactor, gaapQuarterly, normalizedQuarterly, sharesQuarterly, mergeRaw, netIncomeQuarterly, PREDECESSOR_CIK } from "../backend/edgar.mjs";

const CSV_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const GICS = {
  "Information Technology": "Technology", "Financials": "Financial Services", "Health Care": "Healthcare",
  "Consumer Discretionary": "Consumer Cyclical", "Communication Services": "Communication Services", "Industrials": "Industrials",
  "Consumer Staples": "Consumer Defensive", "Energy": "Energy", "Materials": "Basic Materials", "Real Estate": "Real Estate", "Utilities": "Utilities",
};
const DAY = 86400, WEEK = 7 * DAY;
const MONDAY0 = Date.UTC(1990, 0, 1) / 1000;          // lunes: las semanas se cuentan desde acá
export const weekOf = t => Math.floor((t - MONDAY0) / WEEK);
const MIN_SUB = 3;                                     // empresas mínimas para publicar una subindustria

export function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.length > 1 || row[0]) rows.push(row); row = []; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || "").trim()])));
}

export function constituents(csvText) {
  return parseCSV(csvText).filter(r => r.Symbol && GICS[r["GICS Sector"]]).map(r => ({
    s: r.Symbol.replace(/\./g, "-"), n: r.Security, sec: GICS[r["GICS Sector"]], gics: r["GICS Sector"],
    sub: r["GICS Sub-Industry"], cik: String(r.CIK).padStart(10, "0"),
  })).sort((a, b) => a.s.localeCompare(b.s));
}

// EPS de 12 meses por semana: suma de los últimos 4 trimestres con cierre anterior a la semana (como P/E histórico)
function ttmByWeek(quarters, weeks) {
  const q = quarters.slice().sort((a, b) => a.date - b.date), out = new Map();
  let j = 0;
  for (const w of weeks) {
    const t = MONDAY0 + w * WEEK + 4 * DAY;             // viernes de esa semana
    while (j < q.length && q[j].date <= t) j++;
    if (j < 4) continue;
    // los 4 trimestres tienen que ser consecutivos (sin huecos de más de ~4 meses entre sí)
    if (q[j - 1].date - q[j - 4].date > 300 * DAY) continue;
    out.set(w, q[j - 1].eps + q[j - 2].eps + q[j - 3].eps + q[j - 4].eps);
  }
  return out;
}
function sharesByWeek(sh, weeks) {
  const out = new Map(); let j = 0;
  for (const w of weeks) {
    const t = MONDAY0 + w * WEEK + 4 * DAY;
    while (j < sh.length && sh[j].date <= t) j++;
    const v = j > 0 ? sh[j - 1].shares : (sh[0] && sh[0].date - t < 200 * DAY ? sh[0].shares : null);
    if (v) out.set(w, v);
  }
  return out;
}

// series de una empresa: precio, EPS de 12 meses (contable y normalizado) y acciones, por semana.
// Si EDGAR no trae EPS trimestral (V, KKR, ABNB... lo informan por clase de acción o con etiquetas propias), se usa
// el resultado neto con las acciones de hoy (capitalización / precio de fundamentals.json): sin normalizado.
export function companySeries({ facts, chart, olderFacts = null, fundRow = null }) {
  const ts = chart?.timestamp || [], cl = chart?.indicators?.quote?.[0]?.close || [];
  const price = new Map();
  ts.forEach((t, i) => { if (cl[i] != null && cl[i] > 0) price.set(weekOf(t), cl[i]); });
  const splits = Object.values(chart?.events?.splits || {}).map(s => ({ date: s.date, ratio: s.numerator / s.denominator })).filter(s => s.ratio > 0 && isFinite(s.ratio));
  const raw = mergeRaw(rawFromFacts(facts), olderFacts ? rawFromFacts(olderFacts) : null);
  const f = makeSplitFactor(splits);
  const gaap = gaapQuarterly(raw, f, "");
  const weeks = [...price.keys()].sort((a, b) => a - b);
  if (gaap.length < 4) {
    const shNow = fundRow && fundRow.mc > 0 && fundRow.p > 0 ? fundRow.mc / fundRow.p : null;
    const ni = netIncomeQuarterly(raw);
    if (!shNow || ni.length < 4) return { price, eG: new Map(), eN: new Map(), sh: new Map(), quarters: 0, splits: splits.length };
    const epsLike = ni.map(q => ({ date: q.date, eps: q.ni / shNow }));
    const shMap = new Map(weeks.map(w => [w, shNow]));
    const clean = (eps) => { for (const [w, e] of eps) { const p = price.get(w); if (p && (e > p || e < -3 * p)) eps.delete(w); } return eps; };
    return { price, eG: clean(ttmByWeek(epsLike, weeks)), eN: new Map(), sh: shMap, quarters: ni.length, splits: splits.length, viaNI: true };
  }
  const norm = normalizedQuarterly(raw, f, gaap, "").eps;
  const sh = sharesQuarterly(raw, f, gaap);
  // datos que no pueden ser ciertos (EPS de 12 meses mayor que el precio, o una pérdida de más de 3 veces el precio):
  // casi siempre son un split sin ajustar o una unidad mal cargada; esa semana la empresa no entra en el agregado
  const clean = (eps) => { for (const [w, e] of eps) { const p = price.get(w); if (p && (e > p || e < -3 * p)) eps.delete(w); } return eps; };
  return { price, eG: clean(ttmByWeek(gaap, weeks)), eN: clean(ttmByWeek(norm, weeks)), sh: sharesByWeek(sh, weeks), quarters: gaap.length, splits: splits.length };
}

// P/E de cada grupo por semana. cos: { sym: series } ; groups: { key: [syms] }
export function aggregate(cos, groups, weeks, minCov) {
  // peso de cobertura: capitalización de la última semana con dato de cada empresa
  const capNow = {};
  for (const [s, c] of Object.entries(cos)) {
    for (let k = weeks.length - 1; k >= 0; k--) { const w = weeks[k]; if (c.price.has(w) && c.sh.has(w)) { capNow[s] = c.price.get(w) * c.sh.get(w); break; } }
  }
  const out = {};
  for (const [key, syms] of Object.entries(groups)) {
    const members = syms.filter(s => cos[s] && capNow[s]);
    const totCap = members.reduce((a, s) => a + capNow[s], 0);
    const g = [], n = [];
    for (const w of weeks) {
      let M = 0, E = 0, cov = 0, Mn = 0, En = 0, covN = 0;
      for (const s of members) {
        const c = cos[s], p = c.price.get(w), sh = c.sh.get(w);
        if (p == null || sh == null) continue;
        const eg = c.eG.get(w), en = c.eN.get(w);
        if (eg != null) { M += p * sh; E += eg * sh; cov += capNow[s]; }
        if (en != null) { Mn += p * sh; En += en * sh; covN += capNow[s]; }
      }
      const req = totCap * (typeof minCov === "function" ? minCov(key) : minCov);
      g.push(E > 0 && cov >= req ? +(M / E).toFixed(1) : null);
      n.push(En > 0 && covN >= req ? +(Mn / En).toFixed(1) : null);
    }
    out[key] = { g, n, count: members.length };
  }
  return out;
}

async function getJSON(fetchImpl, url, headers, tries = 4) {
  for (let a = 0; ; a++) {
    try {
      const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetchImpl(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(tm));
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (a >= tries - 1) throw e;
      await new Promise(res => setTimeout(res, 1500 * (a + 1)));
    }
  }
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

export async function main({ root = new URL("../", import.meta.url), fetchImpl = globalThis.fetch, now = new Date(),
  secUA = process.env.SEC_UA || "tradingweb research@example.com", log = console.log, concurrency = 4, secGapMs = 140, minCompanies = 480 } = {}) {
  // 1) composición actual
  const csv = await (await fetchImpl(CSV_URL, { headers: { "User-Agent": UA } })).text();
  const list = constituents(csv);
  if (list.length < minCompanies) throw new Error(`Composición incompleta: ${list.length} empresas`);
  await writeFile(new URL("spx.json", root), JSON.stringify({ asOf: now.toISOString().slice(0, 10), fuente: "github.com/datasets/s-and-p-500-companies (Wikipedia)", list }));
  log(`spx.json: ${list.length} empresas`);

  // 2) datos por empresa (la SEC pide no más de ~10 pedidos por segundo)
  let lastSec = 0;
  const secGet = async url => {
    for (;;) { const wait = lastSec + secGapMs - Date.now(); if (wait <= 0) break; await new Promise(r => setTimeout(r, wait)); }
    lastSec = Date.now();
    return getJSON(fetchImpl, url, { "User-Agent": secUA, "Accept": "application/json" });
  };
  let fund = {};
  try { fund = JSON.parse(await readFile(new URL("fundamentals.json", root), "utf8")).data || {}; } catch (e) { log("fundamentals.json: " + e.message); }
  const p1 = Math.floor(now.getTime() / 1000) - 30 * 365 * DAY, p2 = Math.floor(now.getTime() / 1000);
  const cos = {}, missing = [], viaNI = [];
  await mapLimit(list, concurrency, async (c, k) => {
    try {
      const [facts, cj, olderFacts] = await Promise.all([
        secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`),
        getJSON(fetchImpl, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(c.s)}?period1=${p1}&period2=${p2}&interval=1wk&events=splits`, { "User-Agent": UA, "Accept": "application/json" }),
        PREDECESSOR_CIK[c.s] ? secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${PREDECESSOR_CIK[c.s]}.json`) : null,
      ]);
      const chart = cj?.chart?.result?.[0];
      if (!facts || !chart) { missing.push(c.s + (facts ? " (sin precios)" : " (sin EDGAR)")); return; }
      const ser = companySeries({ facts, chart, olderFacts, fundRow: fund[c.s] });
      if (ser.quarters < 4) { missing.push(c.s + " (sin EPS trimestral)"); return; }
      if (ser.viaNI) viaNI.push(c.s);
      cos[c.s] = ser;
    } catch (e) { missing.push(`${c.s} (${e.message})`); }
    if (k % 50 === 49) log(`  ${k + 1}/${list.length}`);
  });
  log(`Con datos: ${Object.keys(cos).length}/${list.length}. Con resultado neto: ${viaNI.join(", ") || "ninguna"}. Faltan: ${missing.join(", ") || "ninguna"}`);

  // 3) grupos y semanas (desde la primera semana con P/E del índice)
  const seenCik = new Set();
  const uniq = list.filter(c => !seenCik.has(c.cik) && seenCik.add(c.cik));
  const groups = { SPX: uniq.map(c => c.s) };
  for (const c of uniq) {
    (groups["sec:" + c.gics] ||= []).push(c.s);
    (groups["sub:" + c.sub] ||= []).push(c.s);
  }
  for (const k of Object.keys(groups)) if (k.startsWith("sub:") && groups[k].length < MIN_SUB) delete groups[k];
  const allWeeks = new Set();
  for (const c of Object.values(cos)) for (const w of c.price.keys()) allWeeks.add(w);
  let weeks = [...allWeeks].sort((a, b) => a - b);
  const minCov = key => key === "SPX" ? 0.6 : key.startsWith("sec:") ? 0.6 : 0.5;
  let agg = aggregate(cos, groups, weeks, minCov);
  const first = agg.SPX.g.findIndex(v => v != null);
  if (first < 0) throw new Error("Sin P/E del índice: revisar EDGAR y Yahoo");
  weeks = weeks.slice(first);
  for (const v of Object.values(agg)) { v.g = v.g.slice(first); v.n = v.n.slice(first); }

  // 4) fw P/E de hoy por grupo, con fundamentals.json (capitalización / ganancias esperadas)
  const fwOf = syms => { let M = 0, E = 0; for (const s of syms) { const f = fund[s]; if (f?.mc > 0 && f?.fpe > 0) { M += f.mc; E += f.mc / f.fpe; } } return E > 0 ? +(M / E).toFixed(1) : null; };

  const series = {};
  for (const [key, v] of Object.entries(agg)) {
    const [type, name] = key === "SPX" ? ["index", "S&P 500"] : [key.startsWith("sec:") ? "sector" : "sub", key.slice(4)];
    const sector = type === "sub" ? list.find(c => c.sub === name).gics : type === "sector" ? name : null;
    series[key] = { name, type, sector, count: groups[key].length, withData: v.count, fw: fwOf(groups[key]), g: v.g, n: v.n };
  }
  const out = {
    asOf: now.toISOString().slice(0, 10),
    nota: "P/E = suma de capitalizaciones / suma de ganancias de 12 meses (EDGAR), empresas actuales del índice; semanal",
    week0: weeks[0], monday0: MONDAY0, weeks: weeks.length,
    series,
    sinDatos: missing,
    conResultadoNeto: viaNI,
  };
  // las semanas son consecutivas salvo feriados largos: se guarda la lista solo si hay huecos
  if (weeks[weeks.length - 1] - weeks[0] + 1 !== weeks.length) out.weekList = weeks;
  await writeFile(new URL("multiples.json", root), JSON.stringify(out));
  const diag = { splits: {}, fechas: {} };
  for (const s of ["AAPL", "NVDA", "AMZN", "GOOGL", "TSLA", "WMT", "AVGO", "CMG", "MSFT", "META"]) if (cos[s]) diag.splits[s] = cos[s].splits;
  for (const d of ["2019-06-24", "2021-06-28", "2024-06-24", "2025-06-23"]) {
    const w = weekOf(Date.parse(d) / 1000);
    const rows = Object.entries(cos).map(([s, c]) => {
      const p = c.price.get(w), sh = c.sh.get(w), e = c.eG.get(w), en = c.eN.get(w);
      return (p && sh) ? { s, M: p * sh / 1e9, E: e != null ? e * sh / 1e9 : null, En: en != null ? en * sh / 1e9 : null, pe: e ? p / e : null } : null;
    }).filter(Boolean);
    const top = k => rows.filter(r => r[k] != null).sort((a, b) => Math.abs(b[k]) - Math.abs(a[k])).slice(0, 12).map(r => `${r.s} M ${r.M.toFixed(0)} E ${r.E?.toFixed(1)} En ${r.En?.toFixed(1)} pe ${r.pe?.toFixed(1)}`);
    diag.fechas[d] = { M: top("M"), E: top("E"), En: top("En") };
  }
  await writeFile(new URL("multiples_diag.json", root), JSON.stringify(diag, null, 1));
  const at = d => { const w = weekOf(Date.parse(d) / 1000); const i = weeks.indexOf(w); return i >= 0 ? series.SPX.g[i] : null; };
  log(`S&P 500 P/E contable: 2010 ${at("2010-12-27")}, 2015 ${at("2015-12-28")}, 2019 ${at("2019-12-30")}, 2021 ${at("2021-12-27")}, 2022 ${at("2022-12-26")}, hoy ${series.SPX.g.at(-1)} (normalizado ${series.SPX.n.at(-1)}, fw ${series.SPX.fw})`);
  log(`Series: ${Object.keys(series).length}, semanas: ${weeks.length}`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
