// Arma multiples.json: P/E histórico semanal del S&P 500, de sus 11 sectores GICS y de cada subindustria con al
// menos 3 empresas, contable y normalizado. También actualiza spx.json (composición actual del índice).
// También escribe eps_ttm.json: el último EPS de 12 meses y las acciones de cada empresa, para que el screener calcule
// el P/E de cada una y el del índice con precios en vivo y la misma fórmula (al cierre, los dos números coinciden).
// Corre en GitHub Actions cada día hábil después del cierre de Nueva York (.github/workflows/multiples.yml).
//
// Cómo se calcula: P/E del grupo = suma de capitalizaciones / suma de ganancias de 12 meses, semana a semana.
//   capitalización = precio semanal (Yahoo, ajustado por splits) x acciones diluidas del último trimestre (EDGAR)
//   ganancias      = EPS de 12 meses (EDGAR, el mismo que usa P/E histórico) x esas acciones
// Las pérdidas restan, como en el EPS del índice que publica S&P. Se usan las empresas que están HOY en el índice
// (no la composición de cada fecha): hacia atrás hay sesgo de supervivencia.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { rawFromFacts, makeSplitFactor, gaapQuarterly, normalizedQuarterly, sharesQuarterly, mergeRaw, netIncomeQuarterly, cashDebt, PREDECESSOR_CIK, EPS_PER_SHARE_DIV } from "../backend/edgar.mjs";
import { yahooSession } from "./fundamentals.mjs";

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

