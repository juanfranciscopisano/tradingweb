// API de FCI de 1816 (módulo fci): patrimonio, suscripciones netas, fees, facturación y rendimientos de los fondos.
// La clave está en el secreto API_1816_FCI_KEY (no sirve la de mercado: cada clave es de un módulo) y no se escribe en
// ningún archivo ni en el log.
//
// MODO=explora: dimensiones, valores de cada filtro, créditos y la forma de cada respuesta → m1816-fci-explora.json
// MODO=diario (el de todas las noches): lo que muestra la pestaña Fondos → fondos.json
import { writeFile, readFile } from "node:fs/promises";
import { cliente } from "./m1816.mjs";

const forma = v => Array.isArray(v) ? (v.length ? [forma(v[0])] : []) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, forma(x)])) : typeof v;
export const corrida = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const filas = j => Array.isArray(j?.data) ? j.data : Array.isArray(j?.rows) ? j.rows : Array.isArray(j?.results) ? j.results : Array.isArray(j) ? j : [];

async function explora(api, log) {
  const out = { asOf: new Date().toISOString() };
  out.balanceAntes = (await api.get("/v1/creditos/balance")).j;
  for (const [k, p] of [["groups", "/v1/fci/global/groups"], ["filters", "/v1/fci/global/filters"], ["compresiones", "/v1/fci/series/date-compressions"]]) out[k] = (await api.get(p)).j;
  const op = await api.post("/v1/fci/global/filter-options", { keys: ["fundType", "fundSubType", "fundCurrency", "classCurrency", "managerType", "managerName"] });
  out.opciones = { status: op.status, j: op.j };
  const s = await api.post("/v1/fci/series", { fields: ["aum", "netinflows"], group: "fundType", dateCompression: "month", dateStart: corrida(new Date().toISOString().slice(0, 10), -70), currency: "ars" });
  out.series = { status: s.status, forma: forma(s.j), filas: filas(s.j).length, error: s.j?.error || null, message: s.j?.message || null };
  const r = await api.post("/v1/fci/nav-return/ranking", { filter: { isReferenceClass: true }, navReturnType: "tna", pageSize: 3 });
  out.ranking = { status: r.status, forma: forma(r.j), error: r.j?.error || null, message: r.j?.message || null };
  const n = await api.post("/v1/fci/net-inflows/ranking", { group: "fundType" });
  out.flujos = { status: n.status, forma: forma(n.j), filas: filas(n.j).length };
  out.balanceDespues = (await api.get("/v1/creditos/balance")).j;
  log("1816 FCI: " + JSON.stringify(out.balanceDespues));
  return out;
}

// MODO=cuenta: cuántas filas trae cada consulta (con páginas de pocas filas, para gastar poco) y una muestra de los valores
async function cuenta(api, log) {
  const out = { asOf: new Date().toISOString(), balanceAntes: (await api.get("/v1/creditos/balance")).j };
  const hoy = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10), mes = hoy.slice(0, 8) + "01";
  const q = async (k, path, body) => { const r = await api.post(path, body); out[k] = { status: r.status, total: r.j?.pagination?.total ?? null, metadata: r.j?.metadata || null, muestra: filas(r.j), error: r.j?.message || r.j?.error || null }; };
  // convención de días de la TNA: los tres tipos de rendimiento para dos fondos, un martes y un lunes
  const f = { isReferenceClass: true, fundName: ["BAVSA Ahorro", "1810 Ahorro"] };
  for (const d of ["2026-10-27", "2026-10-26", "2026-10-01"]) for (const t of ["direct", "tna", "tea"]) await q("rend_" + d + "_" + t, "/v1/fci/nav-return/ranking", { filter: f, navReturnType: t, currency: "ars", date: d });
  await q("flujosTipo", "/v1/fci/net-inflows/ranking", { group: "fundType", currency: "ars" });
  await q("flujosTipoUsd", "/v1/fci/net-inflows/ranking", { group: "fundType", currency: "a3500" });
  await q("flujosGerente", "/v1/fci/net-inflows/ranking", { group: "managerName", currency: "ars", pageSize: 2 });
  await q("ultimo", "/v1/fci/series", { fields: ["aum"], group: "total", dateCompression: "day", dateStart: corrida(hoy, -3), currency: "ars" });
  out.balanceDespues = (await api.get("/v1/creditos/balance")).j;
  log("1816 FCI cuenta: " + JSON.stringify(out.balanceDespues));
  return out;
}

