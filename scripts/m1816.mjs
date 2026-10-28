// API de 1816 (módulo mercado). La clave está en el secreto API_1816_KEY del repo: se cambia por un token de 24 h y no
// se escribe en ningún archivo ni en el log. Límite del plan: 1 pedido por segundo y créditos por día.
//
// MODO=diario (el de todos los días): curvas, flujos y montos en soberanos.json.
// MODO=explora: lista curvas e instrumentos de cada curva y prueba cómo se pasan las listas en la consulta. Guarda solo
// metadatos (nombres, tickers, vencimientos, monedas) y los códigos de respuesta, nunca precios ni tasas.
import { writeFile } from "node:fs/promises";

const BASE = "https://api.1816.com.ar";
const UA = "Mozilla/5.0 (tradingweb; 1816)";
const pausa = ms => new Promise(r => setTimeout(r, ms));

export function qs(params, estilo = "repetido") {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) { if (estilo === "coma") u.append(k, v.join(",")); else v.forEach(x => u.append(k, x)); }
    else u.append(k, String(v));
  }
  const s = u.toString();
  return s ? "?" + s : "";
}

export function cliente({ key, fetchImpl = fetch, log = console.log, espera = +(process.env.ESPERA ?? 1100), modulo = "mercado" }) {
  let token = null, ultimo = 0, pedidos = 0;
  const llamar = async (metodo, path, { query, body, auth = true } = {}) => {
    const falta = ultimo + espera - Date.now(); if (falta > 0) await pausa(falta);
    ultimo = Date.now(); pedidos++;
    const headers = { "User-Agent": UA, Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (auth) headers.Authorization = "Bearer " + token;
    // 429 (más de un pedido por segundo): esperar y repetir, hasta 5 veces
    for (let k = 0; ; k++) {
      const r = await fetchImpl(BASE + path + (query || ""), { method: metodo, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      let j = null; try { j = await r.json(); } catch (e) { /* sin cuerpo */ }
      if (r.status !== 429 || k >= 4) return { status: r.status, j };
      await pausa(espera * 2 * (k + 1)); ultimo = Date.now();
    }
  };
  return {
    get pedidos() { return pedidos; },
    async login() {
      const r = await llamar("POST", "/v1/auth/token", { body: { apiKey: key, module: modulo }, auth: false });
      if (r.status !== 200 || !r.j?.token) throw new Error("1816 no dio el token: HTTP " + r.status + (r.j?.error ? " " + r.j.error : ""));
      token = r.j.token; log("1816: token por " + Math.round((r.j.expiresIn || 0) / 3600) + " h, módulo " + r.j.module);
    },
    get: (path, params, estilo) => llamar("GET", path, { query: qs(params || {}, estilo) }),
    post: (path, body) => llamar("POST", path, { body: body || {} }),
  };
}

async function explora(api, log) {
  const out = { asOf: new Date().toISOString(), pruebas: {} };
  const bal0 = await api.get("/v1/creditos/balance");
  out.balanceAntes = bal0.j;
  const cur = await api.get("/v1/mercado/curvas");
  if (cur.status !== 200) throw new Error("curvas: HTTP " + cur.status + " " + JSON.stringify(cur.j));
  out.curvas = [];
  for (const c of cur.j) {
    const r = await api.get("/v1/mercado/instrumentos", { curvaId: c.id });
    const ins = r.status === 200 && Array.isArray(r.j) ? r.j : [];
    out.curvas.push({ id: c.id, name: c.name, convencionTna: c.convencionTna ?? null, status: r.status,
      instrumentos: ins.map(x => [x.ticker, x.fechaVencimiento ?? null, x.monedaDenom ?? null, x.monedaPago ?? null, x.emisorNombre ?? null]) });
    log(`curva ${c.id} ${c.name}: ${ins.length} instrumentos`);
  }
  // cómo pasa las listas: repetido (tickers=A&tickers=B) o con comas; se guarda el código y qué tickers volvieron
  const t2 = out.curvas.flatMap(c => c.instrumentos.map(i => i[0])).filter(t => /^(GD30|AL30|S30E7|T30J7|TX26)$/.test(t)).slice(0, 2);
  const prueba = t2.length >= 2 ? t2 : ["AL30", "GD30"];
  for (const estilo of ["repetido", "coma"]) {
    const r = await api.get("/v1/mercado/indicadores", { tickers: prueba, campos: ["tea", "duration"] }, estilo);
    out.pruebas["indicadores_" + estilo] = { status: r.status, tickers: Object.keys(r.j?.instrumentos || {}), campos: Object.keys(Object.values(r.j?.instrumentos || {})[0] || {}), error: r.j?.error || null };
  }
  const cf = await api.get("/v1/mercado/cashflow/" + prueba[0], { campos: ["fechaPagoEfectiva", "flujoAmortizacion"] });
  out.pruebas.cashflow = { status: cf.status, ticker: prueba[0], cupones: (cf.j?.cashflow || []).length, error: cf.j?.error || null };
  out.balanceDespues = (await api.get("/v1/creditos/balance")).j;
  out.pedidos = api.pedidos;
  return out;
}

// ---- diario: curvas (hoy, hace una semana y hace un mes), flujos de fondos y montos en circulación (BYMA) → soberanos.json
// Cada curva: los nombres de 1816 que la forman (con el grupo que se muestra), qué tickers entran y en qué moneda se
// calcula la TIR (los bonos en dólares, con el precio en dólares MEP).
// tna: los bonos con cupón, con capitalización semestral sobre 365 días; las letras (dólar linked), simple al vencimiento
export const CURVAS_1816 = [
  { k: "usd", n: "Soberanos en dólares", de: { "Soberanos USD Globales": "Globales", "Soberanos USD Bonares": "Bonares" }, re: /^(GD|AL|AE|AN|AO)\d/, moneda: "mep", conv: "180-365", flujos: true },
  { k: "cer", n: "Bonos CER", de: { "Soberanos ARS CER": "CER" }, re: /^(TX|TZX|X\d)/, moneda: "ars", conv: "180-365" },
  { k: "bopreal", n: "BOPREAL", de: { "BCRA USD": "BOPREAL" }, re: /^BPO/, moneda: "mep", conv: "180-365", flujos: true },
  { k: "linked", n: "Dólar linked", de: { "Soberanos USD Linked": "Dólar linked" }, re: /^(D\d|TZV)/, moneda: "ars", conv: "plazo-rem" },
];
// [tea, durationMod, paridad, tna, tem] por bono
const CAMPOS = ["tea", "durationMod", "paridad", "tna", "tem"];
const BYMA_FICHA = "https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/bnown/fichatecnica/especies/general";
export const corrida = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const finde = d => [0, 6].includes(new Date(d + "T12:00:00Z").getUTCDay());

// indicadores de una fecha; si es feriado (casi todo vacío) prueba el día hábil anterior, hasta 5 veces
export async function indicadoresEn(api, tickers, moneda, fecha, conv) {
  let f = fecha;
  for (let k = 0; k < 5; k++, f = corrida(f, -1)) {
    while (finde(f)) f = corrida(f, -1);
    const datos = {}; let ok = 0, fechaOp = f;
    for (let i = 0; i < tickers.length; i += 50) {
      const r = await api.get("/v1/mercado/indicadores", { tickers: tickers.slice(i, i + 50), campos: CAMPOS, moneda, fechaOperacion: f, convencionTna: conv });
      if (r.status === 402) throw new Error("1816 sin créditos (402)");
      if (r.status !== 200) continue;
      if (r.j?.fechaOperacion) fechaOp = r.j.fechaOperacion;
      for (const [t, x] of Object.entries(r.j?.instrumentos || {})) { datos[t] = [x.tea ?? null, x.durationMod ?? null, x.paridad ?? null, x.tna ?? null, x.tem ?? null]; if (x.tea != null && x.durationMod != null) ok++; }
    }
    if (ok >= Math.max(2, tickers.length * 0.4)) return { fecha: fechaOp, datos };
  }
  return null;
}

async function bymaMonto(fetchImpl, t) {
  try {
    const r = await fetchImpl(BYMA_FICHA, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ symbol: t }), signal: AbortSignal.timeout(20000) });
    const d = ((await r.json()).data || [])[0];
    return d && +d.montoNominal > 0 ? [+d.montoNominal, +d.montoResidual > 0 ? +d.montoResidual : +d.montoNominal] : null;
  } catch (e) { return null; }
}

