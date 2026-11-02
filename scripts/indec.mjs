// API del INDEC (Catálogo API-INDEC, en beta): IPC por región y apertura, EMAE nivel general y por sector, industria
// manufacturera, precios mayoristas, salarios, canastas básicas y mercado de trabajo. Todos los datos piden token (JWT, vence a
// los 12 meses): está en el secreto INDEC_API_TOKEN y no se escribe en ningún archivo ni en el log. Sin token no hace nada.
//
// La API es PostgREST: hasta 1000 filas por pedido, filtros columna=eq.valor y páginas con limit y offset, ordenadas por la
// clave completa. Los nombres de las aperturas (región, clasificador, nivel, tipo de indicador) no están documentados: se
// leen de los datos del último período, y lo que se guarda se elige por la forma (el índice, las aperturas de pocos códigos).
//
// Escribe indec.json (las series del Informe) e indec-explora.json (el último período y las combinaciones de dimensiones de
// cada servicio, para revisar qué trae). Un servicio se vuelve a bajar solo si tiene un período nuevo; si falla, queda el de
// la corrida anterior y el error anotado.
//   node scripts/indec.mjs
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const BASE = "https://api.indec.gob.ar/v1/";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// query string con %20 (no "+") y los * de ilike sin escapar
const qs = p => Object.entries(p).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v)).replace(/%2A/gi, "*")).join("&");

export function cliente(token, { fetchImpl = fetch, pausa = 250 } = {}) {
  let n = 0;
  async function get(tabla, params = {}) {
    const url = BASE + tabla + (Object.keys(params).length ? "?" + qs(params) : "");
    for (let i = 0; ; i++) {
      if (n++) await sleep(pausa);
      const r = await fetchImpl(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json", "User-Agent": "tradingweb (series públicas del INDEC)" } });
      if ((r.status === 429 || r.status >= 500) && i < 3) { await sleep(pausa * 12 * (i + 1)); continue; }
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* no es JSON */ }
      if (!r.ok) throw new Error(tabla + ": HTTP " + r.status + (j && j.message ? " " + j.message : ""));
      if (!Array.isArray(j)) throw new Error(tabla + ": la respuesta no es una tabla");
      return j;
    }
  }
  // todas las páginas, con el orden de la clave completa para que no se repitan ni falten filas entre páginas
  async function todas(tabla, params, orden, max = 300) {
    const rows = [];
    for (let k = 0; k < max; k++) {
      const f = await get(tabla, { ...params, order: orden, limit: 1000, offset: k * 1000 });
      rows.push(...f);
      if (f.length < 1000) return rows;
    }
    throw new Error(tabla + ": más de " + max + " páginas");
  }
  return { get, todas, pedidos: () => n };
}

// columnas que identifican cada fila (la clave): con ellas se ordena y se arman las series
export const SERVICIOS = {
  ipc_nacional: ["clasificador", "nivel", "codigo", "descripcion", "periodo", "anio", "mes", "indicador", "tipo_de_indicador", "tipo_de_indicador_descripcion", "region", "unidad_de_medida"],
  "estimador-mensual-de-actividad-economica-nivel-general": ["tipo_de_indicador_descripcion", "anio", "mes", "periodo", "tipo_de_indicador"],
  "estimador-mensual-de-actividad-economica-sectores": ["anio", "mes", "codigo", "descripcion", "periodo", "tipo_de_indicador"],
  ipi_manufacturero: ["periodo", "anio", "mes", "indicador", "cuadro_web", "codigo_CLaNAE_2004", "descripcion", "serie", "tipo_de_indicador", "unidad_de_medida"],
  sipm_precios_mayoristas: ["operativo", "indicador", "clasificador", "nivel", "codigo_apertura", "descripcion", "periodo", "anio", "mes", "tipo_de_indicador", "tipo_de_indicador_descripcion", "region", "unidad_de_medida"],
  indice_salarios: ["clasificador", "nivel", "codigo", "descripcion", "periodo", "anio", "mes", "indicador", "tipo_de_indicador", "tipo_de_indicador_descripcion", "unidad_de_medida"],
  valorizacion_canastas_cba_cbt: ["clasificador", "nivel", "codigo", "descripcion", "periodo", "anio", "mes", "indicador", "tipo_de_indicador", "tipo_de_indicador_descripcion", "region", "unidad_de_medida"],
  mercado_trabajo_eph: ["area_geografica_nom", "area_geografica_cod", "periodo", "anio", "trimestre"],
  pobreza_eph: ["area_geografica_nom", "area_geografica_cod", "periodo", "anio", "semestre"],
};
const TIEMPO = new Set(["periodo", "anio", "mes", "trimestre", "semestre"]);
const dimsDe = s => SERVICIOS[s].filter(c => !TIEMPO.has(c));