// todas las páginas de una consulta
async function todas(api, path, body, max = 15000) {
  const rows = []; let page = 1, total = null, meta = null;
  for (;;) {
    const r = await api.post(path, { ...body, page, pageSize: max });
    if (r.status === 402) throw new Error("1816 FCI sin créditos (402)");
    if (r.status !== 200) throw new Error(path + ": HTTP " + r.status + " " + (r.j?.message || r.j?.error || ""));
    meta = r.j?.metadata || meta;
    const f = filas(r.j); rows.push(...f);
    total = r.j?.pagination?.total ?? total;
    if (!f.length || total == null || rows.length >= total) break;
    page++;
  }
  return { rows, meta };
}
const r0 = v => v == null ? null : Math.round(v), r6 = v => v == null ? null : +(+v).toPrecision(6);
export const VENT = ["lastDay", "7d", "mtd", "30d", "90d", "ytd", "1y", "2y", "5y"];
const MONEDAS = ["ars", "cer", "a3500", "usd"];
const mesDe = d => d.slice(0, 8) + "01";
const masMeses = (m, n) => { const t = new Date(m.slice(0, 7) + "-01T12:00:00Z"); t.setUTCMonth(t.getUTCMonth() + n); return t.toISOString().slice(0, 10); };
const dif = (a, b) => Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 864e5);
const menosAnios = (d, n) => { const x = (+d.slice(0, 4) - n) + d.slice(4); return isNaN(Date.parse(x)) || d.slice(5) === "02-29" ? x.slice(0, 5) + "02-28" : x; };
// las filas desde `desde` se reemplazan por las que vinieron (la consulta trae todo ese tramo) y se ordena por fecha
const reemplazar = (arr, desde, nuevas) => (arr || []).filter(r => r[0] < desde).concat(nuevas).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const series = (api, body) => todas(api, "/v1/fci/series", body);

// días de cada ventana de rendimiento para anualizar: los de 1816 (7, 30, 90, desde fin del mes y del año anterior, 1, 2 y
// 5 años corridos), salvo el de un día, que va desde el último día hábil (1816 anualiza con un día también los lunes)
export function diasVentanas(fecha, totalArs) {
  let ant = null; for (const r of totalArs || []) if (r[0] < fecha && r[2]) ant = r[0];
  return [ant ? dif(fecha, ant) : 1, 7, +fecha.slice(8, 10), 30, 90, dif(fecha, (+fecha.slice(0, 4) - 1) + "-12-31"), dif(fecha, menosAnios(fecha, 1)), dif(fecha, menosAnios(fecha, 2)), dif(fecha, menosAnios(fecha, 5))];
}

