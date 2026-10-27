// Series macro que el navegador no puede bajar directo (el BCRA no habilita CORS en sus planillas) o que no tienen
// historia pública. El Índice de Tipo de Cambio Real Multilateral (ITCRM) diario y los bilaterales con Brasil, Estados Unidos,
// China y la Zona Euro, de la planilla ITCRMSerie.xlsx del BCRA (itcrm.json), los cierres del MSCI MERVAL
// (merval.json) y la caución a 1 día (cauciones.json). Escribe en la raíz del repo.
//   node scripts/macro.mjs
import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";

export const ITCRM_URL = "https://www.bcra.gob.ar/Pdfs/PublicacionesEstadisticas/ITCRMSerie.xlsx";
// columnas que se guardan: nombre en el archivo de salida y cómo se reconoce el encabezado de la planilla
export const ITCRM_COLS = [
  ["itcrm", /^itcrm$/i],
  ["brasil", /^(itcrb )?brasil$/i],          // en la planilla: "ITCRB Brasil" (bilateral)
  ["eeuu", /^(itcrb )?estados unidos$/i],
  ["china", /^(itcrb )?china$/i],
  ["euro", /^(itcrb )?zona euro$/i],
];

// ---- lector mínimo de .xlsx (un zip con XML adentro), sin dependencias
export function unzip(buf) {
  const files = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("no es un zip");
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("directorio del zip roto");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + csize);
    files[name] = method === 8 ? inflateRawSync(data) : method === 0 ? data : null;
    p += 46 + nlen + elen + clen;
  }
  return files;
}
const unesc = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&");
const colIdx = ref => { let c = 0; for (const ch of ref.replace(/\d+$/, "")) c = c * 26 + ch.charCodeAt(0) - 64; return c - 1; };