export async function diario(api, { fetchImpl = fetch, log = console.log, hoy = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10) } = {}) {
  const out = { asOf: new Date().toISOString(), fuente: "1816 (precios de BYMA, 24 hs)", curvas: {}, flujos: {}, montos: {}, errores: {} };
  const cur = await api.get("/v1/mercado/curvas");
  if (cur.status !== 200 || !Array.isArray(cur.j)) throw new Error("curvas: HTTP " + cur.status);
  for (const C of CURVAS_1816) {
    try {
      const grupo = {}, vto = {};
      for (const [nombre, g] of Object.entries(C.de)) {
        const c = cur.j.find(x => x.name === nombre); if (!c) { out.errores[C.k] = "no está la curva " + nombre; continue; }
        const r = await api.get("/v1/mercado/instrumentos", { curvaId: c.id });
        for (const x of (r.status === 200 && Array.isArray(r.j) ? r.j : [])) if (!x.ticker.includes("@") && C.re.test(x.ticker)) { grupo[x.ticker] = g; if (x.fechaVencimiento) vto[x.ticker] = x.fechaVencimiento; }
      }
      const tickers = Object.keys(grupo); if (!tickers.length) continue;
      const fechas = {}, datos = {};
      for (const [k, f] of [["h", hoy], ["s", corrida(hoy, -7)], ["m", corrida(hoy, -30)]]) {
        const r = await indicadoresEn(api, tickers, C.moneda, f, C.conv);
        if (r) { fechas[k] = r.fecha; datos[k] = r.datos; }
      }
      out.curvas[C.k] = { n: C.n, moneda: C.moneda, conv: C.conv, grupo, vto, fechas, datos };
      log(`1816 ${C.k}: ${tickers.length} bonos, ${Object.entries(fechas).map(([k, f]) => k + " " + f).join(", ")}`);
      if (C.flujos) for (const t of tickers) {
        const r = await api.get("/v1/mercado/cashflow/" + t, { campos: ["fechaPagoEfectiva", "fechaPagoTeorica", "flujoAmortizacion", "flujoInteres"] });
        const fl = (r.j?.cashflow || []).map(x => [x.fechaPagoEfectiva || x.fechaPagoTeorica, +(x.flujoAmortizacion || 0), +(x.flujoInteres || 0)]).filter(x => x[0] && x[0] > hoy);
        if (fl.length) out.flujos[t] = fl;
        const m = await bymaMonto(fetchImpl, t); if (m) out.montos[t] = m;
      }
    } catch (e) { out.errores[C.k] = String(e.message || e).slice(0, 200); log(`1816 ${C.k}: ${e.message}`); if (/402/.test(e.message)) break; }
  }
  out.creditos = (await api.get("/v1/creditos/balance")).j?.daily || null;
  out.pedidos = api.pedidos;
  return out;
}