// Corrida diaria incremental: lo ya bajado queda en fondos.json y cada corrida baja desde lo último que había. Cada paso
// mira antes el saldo del día (10.000 créditos) y, si no alcanza, queda pendiente para la corrida siguiente.
export async function diario(api, { log = console.log, prev = null, hoy = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10), margen = 300 } = {}) {
  const v2 = prev && prev.v === 2;
  const o = v2 ? prev : { v: 2, total: {}, totalMes: {}, tiposDia: [], tipos: [], flujosTipo: {}, gerentes: [], flujosGerente: {}, fondos: [], flujosFondo: {}, rend: {}, clases: {} };
  const pendAntes = v2 ? (prev.pendiente || []) : [];
  o.asOf = new Date().toISOString(); o.fuente = "1816 (datos diarios de la CAFCI)"; o.errores = {}; o.pendiente = [];
  const saldo = async () => { const d = (await api.get("/v1/creditos/balance")).j?.daily; return d && d.limit != null ? d.limit - d.used : Infinity; };
  let libre = await saldo();
  let solo = null;   // sin día nuevo: solo lo que quedó pendiente
  const paso = async (k, est, f) => {
    if (solo && !solo.has(k)) return;
    if (est > libre - margen) { o.pendiente.push(k); log(`fci ${k}: queda pendiente (necesita unos ${est} créditos y quedan ${libre})`); return; }
    try { await f(); } catch (e) { o.errores[k] = String(e.message || e).slice(0, 200); log(`fci ${k}: ${e.message}`); if (/402/.test(e.message)) throw e; }
    libre = await saldo();
  };

  // 1. ¿hay datos nuevos? El total de la industria en pesos desde tres días antes del último que había
  const ult = (o.total.ars || []).at(-1)?.[0];
  const desdeT = ult ? corrida(ult, -3) : corrida(hoy, -120);
  const { rows: tA } = await series(api, { fields: ["aum", "netinflows"], group: "total", dateCompression: "day", dateStart: desdeT, currency: "ars" });
  const fecha = tA.map(x => x.date).sort().at(-1);
  if (!fecha) { log("1816 FCI: no vino el total de la industria"); return null; }
  if (v2 && fecha === prev.fecha && !pendAntes.length) { log("1816 FCI: sin datos nuevos (último " + fecha + ")"); return null; }
  if (v2 && fecha === prev.fecha) solo = new Set(pendAntes);
  o.total.ars = reemplazar(o.total.ars, desdeT, tA.map(x => [x.date, r0(x.aum), r0(x.netinflows)])).filter(r => r[0] >= corrida(fecha, -400));
  const mesF = mesDe(fecha), mesAnt = v2 && prev.fecha ? mesDe(prev.fecha) : mesF;
  libre = await saldo();

  // 2. la industria en las otras monedas (de ahí sale el cociente para pasar lo que viene en pesos)
  await paso("totalMonedas", o.total.cer?.length ? 30 : 400, async () => {
    for (const cur of MONEDAS.slice(1)) {
      const d = o.total[cur]?.length ? corrida(o.total[cur].at(-1)[0], -3) : o.total.ars[0][0];
      const { rows } = await series(api, { fields: ["aum"], group: "total", dateCompression: "day", dateStart: d, currency: cur });
      o.total[cur] = reemplazar(o.total[cur], d, rows.map(x => [x.date, r0(x.aum)])).filter(r => r[0] >= corrida(fecha, -400));
    }
  });
  await paso("totalMes", o.totalMes.ars?.length ? 20 : 320, async () => {
    for (const cur of MONEDAS) {
      const d = o.totalMes[cur]?.length ? o.totalMes[cur].at(-1)[0] : masMeses(mesF, -60);
      const f = cur === "ars" ? ["aum", "netinflows"] : ["aum"];
      const { rows } = await series(api, { fields: f, group: "total", dateCompression: "month", dateStart: d, currency: cur });
      o.totalMes[cur] = reemplazar(o.totalMes[cur], d, rows.map(x => cur === "ars" ? [x.date, r0(x.aum), r0(x.netinflows)] : [x.date, r0(x.aum)]));
    }
  });
  // 3. industria por tipo, en pesos: patrimonio diario (200 días) y patrimonio y suscripciones por mes (5 años)
  await paso("tiposDia", o.tiposDia.length ? 7 * (dif(fecha, o.tiposDia.at(-1)[0]) + 4) : 900, async () => {
    const d = o.tiposDia.length ? corrida(o.tiposDia.at(-1)[0], -3) : corrida(fecha, -120);
    const { rows } = await series(api, { fields: ["aum"], group: "fundType", dateCompression: "day", dateStart: d });
    o.tiposDia = reemplazar(o.tiposDia, d, rows.map(x => [x.date, x.fundType, r0(x.aum)])).filter(r => r[0] >= corrida(fecha, -200));
  });
  await paso("tipos", o.tipos.length ? 30 : 900, async () => {
    const d = o.tipos.length ? o.tipos.at(-1)[0] : masMeses(mesF, -60);
    const { rows } = await series(api, { fields: ["aum", "netinflows"], group: "fundType", dateCompression: "month", dateStart: d });
    o.tipos = reemplazar(o.tipos, d, rows.map(x => [x.date, x.fundType, r0(x.aum), r0(x.netinflows)]));
  });
  // suscripciones netas por ventana: el ranking cobra una fila por tipo o gerente, con todas las ventanas, en cada moneda
  await paso("flujosTipo", 40, async () => {
    for (const cur of MONEDAS) { const { rows } = await todas(api, "/v1/fci/net-inflows/ranking", { group: "fundType", currency: cur, date: fecha }); o.flujosTipo[cur] = Object.fromEntries(rows.map(x => [x.fundType, VENT.map(k => r0(x[k]))])); }
  });

  // 4. fondos: tipo, gerente y suscripciones (del ranking), patrimonio del último día y fee (una vez por mes)
  const nF = Object.keys(o.flujosFondo).length || 1600, porNombre = new Map(o.fondos.map(f => [f[0], f]));
  const fila = n => { if (!porNombre.has(n)) porNombre.set(n, [n, null, null, null, null, null, null, null]); return porNombre.get(n); };
  await paso("flujosFondo", nF, async () => {
    const { rows } = await todas(api, "/v1/fci/net-inflows/ranking", { group: "fundName", currency: "ars", date: fecha });
    o.flujosFondo = {};
    for (const x of rows) { const f = fila(x.fundName); [f[1], f[2], f[3], f[4], f[5]] = [x.fundType, x.fundSubType, x.fundCurrency, x.managerName, x.custodyName]; o.flujosFondo[x.fundName] = VENT.map(k => r0(x[k])); }
  });
  await paso("patrimonioFondo", nF, async () => {
    const { rows } = await series(api, { fields: ["aum"], group: "fundName", dateCompression: "day", dateStart: fecha, dateEnd: fecha });
    for (const f of porNombre.values()) f[6] = null;
    for (const x of rows) fila(x.fundName)[6] = r0(x.aum);
    o.fondosFecha = fecha;
  });
  if (o.feeMes !== mesF.slice(0, 7)) await paso("feeFondo", nF, async () => {
    const { rows } = await series(api, { fields: ["feeTotal"], group: "fundName", dateCompression: "month", dateStart: mesF });
    for (const x of rows) fila(x.fundName)[7] = r6(x.feeTotal);
    o.feeMes = mesF.slice(0, 7);
  });
  o.fondos = [...porNombre.values()].filter(f => f[6] > 0 && f[1]);
  for (const n of Object.keys(o.flujosFondo)) if (!porNombre.get(n) || !(porNombre.get(n)[6] > 0)) delete o.flujosFondo[n];

  // 5. rendimientos directos de la cuota de referencia (en pesos; los fondos en dólares también en dólares). TNA y TEA
  // se calculan en la página con los días de cada ventana
  await paso("rend", (Object.keys(o.rend.directo || {}).length || 1300) + 320, async () => {
    const { rows, meta } = await todas(api, "/v1/fci/nav-return/ranking", { filter: { isReferenceClass: true }, navReturnType: "direct", currency: "ars", date: fecha });
    const { rows: u } = await todas(api, "/v1/fci/nav-return/ranking", { filter: { isReferenceClass: true, fundCurrency: ["usd", "usb"] }, navReturnType: "direct", currency: "a3500", date: fecha });
    o.rend = { directo: Object.fromEntries(rows.map(x => [x.fundName, VENT.map(k => r6(x[k]))])), directoUsd: Object.fromEntries(u.map(x => [x.fundName, VENT.map(k => r6(x[k]))])) };
    o.clases = Object.fromEntries(rows.map(x => [x.fundName, x.className]));
    o.rendFecha = meta?.date || fecha; o.rendDias = diasVentanas(o.rendFecha, o.total.ars);
  });

  // 6. gerentes: el mes en curso (y el anterior si cambió) completo; la historia de 2 años, solo patrimonio y facturación
  await paso("gerentes", 600, async () => {
    const { rows } = await series(api, { fields: ["aum", "feeRevenueTotal", "feeRevenueManagement", "feeTotal"], group: "managerName", dateCompression: "month", dateStart: mesAnt });
    o.gerentes = reemplazar(o.gerentes, mesAnt, rows.map(x => [x.date, x.managerName, r0(x.aum), r0(x.feeRevenueTotal), r0(x.feeRevenueManagement), r6(x.feeTotal)]));
  });
  await paso("flujosGerente", 300, async () => {
    for (const cur of MONEDAS) { const { rows } = await todas(api, "/v1/fci/net-inflows/ranking", { group: "managerName", currency: cur, date: fecha }); o.flujosGerente[cur] = Object.fromEntries(rows.map(x => [x.managerName, VENT.map(k => r0(x[k]))])); }
  });
  if (!o.gerentesHist) await paso("gerentesHist", 24 * 70 * 2, async () => {
    const desde = masMeses(mesF, -24), hasta = corrida(mesAnt, -1);
    const { rows } = await series(api, { fields: ["aum", "feeRevenueTotal"], group: "managerName", dateCompression: "month", dateStart: desde, dateEnd: hasta });
    o.gerentes = o.gerentes.filter(r => r[0] >= mesAnt).concat(rows.map(x => [x.date, x.managerName, r0(x.aum), r0(x.feeRevenueTotal), null, null])).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    o.gerentesHist = true;
  });
  if (solo && o.pendiente.length === pendAntes.length && !Object.keys(o.errores).length) { log("1816 FCI: sigue pendiente " + o.pendiente.join(", ")); return null; }
  o.gerentes = o.gerentes.filter(r => r[0] >= masMeses(mesF, -36));
  o.fecha = fecha;
  o.creditos = libre === Infinity ? null : { libresHoy: libre };
  return o;
}

