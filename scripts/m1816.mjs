// API de 1816 (módulo mercado). La clave está en el secreto API_1816_KEY del repo: se cambia por un token de 24 h y no
// se escribe en ningún archivo ni en el log. Límite del plan: 1 pedido por segundo y créditos por día.
//
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

export function cliente({ key, fetchImpl = fetch, log = console.log, espera = +(process.env.ESPERA ?? 1100) }) {
  let token = null, ultimo = 0, pedidos = 0;
  const llamar = async (metodo, path, { query, body, auth = true } = {}) => {
    const falta = ultimo + espera - Date.now(); if (falta > 0) await pausa(falta);
    ultimo = Date.now(); pedidos++;
    const headers = { "User-Agent": UA, Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (auth) headers.Authorization = "Bearer " + token;
    const r = await fetchImpl(BASE + path + (query || ""), { method: metodo, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    let j = null; try { j = await r.json(); } catch (e) { /* sin cuerpo */ }
    return { status: r.status, j };
  };
  return {
    get pedidos() { return pedidos; },
    async login() {
      const r = await llamar("POST", "/v1/auth/token", { body: { apiKey: key, module: "mercado" }, auth: false });
      if (r.status !== 200 || !r.j?.token) throw new Error("1816 no dio el token: HTTP " + r.status + (r.j?.error ? " " + r.j.error : ""));
      token = r.j.token; log("1816: token por " + Math.round((r.j.expiresIn || 0) / 3600) + " h, módulo " + r.j.module);
    },
    get: (path, params, estilo) => llamar("GET", path, { query: qs(params || {}, estilo) }),
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

export async function main({ fetchImpl = fetch, log = console.log, root = new URL("../", import.meta.url) } = {}) {
  const key = process.env.API_1816_KEY, modo = process.env.MODO || "explora";
  if (!key) { await writeFile(new URL("m1816-explora.json", root), JSON.stringify({ asOf: new Date().toISOString(), error: "sin API_1816_KEY en los secretos del repo" })); log("sin API_1816_KEY"); return; }
  const api = cliente({ key, fetchImpl, log });
  try {
    await api.login();
    if (modo === "explora") await writeFile(new URL("m1816-explora.json", root), JSON.stringify(await explora(api, log), null, 1));
  } catch (e) {
    log("1816: " + e.message);
    await writeFile(new URL("m1816-explora.json", root), JSON.stringify({ asOf: new Date().toISOString(), error: String(e.message).slice(0, 300) }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
