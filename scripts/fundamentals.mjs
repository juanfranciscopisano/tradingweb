// Arma fundamentals.json (P/E, fw P/E, P/B y market cap) para el Screener, el Heatmap, Cartera y P/E Hist.
// Corre en GitHub Actions una vez por día (.github/workflows/fundamentals.yml).
//   1) Yahoo v7/quote con cookie + crumb pedidos desde la IP del runner (cambia en cada corrida).
//   2) Lo que Yahoo no trae: Finnhub /stock/metric (60 llamadas/min en el plan gratis).
//   3) Lo que ninguna trae hoy: se arrastra del archivo anterior marcado como "stale".
// Guarda el precio de referencia (p) para que la página reescale los ratios con el precio en vivo.
import { readFile, writeFile, mkdir } from "node:fs/promises";
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

export async function yahooSession(f) {
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

// Revisiones del EPS esperado (Yahoo quoteSummary, módulo earningsTrend): para el ejercicio en curso (0y) y el
// siguiente (+1y), el consenso de hoy y el de hace 7, 30, 60 y 90 días, más cuántos analistas lo subieron o bajaron
// en los últimos 30 días. Va en revisions.json; si falla, fundamentals.json sale igual.
const TREND_LAGS = ["current", "7daysAgo", "30daysAgo", "60daysAgo", "90daysAgo"];
export function parseTrend(j) {
  const tr = j?.quoteSummary?.result?.[0]?.earningsTrend?.trend || [];
  const raw = v => (v && typeof v === "object" ? num(v.raw) : num(v));
  const per = k => tr.find(t => t.period === k);
  const pack = t => t ? TREND_LAGS.map(l => { const v = raw(t.epsTrend?.[l]); return v == null ? null : +v.toFixed(4); }) : null;
  const y0 = per("0y"), y1 = per("+1y");
  if (!y0 && !y1) return null;
  // trimestre en curso y siguiente (cierre, EPS esperado) y los últimos EPS informados: para el EPS de 12 meses por trimestres
  const qq = t => { if (!t || !t.endDate) return null; const v = raw(t.epsTrend?.current) ?? raw(t.earningsEstimate?.avg); return v == null ? null : [t.endDate, +v.toFixed(4)]; };
  const hist = (j?.quoteSummary?.result?.[0]?.earningsHistory?.history || []).map(h => [h.quarter?.fmt || null, raw(h.epsActual), raw(h.epsEstimate)]).filter(h => h[0] && h[1] != null);
  // crecimiento anual esperado a 5 años (Yahoo, "+5y"): extiende el consenso más allá del ejercicio siguiente (Fw P/E a 2 años)
  const g5 = raw(per("+5y")?.growth);
  const e = { f0: y0?.endDate || null, t0: pack(y0), f1: y1?.endDate || null, t1: pack(y1), ...(g5 != null && isFinite(g5) ? { g5: +g5.toFixed(4) } : {}),
    up: raw(y1?.epsRevisions?.upLast30days), dn: raw(y1?.epsRevisions?.downLast30days), n: raw(y1?.earningsEstimate?.numberOfAnalysts),
    q0: qq(per("0q")), q1: qq(per("+1q")), h: hist };
  return (e.t0?.[0] != null || e.t1?.[0] != null) ? e : null;
}

// EPS de consenso de los próximos 12 meses, por trimestres: cada trimestre del ejercicio en curso y del siguiente pesa
// por la parte que cae entre hoy y dentro de un año. Los dos trimestres que estima Yahoo (en curso y siguiente) van
// con su estimación. Lo que queda de cada ejercicio (consenso del año − trimestres estimados − trimestres ya informados)
// se reparte entre los trimestres que faltan con la estacionalidad del mismo trimestre un año antes: proporcional si
// todos son positivos y ninguno casi cero, y si no (trimestres con pérdida) se le suma a cada uno la misma diferencia. La estacionalidad
// sale del EPS que esperaba el consenso antes de cada resultado, no del informado, para que no entren extraordinarios.
// Repartir parejo sería peor que no usar trimestres: tomaría la estacionalidad de los dos trimestres estimados y no la
// de los demás. Lo que pasa del ejercicio siguiente (pocas semanas) va con el mismo trimestre un año antes por el
// crecimiento del año (acotado a 0,8–1,25 veces). Un trimestre con un extraordinario en el consenso del año anterior se
// cambia por el de dos años antes (ver abajo). Si falta algo (sin trimestres, sin el informado o la estacionalidad de un
// trimestre) o un informado que se resta no está en la base del consenso (sorpresa de más de 50%: suele ser contable
// con un extraordinario), se ponderan los dos ejercicios por tiempo. La misma función está en index.html (ntmFrom).
export function ntmFrom(r, now, k = 1) {
  if (!r) return null;
  // k = 1: los 12 meses que arrancan en now; k = 2: los 12 meses siguientes (now es el corte de lo ya informado). Si now
  // es un fin de mes (el cierre del último trimestre presentado), la ventana va de fin de mes a fin de mes, así no se
  // pierde un día en los años bisiestos
  const DAYMS = 86400000, T = now, P = s => Date.parse(s + "T00:00:00Z");
  const eom = (t, m) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m + 1, 0); };
  const atEom = now % DAYMS === 0 && new Date(now + DAYMS).getUTCDate() === 1;
  const A = atEom ? eom(now, 12 * (k - 1)) : now + (k - 1) * 365 * DAYMS, T1 = atEom ? eom(now, 12 * k) : now + k * 365 * DAYMS;
  const t0 = r.t0 || [], t1 = r.t1 || [];
  // crecimiento para lo que pasa del ejercicio siguiente (Yahoo no da consenso más allá): el esperado a 5 años de los
  // analistas (g5, acotado a −10% y +40%); sin ese dato, el del ejercicio siguiente contra el en curso, acotado a 0,8–1,25
  const g = r.g5 != null && isFinite(r.g5) ? 1 + Math.min(0.4, Math.max(-0.1, r.g5))
    : r.f0 && t0[0] != null && t0[0] > 0 && t1[0] > 0 ? Math.min(1.25, Math.max(0.8, t1[0] / t0[0])) : 1;
  const blend = () => {
    if (k > 1) {   // segundo año: lo que cae en el ejercicio siguiente con su consenso, lo que pasa con el crecimiento
      const f1 = r.f1 ? P(r.f1) : null, w1 = f1 ? Math.min(1, Math.max(0, (f1 - A) / (365.25 * DAYMS))) : 0, v = t1[0];
      return v == null ? null : { eps: w1 * v + (1 - w1) * v * (v > 0 ? g : 1), metodo: "ejercicios" };
    }
    const f0 = r.f0 ? P(r.f0) : null, w = f0 ? Math.min(1, Math.max(0, (f0 - T) / (365.25 * DAYMS))) : 0;
    if (t0[0] != null && t1[0] != null) return { eps: w * t0[0] + (1 - w) * t1[0], metodo: "ejercicios" };
    const v = t1[0] ?? t0[0]; return v == null ? null : { eps: v, metodo: "ejercicios" };
  };
  if (!r.f1 || t1[0] == null || !(r.q0 || r.q1)) return blend();
  const endOfMonth = (t, m) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m + 1, 0); };
  const near = (a, b) => Math.abs(a - b) <= 20 * DAYMS, find = (L, t) => L.find(x => near(x.t, t));
  const known = [r.q0, r.q1].filter(q => q && q[1] != null).map(q => ({ t: P(q[0]), v: q[1] }));
  const hist = (r.h || []).map(h => ({ t: P(h[0]), v: h[1], e: h[2] ?? null }));
  const done = [];   // trimestres ya resueltos, para la estacionalidad del ejercicio siguiente
  const shape = t => { const k = find(known, t); if (k) return k.v; const h = find(hist, t); if (h) return h.e ?? h.v; const c = find(done, t); return c ? c.v : null; };
  // proporcional si todos son positivos y ninguno es casi cero (menos de un cuarto del promedio: un piso que se recupera,
  // INTC con 0,01 en el primer trimestre de 2026, haría crecer ese trimestre como el año entero); si no, la misma suma
  const spread = (rest, s) => {
    const S = s.reduce((a, b) => a + b, 0), m = S / s.length;
    return s.every(x => x > 0.25 * m) && rest > 0 ? s.map(x => rest * x / S) : s.map(x => x + (rest - S) / s.length);
  };
  const years = [];
  if (r.f0 && t0[0] != null) years.push({ f: P(r.f0), E: t0[0] });
  years.push({ f: P(r.f1), E: t1[0] });
  for (const y of years) {
    const qs = [-9, -6, -3, 0].map(m => ({ t: endOfMonth(y.f, m), start: endOfMonth(y.f, m - 3) }));
    let rest = y.E, missingPast = false, suspect = false; const unk = [];
    for (const q of qs) {
      const k = find(known, q.t);
      if (k) { q.v = k.v; rest -= k.v; continue; }
      if (q.t <= T) {
        const h = find(hist, q.t);
        if (!h) { missingPast = true; continue; }
        q.v = h.v; rest -= h.v;
        if (h.e != null && Math.abs(h.v - h.e) > Math.max(0.5 * Math.abs(h.e), 0.1)) suspect = true;
        continue;
      }
      unk.push(q);
    }
    if (unk.length) {
      if (missingPast || suspect) return blend();
      const s = unk.map(q => shape(endOfMonth(q.t, -12)));
      if (s.some(x => x == null)) return blend();
      // un trimestre del año anterior con un cargo dentro del consenso (VRTX: I+D comprada en el de septiembre) no es
      // estacionalidad: si cayó a menos de 0,4 veces el mismo trimestre dos años antes y otro trimestre se movió poco
      // (0,67–1,5), va el de dos años antes por el crecimiento de los que se movieron poco. Solo caídas: los saltos para
      // arriba suelen ser compras de empresas o una base estacional baja (NRG), y el consenso casi nunca suma ganancias.
      const pr = unk.map(q => shape(endOfMonth(q.t, -24))), ra = s.map((x, i) => pr[i] > 0 ? x / pr[i] : null);
      const ok = ra.filter(x => x != null && x >= 2 / 3 && x <= 1.5).sort((a, b) => a - b);
      if (ok.length) { const m = ok[ok.length >> 1]; ra.forEach((x, i) => { if (x != null && x < 0.4) s[i] = pr[i] * m; }); }
      // sin el de dos años antes: una pérdida entre tres trimestres positivos y parejos (±35%) del mismo año es un
      // extraordinario (GILD: I+D comprada en el segundo trimestre de 2026); va el promedio de los otros tres
      unk.forEach((q, i) => {
        if (!(s[i] <= 0) || pr[i] != null && pr[i] <= 0) return;
        const o = [-9, -6, -3, 0].map(m => shape(endOfMonth(y.f, m - 12))).filter((v, k) => !near(endOfMonth(y.f, [-9, -6, -3, 0][k] - 12), endOfMonth(q.t, -12)));
        if (o.length !== 3 || o.some(v => v == null || v <= 0)) return;
        const m = (o[0] + o[1] + o[2]) / 3;
        if (o.every(v => Math.abs(v / m - 1) <= 0.35)) s[i] = m;
      });
      spread(rest, s).forEach((v, i) => { unk[i].v = v; });
    }
    done.push(...qs);
  }
  // lo que pasa del ejercicio siguiente: el mismo trimestre un año antes por el crecimiento (g)
  const last = years[years.length - 1];
  if (T1 > last.f) for (const q of done.filter(q => q.t > last.f - 365 * DAYMS && q.t <= last.f + 10 * DAYMS))
    if (q.v != null) done.push({ t: endOfMonth(q.t, 12), start: endOfMonth(q.start, 12), v: q.v * (q.v > 0 ? g : 1) });
  let sum = 0, covered = 0;
  for (const q of done) {
    const a = Math.max(q.start, A), b = Math.min(q.t, T1);
    if (b <= a || q.v == null) continue;
    sum += q.v * (b - a) / (q.t - q.start); covered += b - a;
  }
  if (covered < 0.85 * (T1 - A)) return blend();
  return { eps: sum * (T1 - A) / covered, metodo: "trimestres" };
}
// EPS esperado de los cuatro trimestres que siguen al último presentado (lastQ, en ms; null si no se sabe), que es el EPS
// del Fw P/E de la terminal: con la regla de fechas del P/E, dentro de un año el EPS de 12 meses va a ser la suma de esos
// cuatro. Es ntmFrom desde el cierre de ese trimestre, llevado al fin de mes más cercano (ejercicios de 52 semanas). El
// último presentado es el más reciente entre lastQ y el último que informó Yahoo (r.h); sin ninguno, los 12 meses desde
// now. k = 2: los cuatro siguientes (trimestres 5 a 8), el EPS del Fw P/E a 2 años. Igual que fwQuarters en index.html.
export function next4From(r, lastQ, now, k = 1) {
  if (!r) return null;
  let t = lastQ > 0 ? lastQ : null;
  const h = r.h && r.h.length ? Date.parse(r.h[r.h.length - 1][0] + "T00:00:00Z") : null;
  if (h != null && !(t >= h)) t = h;
  if (t == null) return ntmFrom(r, now, k);
  const d = new Date(t), a = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0), b = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0);
  return ntmFrom(r, Math.abs(a - t) <= Math.abs(t - b) ? a : b, k);
}
// Estimaciones completas (base de datos propia de consenso): para el trimestre en curso y el siguiente (0q, +1q) y el
// ejercicio en curso y el siguiente (0y, +1y), EPS y ventas esperados (promedio, mínimo, máximo, el del año anterior,
// analistas); y los últimos cuatro trimestres informados con el EPS esperado antes del resultado (earningsHistory).
// El EPS de consenso y el "informado" de Yahoo están en la base ajustada de cada empresa, no en la contable.
export function parseEstimates(j) {
  const res = j?.quoteSummary?.result?.[0] || {}, tr = res.earningsTrend?.trend || [];
  const raw = v => (v && typeof v === "object" ? num(v.raw) : num(v));
  const r4 = v => v == null ? null : +v.toFixed(4), big = v => v == null ? null : Math.round(v / 1e5) / 10;   // ventas en millones
  const per = {};
  for (const k of ["0q", "+1q", "0y", "+1y"]) {
    const t = tr.find(x => x.period === k); if (!t) continue;
    const ee = t.earningsEstimate || {}, re = t.revenueEstimate || {};
    per[k] = { fin: t.endDate || null,
      eps: [r4(raw(ee.avg)), r4(raw(ee.low)), r4(raw(ee.high)), r4(raw(ee.yearAgoEps))], n: raw(ee.numberOfAnalysts),
      rev: [big(raw(re.avg)), big(raw(re.low)), big(raw(re.high)), big(raw(re.yearAgoRevenue))], nRev: raw(re.numberOfAnalysts),
      epsT: TREND_LAGS.map(l => r4(raw(t.epsTrend?.[l]))) };
    if (per[k].eps[0] == null) per[k].eps[0] = per[k].epsT[0];   // el promedio y la tendencia de hoy son el mismo número
  }
  const hist = (res.earningsHistory?.history || []).map(h => ({ q: h.quarter?.fmt || (raw(h.quarter) ? new Date(raw(h.quarter) * 1000).toISOString().slice(0, 10) : null),
    act: r4(raw(h.epsActual)), est: r4(raw(h.epsEstimate)), sorp: raw(h.surprisePercent) != null ? +raw(h.surprisePercent).toFixed(4) : null }))
    .filter(h => h.q && (h.act != null || h.est != null));
  return Object.keys(per).length || hist.length ? { per, hist } : null;
}
// agrega el día a la serie de cada empresa (estimaciones/<ticker>.json). La primera vez la arranca con el EPS de hace
// 90, 60, 30 y 7 días que da Yahoo (sin ventas), marcado como reconstruido.
export function addEstimate(prev, sym, est, today) {
  const rec = { d: today };
  for (const [k, short] of [["0q", "q0"], ["+1q", "q1"], ["0y", "y0"], ["+1y", "y1"]]) { const p = est.per[k]; if (p) rec[short] = [p.fin, p.eps[0], p.rev[0]]; }
  let serie = prev && Array.isArray(prev.serie) ? prev.serie.slice() : [];
  if (!serie.length) {
    const back = [[90, 4], [60, 3], [30, 2], [7, 1]];
    for (const [days, i] of back) {
      const d = new Date(Date.parse(today + "T00:00:00Z") - days * 86400000).toISOString().slice(0, 10), r = { d, r: 1 };
      for (const [k, short] of [["0y", "y0"], ["+1y", "y1"]]) { const p = est.per[k]; if (p && p.epsT[i] != null) r[short] = [p.fin, p.epsT[i], null]; }
      if (r.y0 || r.y1) serie.push(r);
    }
  }
  serie = serie.filter(x => x.d !== today);
  serie.push(rec);
  return { sym, asOf: today, actual: est, serie };
}
// fecha del próximo balance (Yahoo quoteSummary, módulo calendarEvents): [fecha en Nueva York, 1 si es estimada, EPS
// esperado, "a" antes de la apertura / "c" después del cierre / "d" durante la rueda, según la hora de la conferencia]
export function parseCalendar(j) {
  const ce = j?.quoteSummary?.result?.[0]?.calendarEvents?.earnings; if (!ce) return null;
  const raw = v => (v && typeof v === "object" ? num(v.raw) : num(v));
  const ds = (ce.earningsDate || []).map(x => ({ t: raw(x), f: x && typeof x === "object" && /^\d{4}-\d\d-\d\d$/.test(x.fmt || "") ? x.fmt : null })).filter(x => x.t).sort((a, b) => a.t - b.t);
  if (!ds.length) return null;
  const ny = t => new Date(t * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const est = ce.isEarningsDateEstimate === true || ds.length > 1 ? 1 : 0;
  const call = raw((ce.earningsCallDate || [])[0]);
  let hora = null;
  if (call) { const h = +new Date(call * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }); hora = h < 12 ? "a" : h >= 16 ? "c" : "d"; }
  const eps = raw(ce.earningsAverage);
  return [ds[0].f || ny(ds[0].t), est, eps == null ? null : +eps.toFixed(4), hora];
}
// earnings.json: el próximo balance de cada empresa (p) y los ya presentados (h). Cuando una fecha confirmada pasa y
// Yahoo ya muestra la siguiente, la vieja queda en el historial
export function mergeEarnings(prev, cal, today) {
  const out = {};
  for (const sym of new Set([...Object.keys(prev || {}), ...Object.keys(cal || {})])) {
    const p = (prev || {})[sym] || {}, n = (cal || {})[sym], h = new Set(p.h || []);
    if (p.p && p.p[0] < today && !p.p[1] && (!n || n[0] !== p.p[0])) h.add(p.p[0]);
    const r = { p: n || (p.p && p.p[0] >= today ? p.p : null), h: [...h].sort().slice(-8) };
    if (r.p || r.h.length) out[sym] = r;
  }
  return out;
}
async function trendsFromYahoo(f, symbols, sleep, gapMs = 120) {
  const s = await yahooSession(f), out = {}, est = {}, cal = {};
  let fails = 0;
  for (const sym of symbols) {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=earningsTrend,earningsHistory,calendarEvents&crumb=${encodeURIComponent(s.crumb)}`;
    try {
      let r = await f(url, { headers: { "User-Agent": UA, Cookie: s.cookie, Accept: "application/json" } });
      if (r.status === 429) { await sleep(5000); r = await f(url, { headers: { "User-Agent": UA, Cookie: s.cookie, Accept: "application/json" } }); }
      if (r.ok) { const j = await r.json(); const e = parseTrend(j); if (e) out[sym] = e; const x = parseEstimates(j); if (x) est[sym] = x; const c = parseCalendar(j); if (c) cal[sym] = c; } else fails++;
    } catch (e) { fails++; }
    if (fails > 60 && !Object.keys(out).length) throw new Error("Yahoo earningsTrend no responde");
    await sleep(gapMs);
  }
  return { out, est, cal };
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
  finnhubKey = process.env.FINNHUB_KEY || "", sleep = ms => new Promise(r => setTimeout(r, ms)), delayMs = 1100, log = console.log,
  withTrends = true, trendGapMs = 120 } = {}) {
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

  if (withTrends) {
    try {
      const { out: tr, est, cal } = await trendsFromYahoo(fetchImpl, symbols, sleep, trendGapMs);
      if (Object.keys(cal).length) {
        let prevE = {};
        try { prevE = JSON.parse(await readFile(new URL("earnings.json", root), "utf8")).data || {}; } catch (_) { /* primera vez */ }
        await writeFile(new URL("earnings.json", root), JSON.stringify({ asOf: now.toISOString(),
          nota: "Próximo balance (p: fecha en Nueva York, 1 si es estimada, EPS esperado, a/c/d = antes de la apertura, después del cierre o durante la rueda) y los anteriores (h). Yahoo quoteSummary, calendarEvents.",
          data: mergeEarnings(prevE, cal, today) }) + "\n");
        log(`Balances: ${Object.keys(cal).length} empresas con fecha`);
      }
      if (Object.keys(est).length) {
        await mkdir(new URL("estimaciones/", root), { recursive: true });
        for (const [sym, e] of Object.entries(est)) {
          const file = new URL(`estimaciones/${sym}.json`, root);
          let prevE = null;
          try { prevE = JSON.parse(await readFile(file, "utf8")); } catch (_) { /* primera vez */ }
          await writeFile(file, JSON.stringify(addEstimate(prevE, sym, e, today)) + "\n");
        }
        log(`Estimaciones: ${Object.keys(est).length} empresas`);
      }
      if (Object.keys(tr).length) {
        await writeFile(new URL("revisions.json", root), JSON.stringify({ asOf: now.toISOString(),
          nota: "Consenso de EPS (Yahoo) del ejercicio en curso (t0, cierre f0) y del siguiente (t1, cierre f1): hoy y hace 7, 30, 60 y 90 días; up/dn: analistas que lo subieron o bajaron en 30 días (ejercicio siguiente); n: analistas",
          data: tr }) + "\n");
      }
      log(`Revisiones: ${Object.keys(tr).length}/${symbols.length}`);
    } catch (e) { log(`Revisiones fallaron: ${e.message}`); }
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