export async function main({ fetchImpl = fetch, log = console.log, root = new URL("../", import.meta.url) } = {}) {
  const key = process.env.API_1816_FCI_KEY, modo = process.env.MODO || "diario";
  const archivo = modo === "explora" ? "m1816-fci-explora.json" : modo === "cuenta" ? "m1816-fci-cuenta.json" : "fondos.json";
  if (!key) { log("sin API_1816_FCI_KEY en los secretos del repo"); if (modo === "explora") await writeFile(new URL(archivo, root), JSON.stringify({ asOf: new Date().toISOString(), error: "sin API_1816_FCI_KEY" })); return; }
  const api = cliente({ key, fetchImpl, log, modulo: "fci" });
  try {
    await api.login();
    if (modo === "explora") await writeFile(new URL(archivo, root), JSON.stringify(await explora(api, log), null, 1));
    else if (modo === "cuenta") await writeFile(new URL(archivo, root), JSON.stringify(await cuenta(api, log), null, 1));
    else {
      let prev = null; try { prev = JSON.parse(await readFile(new URL(archivo, root), "utf8")); } catch (e) {}
      const out = await diario(api, { log, prev });
      if (out) { await writeFile(new URL(archivo, root), JSON.stringify(out)); log("1816 FCI: datos al " + out.fecha + (out.pendiente.length ? "; pendiente: " + out.pendiente.join(", ") : "") + "; quedan " + (out.creditos?.libresHoy ?? "?") + " créditos hoy"); }
    }
  } catch (e) {
    log("1816 FCI: " + e.message);
    if (modo === "explora") await writeFile(new URL(archivo, root), JSON.stringify({ asOf: new Date().toISOString(), error: String(e.message).slice(0, 300) }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