// hojas del libro: { nombre: [[celdas de la fila 1], [fila 2], ...] } (texto o número; vacías = null)
export function readXlsx(buf) {
  const f = unzip(buf), txt = k => (f[k] ? f[k].toString("utf8") : "");
  const shared = [...txt("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));
  const rels = Object.fromEntries([...txt("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map(m => [m[0].match(/Id="([^"]+)"/)?.[1], m[0].match(/Target="([^"]+)"/)?.[1]]));
  const out = {};
  for (const m of txt("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)) {
    const name = unesc(m[0].match(/name="([^"]*)"/)?.[1] || ""), rid = m[0].match(/r:id="([^"]+)"/)?.[1];
    let target = rels[rid] || ""; target = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    const xml = txt(target); if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const ri = +(r[0].match(/\br="(\d+)"/)?.[1] || rows.length + 1) - 1, row = [];
      for (const c of (r[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = c[1].match(/\br="([A-Z]+\d+)"/)?.[1], t = c[1].match(/\bt="(\w+)"/)?.[1], body = c[2] || "";
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let val = null;
        if (t === "s" && v != null) val = shared[+v] ?? null;
        else if (t === "inlineStr") val = unesc([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(""));
        else if (t === "str" && v != null) val = unesc(v);
        else if (v != null && v !== "") val = isFinite(+v) ? +v : unesc(v);
        if (ref) row[colIdx(ref)] = val;
      }
      rows[ri] = row;
    }
    out[name] = Array.from(rows, r => r || []);
  }
  return out;
}

// fecha de Excel (número de serie) o texto dd/mm/aaaa a ISO
export function toISO(v) {
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
  const m = typeof v === "string" && v.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

// la hoja diaria: la que tiene una fila de encabezados con "ITCRM" y más filas con fecha debajo
export function parseItcrm(sheets) {
  let best = null;
  for (const [name, rows] of Object.entries(sheets)) {
    const h = rows.slice(0, 40).findIndex(r => r.some(c => typeof c === "string" && /^itcrm$/i.test(c.trim())));
    if (h < 0) continue;
    // los bilaterales pueden estar en la misma fila o en la de al lado (encabezado en dos filas)
    const clean = r => (r || []).map(c => (typeof c === "string" ? c.trim().replace(/\s+/g, " ") : ""));
    const heads = [rows[h], rows[h + 1], rows[h - 1]].map(clean);
    const idx = ITCRM_COLS.map(([, re]) => { for (const hd of heads) { const i = hd.findIndex(c => re.test(c)); if (i >= 0) return i; } return -1; });
    const head = heads[0];
    if (idx[0] < 0) continue;
    let dc = -1;   // columna de fechas: la primera con fechas en las filas de abajo
    for (let c = 0; c < head.length && dc < 0; c++) if (rows.slice(h + 1, h + 30).filter(r => toISO(r[c])).length >= 10) dc = c;
    if (dc < 0) continue;
    const data = [];
    for (const r of rows.slice(h + 1)) {
      const d = toISO(r[dc]), v = r[idx[0]];
      if (!d || typeof v !== "number" || !(v > 0)) continue;
      data.push([d, ...idx.map(i => (i >= 0 && typeof r[i] === "number" && r[i] > 0 ? +r[i].toFixed(2) : null))]);
    }
    // si hay dos hojas (diaria y promedio mensual), la de más filas
    if (data.length > (best?.data.length || 0)) best = { sheet: name, data, encabezado: [rows[h - 1], rows[h], rows[h + 1]].map(r => (r || []).slice(0, 40)) };
  }
  if (!best || best.data.length < 100) throw new Error("no encontré la serie diaria del ITCRM en la planilla");
  best.data.sort((a, b) => a[0].localeCompare(b[0]));
  return best;
}

// MSCI MERVAL: desde el 19/10/2026 MSCI calcula el Merval (S&P lo calculó hasta el 16/10) y no hay historia pública
// del índice nuevo. Se guarda el cierre de cada día de los datos abiertos de BYMA: a la noche, el precio del día; y el
// cierre anterior si falta (sirve para la primera corrida y si un día no corrió).
export const BYMA_INDEX_URL = "https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/index-price";
const prevWeekday = d => { const t = new Date(d + "T12:00:00Z"); do t.setUTCDate(t.getUTCDate() - 1); while (t.getUTCDay() % 6 === 0); return t.toISOString().slice(0, 10); };
export function addMsci(hist, m, now = new Date()) {
  const rows = new Map(hist);
  if (!(m && m.date && m.price > 0)) return [...rows].sort((a, b) => a[0].localeCompare(b[0]));
  const last = [...rows.keys()].sort().pop() || "";
  const pd = prevWeekday(m.date), lastV = last ? rows.get(last) : null;
  // cierre anterior: solo si falta ese día y no repite el último guardado (si el día hábil anterior fue feriado, es el mismo)
  if (m.previousClosingPrice > 0 && !rows.has(pd) && pd > last && m.previousClosingPrice !== lastV) rows.set(pd, +m.previousClosingPrice.toFixed(2));
  // el del día, después del cierre (20 UTC = 17 de Buenos Aires)
  if (now.getUTCHours() >= 20 && m.date === now.toISOString().slice(0, 10)) rows.set(m.date, +m.price.toFixed(2));
  return [...rows].sort((a, b) => a[0].localeCompare(b[0]));
}
async function msciMerval({ fetchImpl, root, log, now }) {
  const r = await fetchImpl(BYMA_INDEX_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error("BYMA índices HTTP " + r.status);
  const j = await r.json(), m = (j.data || j).find?.(x => x.symbol === "MMSCI");
  let prev = { msci: [] };
  try { prev = JSON.parse(await readFile(new URL("merval.json", root), "utf8")); } catch (e) { /* primera vez */ }
  const msci = addMsci(prev.msci || [], m, now);
  await writeFile(new URL("merval.json", root), JSON.stringify({ asOf: now.toISOString(), src: "BYMA, datos abiertos (MSCI MERVAL)", desde: "2026-10-19", msci }));
  log(`merval.json: ${msci.length} cierres del MSCI MERVAL` + (msci.length ? `, último ${msci[msci.length - 1].join(" ")}` : ""));
}

// Caución a 1 día: BYMA no publica la historia. A la noche se guarda la más corta del día (1 día, o 3 un viernes) con su
// promedio ponderado y el monto operado: cauciones.json, c1 = [[fecha, días, TNA promedio ponderada %, monto en millones]].
export const BYMA_CAU_URL = "https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/cauciones";
export function addCaucion(hist, list, now = new Date()) {
  const rows = new Map(hist.map(r => [r[0], r]));
  const hoy = new Date(now.getTime() - 3 * 3600000).toISOString().slice(0, 10);   // fecha de Buenos Aires
  const c = (list || []).filter(x => x.denominationCcy === "ARS" && x.daysToMaturity > 0 && x.vwap > 0 && x.volumeAmount > 0).sort((a, b) => a.daysToMaturity - b.daysToMaturity)[0];
  if (c && now.getUTCHours() >= 20) rows.set(hoy, [hoy, c.daysToMaturity, +(c.vwap * 100).toFixed(2), Math.round(c.volumeAmount / 1e6)]);
  return [...rows.values()].sort((a, b) => a[0].localeCompare(b[0]));
}
async function caucion({ fetchImpl, root, log, now }) {
  const r = await fetchImpl(BYMA_CAU_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ excludeZeroPxAndQty: true, T2: true, T1: true, T0: true }) });
  if (!r.ok) throw new Error("BYMA cauciones HTTP " + r.status);
  const j = await r.json();
  let prev = { c1: [] };
  try { prev = JSON.parse(await readFile(new URL("cauciones.json", root), "utf8")); } catch (e) { /* primera vez */ }
  const c1 = addCaucion(prev.c1 || [], Array.isArray(j) ? j : j.data || [], now);
  await writeFile(new URL("cauciones.json", root), JSON.stringify({ asOf: now.toISOString(), src: "BYMA, datos abiertos (cauciones en pesos)", cols: ["fecha", "dias", "tna_vwap", "monto_millones"], c1 }));
  log(`cauciones.json: ${c1.length} días` + (c1.length ? `, último ${c1[c1.length - 1].join(" ")}` : ""));
}

export async function main({ fetchImpl = fetch, root = new URL("../", import.meta.url), log = console.log, now = new Date() } = {}) {
  // el MSCI MERVAL y la caución no frenan el ITCRM si BYMA no responde
  await msciMerval({ fetchImpl, root, log, now }).catch(e => log("MSCI MERVAL: " + e.message));
  await caucion({ fetchImpl, root, log, now }).catch(e => log("Caución: " + e.message));
  const r = await fetchImpl(ITCRM_URL, { headers: { "User-Agent": "Mozilla/5.0 (tradingweb; serie ITCRM)" } });
  if (!r.ok) throw new Error("BCRA ITCRM HTTP " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const { sheet, data, encabezado } = parseItcrm(readXlsx(buf));
  const faltan = ITCRM_COLS.filter((c, i) => !data.some(r => r[i + 1] != null)).map(c => c[0]);
  if (faltan.length) log("sin datos para " + faltan.join(", ") + "; encabezado: " + JSON.stringify(encabezado));
  const out = { asOf: new Date().toISOString(), src: ITCRM_URL, hoja: sheet, base: "17-12-15=100", cols: ["fecha", ...ITCRM_COLS.map(c => c[0])], data,
    ...(faltan.length ? { encabezado } : {}) };
  await writeFile(new URL("itcrm.json", root), JSON.stringify(out));
  log(`itcrm.json: ${data.length} días (${data[0][0]} a ${data[data.length - 1][0]}), hoja "${sheet}", último ITCRM ${data[data.length - 1][1]}`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch(e => { console.error(e); process.exit(1); });
