// Series macro que el navegador no puede bajar directo (el BCRA no habilita CORS en sus planillas).
// Hoy: el Índice de Tipo de Cambio Real Multilateral (ITCRM) diario y los bilaterales con Brasil, Estados Unidos,
// China y la Zona Euro, de la planilla ITCRMSerie.xlsx del BCRA. Escribe itcrm.json en la raíz del repo.
//   node scripts/macro.mjs
import { writeFile } from "node:fs/promises";
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

export async function main({ fetchImpl = fetch, root = new URL("../", import.meta.url), log = console.log } = {}) {
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