// EPS de 12 meses por semana: suma de los últimos 4 trimestres con cierre anterior a la semana (como P/E histórico).
// Si el último trimestre cerró hace más de 200 días, el dato está viejo (la empresa cambió de etiqueta o la SEC no
// cargó sus presentaciones): esa semana la empresa no entra.
const STALE_DAYS = 200;
function ttmByWeek(quarters, weeks) {
  const q = quarters.slice().sort((a, b) => a.date - b.date), out = new Map();
  let j = 0;
  for (const w of weeks) {
    const t = MONDAY0 + w * WEEK + 4 * DAY;             // viernes de esa semana
    while (j < q.length && q[j].date <= t) j++;
    if (j < 4) continue;
    if (t - q[j - 1].date > STALE_DAYS * DAY) continue;
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

// Trimestres de Yahoo (EPS diluido contable) donde la SEC no tiene dato: los que todavía no cargó (10-Q presentado y no
// procesado, o resultado anunciado y 10-Q pendiente) y los huecos (un cuarto trimestre que no se puede derivar porque
// el 10-K no trae el EPS en la base, como en las eléctricas que presentan con sus controladas). Se usa la serie de
// Yahoo (operaciones continuas o total) que coincide con la SEC en el último trimestre que tienen los dos (±20%); si
// ninguna coincide, no se completa (otra unidad u otra definición).
function fillGaps(quarters, extra) {
  const series = (Array.isArray(extra) ? [extra] : [extra?.cont, extra?.tot]).filter(x => x?.length);
  if (!series.length) return { q: quarters, filled: [] };
  const near = t => quarters.find(x => Math.abs(x.date - t) <= 10 * DAY);
  let match = null, overlap = false;
  for (const ys of series) {
    const ov = [...ys].reverse().find(y => near(y.date));
    if (!ov) continue;
    overlap = true;
    const q = near(ov.date);
    if (Math.abs(ov.eps - q.eps) <= 0.2 * Math.max(Math.abs(q.eps), 0.05)) { match = ys; break; }
  }
  // sin ningún trimestre en común (la SEC dejó de tener datos hace años, como BRK) se usa la primera serie
  const pick = match || (overlap ? null : series[0]);
  if (!pick) return { q: quarters, filled: [], rejected: true };
  const add = pick.filter(y => !near(y.date));
  return { q: [...quarters, ...add.map(x => ({ date: x.date, eps: x.eps, src: "yahoo" }))].sort((a, b) => a.date - b.date), filled: add };
}

// series de una empresa: precio, EPS de 12 meses (contable y normalizado) y acciones, por semana.
// Si EDGAR no trae EPS trimestral (V, KKR, ABNB... lo informan por clase de acción o con etiquetas propias), se usa
// el resultado neto con las acciones de hoy (capitalización / precio de fundamentals.json): sin normalizado.
// extra: trimestres de Yahoo para completar después del último de la SEC.
export function companySeries({ sym = "", facts, chart, olderFacts = null, fundRow = null, extra = null }) {
  const ts = chart?.timestamp || [], cl = chart?.indicators?.quote?.[0]?.close || [];
  const price = new Map();
  ts.forEach((t, i) => { if (cl[i] != null && cl[i] > 0) price.set(weekOf(t), cl[i]); });
  const splits = Object.values(chart?.events?.splits || {}).map(s => ({ date: s.date, ratio: s.numerator / s.denominator })).filter(s => s.ratio > 0 && isFinite(s.ratio));
  const raw = mergeRaw(rawFromFacts(facts), olderFacts ? rawFromFacts(olderFacts) : null);
  // BRK informa el EPS por acción clase A; el precio es el de la B (1 A = 1.500 B)
  if (EPS_PER_SHARE_DIV[sym]) raw.eps = raw.eps.map(e => ({ ...e, val: e.val / EPS_PER_SHARE_DIV[sym] }));
  const f = makeSplitFactor(splits);
  const gaap = gaapQuarterly(raw, f, "");
  const weeks = [...price.keys()].sort((a, b) => a - b);
  // datos que no pueden ser ciertos (EPS de 12 meses mayor que el precio, o una pérdida de más de 3 veces el precio):
  // casi siempre son un split sin ajustar o una unidad mal cargada; esa semana la empresa no entra en el agregado
  const clean = (eps) => { for (const [w, e] of eps) { const p = price.get(w); if (p && (e > p || e < -3 * p)) eps.delete(w); } return eps; };
  const base = { price, splits: splits.length };
  const ni = netIncomeQuarterly(raw);
  // sin EPS trimestral, o con el EPS cortado hace años mientras el resultado neto sigue (BRK dejó de etiquetar el
  // EPS en 2014): resultado neto con las acciones de hoy
  const epsCut = gaap.length >= 4 && ni.length >= 4 && ni[ni.length - 1].date - gaap[gaap.length - 1].date > STALE_DAYS * DAY;
  if (gaap.length < 4 || epsCut) {
    const shNow = fundRow && fundRow.mc > 0 && fundRow.p > 0 ? fundRow.mc / fundRow.p : null;
    const epsLike = shNow && ni.length >= 4 ? ni.map(q => ({ date: q.date, eps: q.ni / shNow })) : [];
    const fl = shNow ? fillGaps(epsLike, extra) : { q: [], filled: [] };
    if (fl.q.length < 4) return { ...base, eG: new Map(), eN: new Map(), sh: new Map(), quarters: 0 };
    const shMap = new Map(weeks.map(w => [w, shNow]));
    return { ...base, eG: clean(ttmByWeek(fl.q, weeks)), eN: new Map(), sh: shMap, quarters: fl.q.length, viaNI: epsLike.length > 0, cd: cashDebt(raw, null),
      lastQ: fl.q[fl.q.length - 1].date, filled: fl.filled, fillRejected: !!fl.rejected };
  }
  const normFull = normalizedQuarterly(raw, f, gaap, sym), norm = normFull.eps;
  const sh = sharesQuarterly(raw, f, gaap);
  const fl = fillGaps(gaap, extra);
  // hueco en los últimos dos años (un trimestre que no se pudo derivar): se busca en Yahoo
  const rec = gaap.filter(q => q.date > gaap[gaap.length - 1].date - 730 * DAY);
  const hole = rec.some((q, i) => i > 0 && q.date - rec[i - 1].date > 120 * DAY);
  // para revisar el normalizado: los ajustes y la cuenta de los últimos trimestres
  const normDiag = { metodo: normFull.method, armado: normFull.armado, accionesInformadas: normFull.accionesInformadas,
    ajustes: (normFull.adj || []).slice(-6), margenes: (normFull.flags || []).slice(-3), trimestres: (normFull.rows || []).slice(-4),
    crudo: Object.fromEntries(["oi", "pt", "ni"].map(k => [k, (raw[k] || []).filter(e => e.end >= "2024-06-30").sort((a, b) => a.end.localeCompare(b.end) || a.start.localeCompare(b.start))
      .map(e => [e.start, e.end, e.val, e.form, e.filed])])) };
  return { ...base, eG: clean(ttmByWeek(fl.q, weeks)), eN: clean(ttmByWeek(norm, weeks)), sh: sharesByWeek(sh, weeks), quarters: gaap.length, normDiag,
    cd: cashDebt(raw, normFull.rows),
    lastQ: fl.q[fl.q.length - 1].date, lastSec: gaap[gaap.length - 1].date, hole, filled: fl.filled, fillRejected: !!fl.rejected };
}

// EPS diluido trimestral de Yahoo (fundamentals-timeseries): operaciones continuas y total, por separado
async function yahooQuarterlyEPS(fetchImpl, sym, session, nowS) {
  const types = "quarterlyDilutedContinuousOperations,quarterlyDilutedEPS";
  const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}`
    + `&type=${types}&period1=${nowS - 3 * 365 * DAY}&period2=${nowS + DAY}` + (session ? `&crumb=${encodeURIComponent(session.crumb)}` : "");
  const j = await getJSON(fetchImpl, url, { "User-Agent": UA, "Accept": "application/json", ...(session ? { Cookie: session.cookie } : {}) }, 2);
  const res = j?.timeseries?.result || [];
  const pick = type => {
    const r = res.find(x => x?.meta?.type?.[0] === type);
    return (r?.[type] || []).filter(x => x && x.asOfDate && isFinite(x.reportedValue?.raw) && (!x.currencyCode || x.currencyCode === "USD") && (!x.periodType || x.periodType === "3M"))
      .map(x => ({ date: Math.floor(Date.parse(x.asOfDate + "T00:00:00Z") / 1000), eps: +x.reportedValue.raw }));
  };
  return { cont: pick("quarterlyDilutedContinuousOperations").sort((a, b) => a.date - b.date), tot: pick("quarterlyDilutedEPS").sort((a, b) => a.date - b.date) };
}

// P/E de cada grupo por semana. cos: { sym: series } ; groups: { key: [syms] }
// tasa real a 10 años (bono del Tesoro indexado, TIPS; FRED DFII10) por semana: el último dato de cada semana, y en las
// semanas sin dato (feriados) el anterior. Sirve para comparar el rendimiento de las ganancias (1 / P/E) con la tasa real.
export const FRED_REAL10 = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10";
// Respaldo: la curva real oficial del Tesoro (un CSV por año, columna "10 YR"); es la misma tasa que publica la Fed (H.15).
const TREAS_REAL = y => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_real_yield_curve&field_tdr_date_value=${y}&page&_format=csv`;
async function realObs(fetchImpl, fromYear, toYear) {
  const obs = [];   // [fecha ISO, tasa]
  try {
    const r = await fetchImpl(FRED_REAL10, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("FRED " + r.status);
    for (const line of (await r.text()).split(/\r?\n/).slice(1)) {
      const [d, v] = line.split(","), x = parseFloat(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d || "") && isFinite(x)) obs.push([d, x]);
    }
    if (obs.length) return { obs, fuente: "FRED DFII10" };
  } catch (e) { /* al respaldo */ }
  for (let y = fromYear; y <= toYear; y++) {
    const r = await fetchImpl(TREAS_REAL(y), { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`Tesoro ${y}: ${r.status}`);
    const lines = (await r.text()).trim().split(/\r?\n/), head = lines[0].split(",").map(h => h.replace(/"/g, "").trim());
    const iD = head.indexOf("Date"), i10 = head.indexOf("10 YR");
    if (iD < 0 || i10 < 0) throw new Error(`Tesoro ${y}: columnas ${head.join("|")}`);
    for (const line of lines.slice(1)) {
      const c = line.split(",").map(x => x.replace(/"/g, "").trim()), m = (c[iD] || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/), x = parseFloat(c[i10]);
      if (m && isFinite(x)) obs.push([`${m[3]}-${m[1]}-${m[2]}`, x]);
    }
  }
  return obs.length ? { obs, fuente: "Tesoro de EE.UU., curva real (10 años)" } : null;
}
export async function realYieldByWeek(fetchImpl, weeks) {
  const yr = w => new Date((MONDAY0 + w * WEEK) * 1000).getUTCFullYear();
  const got = await realObs(fetchImpl, yr(weeks[0]), yr(weeks[weeks.length - 1]));
  if (!got) return null;
  const last = new Map(); let asOf = null;
  for (const [d, x] of got.obs.sort((a, b) => a[0].localeCompare(b[0]))) {
    last.set(weekOf(Date.parse(d + "T00:00:00Z") / 1000), x);
    asOf = d;
  }
  let prev = null;
  const out = weeks.map(w => { if (last.has(w)) prev = last.get(w); return prev == null ? null : +prev.toFixed(2); });
  return { r: out, asOf, fuente: got.fuente };
}

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
  const cos = {}, missing = [], viaNI = [], conYahoo = [], yahooRechazado = [];
  // sesión de Yahoo para los trimestres que la SEC todavía no tiene (si falla, se sigue sin completar)
  let ySession = null, yOk = true, yErr = 0;
  const yDiag = {};
  try { ySession = await yahooSession(fetchImpl); } catch (e) { log("Yahoo (sesión): " + e.message); }
  await mapLimit(list, concurrency, async (c, k) => {
    try {
      const [facts, cj, olderFacts] = await Promise.all([
        secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`),
        getJSON(fetchImpl, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(c.s)}?period1=${p1}&period2=${p2}&interval=1wk&events=splits`, { "User-Agent": UA, "Accept": "application/json" }),
        PREDECESSOR_CIK[c.s] ? secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${PREDECESSOR_CIK[c.s]}.json`) : null,
      ]);
      const chart = cj?.chart?.result?.[0];
      if (!facts || !chart) { missing.push(c.s + (facts ? " (sin precios)" : " (sin EDGAR)")); return; }
      let ser = companySeries({ sym: c.s, facts, chart, olderFacts, fundRow: fund[c.s] });
      // sin trimestres, con el último de hace más de 100 días o con un hueco en los últimos dos años: se busca en Yahoo
      if (yOk && (ser.quarters < 4 || !ser.lastQ || p2 - ser.lastQ > 100 * DAY || ser.hole)) {
        try {
          const extra = await yahooQuarterlyEPS(fetchImpl, c.s, ySession, p2);
          const rg = a => a.length ? ` (${new Date(a[0].date * 1000).toISOString().slice(0, 10)} a ${new Date(a.at(-1).date * 1000).toISOString().slice(0, 10)})` : "";
          yDiag[c.s] = `continuas ${extra.cont.length}${rg(extra.cont)}, total ${extra.tot.length}${rg(extra.tot)}`;
          if (extra.cont.length || extra.tot.length) ser = companySeries({ sym: c.s, facts, chart, olderFacts, fundRow: fund[c.s], extra });
        } catch (e) {
          if (/HTTP 40[13]/.test(e.message)) yOk = false;
          yDiag[c.s] = "error " + e.message;
          if (yErr++ < 3) log(`Yahoo (EPS trimestral) ${c.s}: ${e.message}`);
        }
      }
      if (ser.quarters < 4) { missing.push(c.s + " (sin EPS trimestral)"); return; }
      if (ser.viaNI) viaNI.push(c.s);
      if (ser.filled?.length) conYahoo.push(c.s);
      if (ser.fillRejected) yahooRechazado.push(c.s);
      cos[c.s] = ser;
    } catch (e) { missing.push(`${c.s} (${e.message})`); }
    if (k % 50 === 49) log(`  ${k + 1}/${list.length}`);
  });
  log(`Con datos: ${Object.keys(cos).length}/${list.length}. Con resultado neto: ${viaNI.join(", ") || "ninguna"}. Faltan: ${missing.join(", ") || "ninguna"}`);
  log(`Completadas con Yahoo: ${conYahoo.length} (${conYahoo.join(", ")}). Rechazadas por no coincidir: ${yahooRechazado.join(", ") || "ninguna"}`);

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
    completadasConYahoo: conYahoo,
    yahooNoCoincide: yahooRechazado,
  };
  // las semanas son consecutivas salvo feriados largos: se guarda la lista solo si hay huecos
  if (weeks[weeks.length - 1] - weeks[0] + 1 !== weeks.length) out.weekList = weeks;
  let realErr = null;
  try {
    const ry = await realYieldByWeek(fetchImpl, weeks);
    if (ry) { out.real10 = ry.r; out.real10AsOf = ry.asOf; out.real10Fuente = ry.fuente + ": bono del Tesoro indexado por inflación (TIPS) a 10 años"; }
  } catch (e) { log("tasa real: " + e.message); realErr = e.message; }
  await writeFile(new URL("multiples.json", root), JSON.stringify(out));

  // 5) último dato de cada empresa (la semana en curso): con esto el screener rehace el P/E del índice con precios en
  //    vivo. Se exporta exactamente lo que entró en el último punto de la serie, así la cuenta es la misma.
  const lastW = weeks[weeks.length - 1], iso = t => new Date(t * 1000).toISOString().slice(0, 10);
  const ultimos = {};
  for (const c of list) {
    const s = cos[c.s]; if (!s) continue;
    const e = s.eG.get(lastW), en = s.eN.get(lastW), sh = s.sh.get(lastW), p = s.price.get(lastW);
    if (e == null || !sh) continue;
    ultimos[c.s] = [+e.toFixed(4), en != null ? +en.toFixed(4) : null, Math.round(sh), s.lastQ ? iso(s.lastQ) : null, p ? +p.toFixed(2) : null, s.filled?.length ? "sec+yahoo" : "sec"];
  }
  // trimestres completados con Yahoo, para que P/E histórico (backend) use exactamente los mismos
  const fill = {};
  for (const [sym, s] of Object.entries(cos)) if (s.filled?.length) fill[sym] = s.filled.map(q => [iso(q.date), +q.eps.toFixed(4)]);
  await writeFile(new URL("eps_ttm.json", root), JSON.stringify({
    asOf: out.asOf,
    nota: "Último EPS de 12 meses de la SEC por empresa (contable y normalizado), acciones diluidas, cierre del último trimestre presentado y precio usado en multiples.json",
    campos: ["eps12m", "eps12mNormalizado", "acciones", "ultimoTrimestre", "precio", "fuente"],
    spx: series.SPX.g.at(-1), spxN: series.SPX.n.at(-1),
    data: ultimos,
    fill,
  }));
  log(`eps_ttm.json: ${Object.keys(ultimos).length} empresas`);
  // 6) flujo de caja y deuda (12 meses y último balance) para P/FCF, EV/EBIT y deuda neta / EBITDA
  const cdOut = {};
  for (const c of list) { const d = cos[c.s]?.cd; if (d && ultimos[c.s]) cdOut[c.s] = [d.ocf, d.capex, d.sbc, d.da, d.ebit, d.debt, d.cash, d.nci, d.pref, d.fin, d.bal]; }
  await writeFile(new URL("caja_deuda.json", root), JSON.stringify({ asOf: out.asOf,
    nota: "Millones de US$, de la SEC. Flujos de 12 meses (últimos cuatro trimestres): flujo operativo, inversión en activo fijo (con software activado), compensación en acciones, amortizaciones, EBIT ajustado (sin extraordinarios). Último balance: deuda financiera, caja e inversiones de corto plazo, minoritarios y preferidos.",
    campos: ["flujoOperativo", "inversion", "compensacionAcciones", "amortizaciones", "ebitAjustado", "deuda", "caja", "minoritarios", "preferidos", "finFlujos", "fechaBalance"],
    data: cdOut }));
  log(`caja_deuda.json: ${Object.keys(cdOut).length} empresas`);
  const diag = { splits: {}, fechas: {}, yahoo: yDiag, tasaReal: out.real10 ? (out.real10Fuente + ", al " + out.real10AsOf) : ("sin datos: " + realErr),
    sinUltimoDato: list.filter(c => !ultimos[c.s]).map(c => c.s + (cos[c.s] ? ` (último trimestre ${cos[c.s].lastQ ? iso(cos[c.s].lastQ) : "?"}${cos[c.s].fillRejected ? ", Yahoo no coincide" : ""}${yDiag[c.s] ? ", Yahoo: " + yDiag[c.s] : ""})` : " (sin datos)")) };
  for (const s of ["AAPL", "NVDA", "AMZN", "GOOGL", "TSLA", "WMT", "AVGO", "CMG", "MSFT", "META"]) if (cos[s]) diag.splits[s] = cos[s].splits;
  // contable y normalizado que difieren más de 20% (o con distinto signo): qué se ajustó y la cuenta trimestre a trimestre
  diag.normalizado = {};
  for (const [sym, r] of Object.entries(ultimos)) {
    const [e, en] = r; if (en == null || !cos[sym]?.normDiag) continue;
    const gap = e > 0 && en > 0 ? en / e - 1 : (e > 0) !== (en > 0) ? null : 0;
    if (gap === 0 || (gap != null && Math.abs(gap) <= 0.2)) continue;
    diag.normalizado[sym] = { contable: e, normalizado: en, diferencia: gap == null ? "distinto signo" : +(gap * 100).toFixed(0) + "%", ...cos[sym].normDiag };
  }
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
