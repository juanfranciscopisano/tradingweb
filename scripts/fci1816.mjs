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
const r2 = v => v == null ? null : Math.round(v * 100) / 100, r6 = v => v == null ? null : +(+v).toPrecision(6);
const VENT = ["lastDay", "7d", "mtd", "30d", "90d", "ytd", "1y", "2y", "5y"];

export async function diario(api, { log = console.log, hoy = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10) } = {}) {
  const out = { asOf: new Date().toISOString(), fuente: "1816 (datos diarios de la CAFCI)", errores: {} };
  const paso = async (k, f) => { try { await f(); } catch (e) { out.errores[k] = String(e.message || e).slice(0, 200); log(`fci ${k}: ${e.message}`); if (/402/.test(e.message)) throw e; } };
  const ini5 = corrida(hoy, -5 * 366).slice(0, 8) + "01", ini2 = corrida(hoy, -2 * 366).slice(0, 8) + "01", ini120 = corrida(hoy, -120);
  // industria por tipo: mensual 5 años y diario 120 días, en las cuatro monedas
  out.tipos = {}; out.tiposDia = {};
  for (const cur of ["ars", "cer", "a3500", "usd"]) {
    await paso("tipos_" + cur, async () => {
      const { rows, meta } = await todas(api, "/v1/fci/series", { fields: ["aum", "netinflows"], group: "fundType", dateCompression: "month", dateStart: ini5, currency: cur });
      out.tipos[cur] = rows.map(x => [x.date, x.fundType, r2(x.aum), r2(x.netinflows)]); out.fechaDatos = meta?.dateEnd || out.fechaDatos;
    });
    await paso("tiposDia_" + cur, async () => {
      const { rows } = await todas(api, "/v1/fci/series", { fields: ["aum", "netinflows"], group: "fundType", dateCompression: "day", dateStart: ini120, currency: cur });
      out.tiposDia[cur] = rows.map(x => [x.date, x.fundType, r2(x.aum), r2(x.netinflows)]);
    });
  }
  // gerentes: patrimonio, suscripciones, facturación y fee promedio por mes, 2 años, en pesos (las otras monedas salen
  // del cociente de la industria por tipo, que viene en las cuatro)
  out.gerentes = {};
  for (const cur of ["ars"]) await paso("gerentes_" + cur, async () => {
    const { rows } = await todas(api, "/v1/fci/series", { fields: ["aum", "netinflows", "feeRevenueTotal", "feeRevenueManagement", "feeTotal"], group: "managerName", dateCompression: "month", dateStart: ini2, currency: cur });
    out.gerentes[cur] = rows.map(x => [x.date, x.managerName, r2(x.aum), r2(x.netinflows), r2(x.feeRevenueTotal), r2(x.feeRevenueManagement), r6(x.feeTotal)]);
  });
  // gerentes por tipo de fondo, el mes en curso (para el market share dentro de cada tipo)
  await paso("gerentesTipo", async () => {
    const tipos = [...new Set((out.tipos.ars || []).map(x => x[1]))];
    out.gerentesTipo = {};
    for (const t of tipos) {
      const { rows } = await todas(api, "/v1/fci/series", { fields: ["aum", "netinflows", "feeTotal"], group: "managerName", dateCompression: "month", dateStart: hoy.slice(0, 8) + "01", currency: "ars", filter: { fundType: [t] } });
      out.gerentesTipo[t] = rows.map(x => [x.managerName, r2(x.aum), r2(x.netinflows), r6(x.feeTotal)]);
    }
  });
  // fondos: el último día de cada fondo (patrimonio, fee, tipo, gerente) y suscripciones netas por ventana
  await paso("fondos", async () => {
    const { rows } = await todas(api, "/v1/fci/series", { fields: ["aum", "feeTotal", "fundType", "fundSubType", "fundCurrency", "managerName", "custodyName", "fundCnvCode"], group: "fundName", dateCompression: "day", dateStart: corrida(hoy, -6), currency: "ars" });
    const ult = {}; for (const x of rows) if (!ult[x.fundName] || x.date > ult[x.fundName].date) ult[x.fundName] = x;
    out.fondos = Object.values(ult).map(x => [x.fundName, x.fundType, x.fundSubType, x.fundCurrency, x.managerName, x.custodyName, r2(x.aum), r6(x.feeTotal), x.date]);
  });
  await paso("flujosFondo", async () => {
    const { rows } = await todas(api, "/v1/fci/net-inflows/ranking", { group: "fundName", currency: "ars" });
    out.flujosFondo = Object.fromEntries(rows.map(x => [x.fundName, VENT.map(k => r2(x[k]))]));
  });
  // rendimientos de la cuota de referencia de cada fondo: TNA (para money market y renta fija de corto) y directo,
  // en pesos y en dólares A3500 (los fondos en dólares se miran en dólares)
  out.rend = {};
  for (const [k, tipo, cur] of [["tna", "tna", "ars"], ["directo", "direct", "ars"], ["directoUsd", "direct", "a3500"]]) await paso("rend_" + k, async () => {
    const { rows } = await todas(api, "/v1/fci/nav-return/ranking", { filter: { isReferenceClass: true }, navReturnType: tipo, currency: cur });
    out.rend[k] = Object.fromEntries(rows.map(x => [x.fundName, VENT.map(w => r6(x[w]))]));
    if (k === "tna") out.clases = Object.fromEntries(rows.map(x => [x.fundName, x.className]));
  });
  out.creditos = (await api.get("/v1/creditos/balance")).j || null;
  return out;
}

export async function main({ fetchImpl = fetch, log = console.log, root = new URL("../", import.meta.url) } = {}) {
  const key = process.env.API_1816_FCI_KEY, modo = process.env.MODO || "diario";
  const archivo = modo === "explora" ? "m1816-fci-explora.json" : "fondos.json";
  if (!key) { log("sin API_1816_FCI_KEY en los secretos del repo"); if (modo === "explora") await writeFile(new URL(archivo, root), JSON.stringify({ asOf: new Date().toISOString(), error: "sin API_1816_FCI_KEY" })); return; }
  const api = cliente({ key, fetchImpl, log, modulo: "fci" });
  try {
    await api.login();
    if (modo === "explora") await writeFile(new URL(archivo, root), JSON.stringify(await explora(api, log), null, 1));
    else {
      const out = await diario(api, { log });
      // si no vino nada (1816 caído o sin créditos), queda el archivo anterior
      if ((out.tipos.ars || []).length || (out.fondos || []).length) await writeFile(new URL(archivo, root), JSON.stringify(out));
      else log("1816 FCI: no vino nada; queda lo que había");
    }
  } catch (e) {
    log("1816 FCI: " + e.message);
    if (modo === "explora") await writeFile(new URL(archivo, root), JSON.stringify({ asOf: new Date().toISOString(), error: String(e.message).slice(0, 300) }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