// ---- campos: qué devuelve de verdad cada endpoint (nombres de campos y mensajes de error, sin valores) y si acepta
// campos que la documentación no lista (montos en circulación, vencimientos)
const forma = v => Array.isArray(v) ? (v.length ? [forma(v[0])] : []) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, forma(x)])) : typeof v;
async function campos(api) {
  const out = { asOf: new Date().toISOString(), respuestas: {}, pruebas: {} };
  const ver = async (n, path, params) => { const r = await api.get(path, params); out.respuestas[n] = { status: r.status, forma: forma(r.j), error: r.j?.error || null, message: r.j?.message || null }; return r; };
  await ver("instrumentos_T30J7", "/v1/mercado/instrumentos", { texto: "T30J7" });
  await ver("instrumentos_S30N6", "/v1/mercado/instrumentos", { texto: "S30N6" });
  await ver("instrumentos_TZX27", "/v1/mercado/instrumentos", { texto: "TZX27" });
  await ver("cashflow_T30J7", "/v1/mercado/cashflow/T30J7", { campos: ["fechaPagoEfectiva", "flujoAmortizacion", "flujoInteres", "flujoTotal"] });
  await ver("indicadores_T30J7", "/v1/mercado/indicadores", { tickers: ["T30J7"], campos: ["tea"] });
  for (const c of ["montoCirculante", "montoResidual", "montoEmitido", "valorResidual", "vnResidual", "saldo", "monto", "vencimiento", "montoVencimiento"]) {
    for (const [ep, extra] of [["/v1/mercado/cashflow/T30J7", {}], ["/v1/mercado/indicadores", { tickers: ["T30J7"] }]]) {
      const r = await api.get(ep, { ...extra, campos: [c] });
      out.pruebas[ep.split("/")[3] + ":" + c] = { status: r.status, error: r.j?.error || null, message: (r.j?.message || "").slice(0, 600), forma: r.status === 200 ? forma(r.j) : null };
    }
  }
  // rutas que no están en la documentación
  for (const path of ["/v1/mercado/vencimientos", "/v1/mercado/deuda", "/v1/mercado/perfil-vencimientos", "/v1/mercado/montos", "/v1/mercado/emisiones", "/v1/mercado/licitaciones", "/v1/deuda/vencimientos", "/v1/mercado/instrumentos/T30J7"]) {
    const r = await api.get(path, {});
    out.pruebas["ruta:" + path] = { status: r.status, error: r.j?.error || null, message: (r.j?.message || "").slice(0, 300), forma: r.status === 200 ? forma(r.j) : null };
  }
  out.creditos = (await api.get("/v1/creditos/balance")).j?.daily || null;
  return out;
}

export async function main({ fetchImpl = fetch, log = console.log, root = new URL("../", import.meta.url) } = {}) {
  const key = process.env.API_1816_KEY, modo = process.env.MODO || "diario";
  const archivo = modo === "explora" ? "m1816-explora.json" : modo === "campos" ? "m1816-campos.json" : "soberanos.json";
  if (!key) { log("sin API_1816_KEY en los secretos del repo"); if (modo === "explora") await writeFile(new URL(archivo, root), JSON.stringify({ asOf: new Date().toISOString(), error: "sin API_1816_KEY" })); return; }
  const api = cliente({ key, fetchImpl, log });
  try {
    await api.login();
    if (modo === "explora") await writeFile(new URL(archivo, root), JSON.stringify(await explora(api, log), null, 1));
    else if (modo === "campos") await writeFile(new URL(archivo, root), JSON.stringify(await campos(api), null, 1));
    else {
      const out = await diario(api, { fetchImpl, log });
      // si no vino ninguna curva (1816 caído), queda el archivo anterior
      if (Object.keys(out.curvas).length) await writeFile(new URL(archivo, root), JSON.stringify(out));
      else log("1816: no vino ninguna curva; queda lo que había");
    }
  } catch (e) {
    log("1816: " + e.message);
    if (modo === "explora") await writeFile(new URL(archivo, root), JSON.stringify({ asOf: new Date().toISOString(), error: String(e.message).slice(0, 300) }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