export const num = x => { if (x == null) return null; const v = typeof x === "number" ? x : parseFloat(String(x).replace(",", ".")); return isFinite(v) ? +v.toPrecision(7) : null; };
// período AAAAMM → "AAAA-MM"; AAAAT o AAAAS (trimestre o semestre, un dígito) → "AAAA-T" / "AAAA-S"
export const perMes = p => { const s = String(p); return s.length >= 6 ? s.slice(0, 4) + "-" + s.slice(4, 6) : null; };
export const sigMes = (m, k = 1) => { const [y, mm] = m.split("-").map(Number), t = y * 12 + mm - 1 + k; return Math.floor(t / 12) + "-" + String(t % 12 + 1).padStart(2, "0"); };

// el tipo de indicador que es el índice (no la variación ni la incidencia): por el código o por su descripción
export const esIndice = (t, d) => /ndice/i.test(t || "") && !/incidencia/i.test(t || "") || /^[ií]ndice/i.test(d || "") || /n[uú]mero[s]? [ií]ndice/i.test(d || "");

// series mensuales con un eje común: { d0, series: [{ ...dims, v: [...] }] }
export function mensual(rows, dims) {
  const by = new Map();
  let lo = null, hi = null;
  for (const r of rows) {
    const m = perMes(r.periodo), v = num(r.valor);
    if (!m || v == null) continue;
    const key = dims.map(c => r[c] ?? "").join("\u0001");
    if (!by.has(key)) by.set(key, { dims: Object.fromEntries(dims.map(c => [c, r[c] ?? null])), m: new Map() });
    by.get(key).m.set(m, v);
    if (!lo || m < lo) lo = m; if (!hi || m > hi) hi = m;
  }
  if (!lo) return { d0: null, series: [] };
  const meses = []; for (let m = lo; m <= hi; m = sigMes(m)) meses.push(m);
  return { d0: lo, series: [...by.values()].map(s => ({ ...s.dims, v: meses.map(m => s.m.has(m) ? s.m.get(m) : null) })) };
}

// combinaciones de dimensiones de un período (para indec-explora.json)
export function combos(rows, dims) {
  const by = new Map();
  for (const r of rows) {
    const key = dims.map(c => r[c] ?? "").join("\u0001");
    if (!by.has(key)) by.set(key, { ...Object.fromEntries(dims.map(c => [c, r[c] ?? null])), valor: r.valor ?? null, obs: r.observaciones ?? null });
  }
  return [...by.values()];
}

async function ultimo(api, s) {
  const f = await api.get(s, { select: "periodo", order: "periodo.desc", limit: 1 });
  if (!f.length) throw new Error(s + ": vacío");
  return String(f[0].periodo);
}

// IPC: el índice de las aperturas con pocos códigos (nivel general, divisiones, categorías, bienes y servicios), todas las
// regiones. Grupos, clases y subclases (decenas o cientos de códigos) no se guardan
export async function ipc(api, P, enP) {
  const s = "ipc_nacional", dims = SERVICIOS.ipc_nacional;
  const tipos = combos(enP, ["tipo_de_indicador", "tipo_de_indicador_descripcion"]).filter(t => esIndice(t.tipo_de_indicador, t.tipo_de_indicador_descripcion));
  if (!tipos.length) throw new Error(s + ": no encontré el tipo índice entre " + JSON.stringify(combos(enP, ["tipo_de_indicador"]).map(t => t.tipo_de_indicador)));
  const T = tipos[0];
  const idx = enP.filter(r => r.tipo_de_indicador === T.tipo_de_indicador);
  const porRegion = new Map();
  for (const r of idx) { const k = r.region; porRegion.set(k, (porRegion.get(k) || 0) + 1); }
  const regionMayor = [...porRegion.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const grupos = combos(idx, ["clasificador", "nivel"]).map(g => ({ ...g, codigos: new Set(idx.filter(r => r.region === regionMayor && r.clasificador === g.clasificador && r.nivel === g.nivel).map(r => r.codigo)).size }))
    .filter(g => g.codigos > 0 && g.codigos <= 20);
  if (!grupos.length) throw new Error(s + ": ninguna apertura con 20 códigos o menos");
  const rows = [];
  for (const g of grupos) rows.push(...await api.todas(s, { clasificador: "eq." + g.clasificador, nivel: "eq." + g.nivel, tipo_de_indicador: "eq." + T.tipo_de_indicador }, dims.join(",")));
  const out = mensual(rows, ["region", "clasificador", "nivel", "codigo", "descripcion"]);
  return { ...out, tipo: T.tipo_de_indicador, aperturas: grupos.map(g => [g.clasificador, g.nivel, g.codigos]) };
}

// un servicio chico entero, o filtrado (EMAE, IPI, mayoristas, salarios, canastas): se queda con el tipo índice si hay
// varios tipos, o con todo si el servicio no tiene tipo
async function indices(api, s, filtro = {}, { soloIndice = true } = {}) {
  const dims = SERVICIOS[s], rows = await api.todas(s, filtro, dims.join(","));
  const tieneTipo = dims.includes("tipo_de_indicador");
  const sel = tieneTipo && soloIndice ? rows.filter(r => esIndice(r.tipo_de_indicador, r.tipo_de_indicador_descripcion)) : rows;
  if (!sel.length) throw new Error(s + ": sin filas del tipo índice (tipos: " + JSON.stringify(combos(rows, ["tipo_de_indicador"]).map(t => t.tipo_de_indicador).slice(0, 12)) + ")");
  return mensual(sel, dimsDe(s));
}

// EPH: tasas por trimestre o semestre del total de aglomerados (el área que tiene más períodos)
export function eph(rows, cols, per) {
  const byArea = new Map();
  for (const r of rows) { const k = r.area_geografica_cod ?? r.area_geografica_nom; if (!byArea.has(k)) byArea.set(k, []); byArea.get(k).push(r); }
  const areas = [...byArea.entries()].sort((a, b) => (/total/i.test(b[1][0].area_geografica_nom) - /total/i.test(a[1][0].area_geografica_nom)) || b[1].length - a[1].length);
  if (!areas.length) return null;
  const A = areas[0][1].slice().sort((a, b) => a.anio - b.anio || a[per] - b[per]);
  return { area: A[0].area_geografica_nom, p: A.map(r => r.anio + "-" + r[per]), ...Object.fromEntries(cols.map(c => [c, A.map(r => num(r[c]))])) };
}

const PEDIDOS = {
  ipc_nacional: (api, P, enP) => ipc(api, P, enP),
  "estimador-mensual-de-actividad-economica-nivel-general": api => indices(api, "estimador-mensual-de-actividad-economica-nivel-general"),
  "estimador-mensual-de-actividad-economica-sectores": api => indices(api, "estimador-mensual-de-actividad-economica-sectores"),
  ipi_manufacturero: api => indices(api, "ipi_manufacturero", { descripcion: "ilike.*nivel general*" }),
  sipm_precios_mayoristas: api => indices(api, "sipm_precios_mayoristas", { descripcion: "ilike.*nivel general*" }),
  indice_salarios: api => indices(api, "indice_salarios"),
  valorizacion_canastas_cba_cbt: api => indices(api, "valorizacion_canastas_cba_cbt", {}, { soloIndice: false }),
  mercado_trabajo_eph: async api => eph(await api.todas("mercado_trabajo_eph", {}, SERVICIOS.mercado_trabajo_eph.join(",")),
    ["tasa_de_actividad", "tasa_de_empleo", "tasa_de_desocupacion", "tasa_de_empleo_informal", "tasa_de_subocupacion"], "trimestre"),
  pobreza_eph: async api => eph(await api.todas("pobreza_eph", {}, SERVICIOS.pobreza_eph.join(",")),
    ["tasa_pobreza_personas", "tasa_indigencia_personas", "tasa_pobreza_hogares", "tasa_indigencia_hogares"], "semestre"),
};

export async function main({ fetchImpl = fetch, root = new URL("../", import.meta.url), log = console.log, token = process.env.INDEC_API_TOKEN, pausa = 250 } = {}) {
  if (!token) { log("::warning::INDEC_API_TOKEN no está cargado en los secretos del repo: no se consulta la API del INDEC"); return null; }
  const api = cliente(token, { fetchImpl, pausa });
  let prev = {}; try { prev = JSON.parse(await readFile(new URL("indec.json", root), "utf8")); } catch (e) { /* primera vez */ }
  let explora = {}; try { explora = JSON.parse(await readFile(new URL("indec-explora.json", root), "utf8")); } catch (e) { /* primera vez */ }
  const out = { asOf: new Date().toISOString(), fuente: "INDEC, Catálogo API-INDEC", ult: { ...(prev.ult || {}) }, datos: { ...(prev.datos || {}) }, errores: {} };
  explora = { asOf: out.asOf, servicios: { ...(explora.servicios || {}) } };
  for (const s of Object.keys(PEDIDOS)) {
    try {
      const P = await ultimo(api, s);
      if (prev.ult?.[s] === P && prev.datos?.[s]) { log(s + ": sin período nuevo (" + P + ")"); continue; }
      const enP = await api.todas(s, { periodo: "eq." + P }, SERVICIOS[s].join(","));
      explora.servicios[s] = { ultimo: P, filas: enP.length, combos: combos(enP, dimsDe(s)).slice(0, 600) };
      const d = await PEDIDOS[s](api, P, enP);
      if (!d) throw new Error(s + ": sin datos");
      out.datos[s] = d; out.ult[s] = P;
      log(s + ": " + P + (d.series ? ", " + d.series.length + " series desde " + d.d0 : d.p ? ", " + d.p.length + " períodos (" + d.area + ")" : ""));
    } catch (e) {
      out.errores[s] = String(e.message || e).slice(0, 300);
      log("::warning::" + out.errores[s]);
    }
  }
  log("pedidos a la API: " + api.pedidos());
  await writeFile(new URL("indec.json", root), JSON.stringify(out));
  await writeFile(new URL("indec-explora.json", root), JSON.stringify(explora));
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch(e => { console.error(e); process.exit(1); });
