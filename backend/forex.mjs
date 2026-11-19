// La rueda de cambios de A3 Mercados (ex MAE), para la tarjeta "Dólar mayorista" de la página: los mismos datos que
// muestra su pantalla pública de Forex (marketdata.mae.com.ar/forex, en tiempo real): volumen, monto, mínimo, máximo y
// último de cada especie, y las mejores puntas compradora y vendedora de la rueda CAM1, minuto a minuto.
// A3 no deja leerlos desde otra página (su API solo le responde a su sitio), así que los pide el backend: sin clave y
// sin hacerse pasar por su sitio. Es la API interna de esa pantalla, no un servicio que A3 ofrezca: si deja de
// responder, la página queda con el enlace a la pantalla de A3. No trae la caja de puntas (profundidad ni cantidades).
export const A3_API = "https://api.marketdata.mae.com.ar/api/mercado/";
// las puntas que se piden: el dólar contra pesos de contado inmediato (UST$T 000) en la rueda CAM1
export const A3_PUNTAS = { codTitulo: "UST$T", moneda: "T", segmento: "CAM1", plazo: "000" };

const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const pos = v => (num(v) > 0 ? v : null);

// una fila por especie, plazo y segmento. VWAP: monto en pesos / volumen en dólares, el precio promedio ponderado del
// día. Ayer: el cierre anterior que informa A3 o, si no viene, el que sale del último y de su variación
export function filaForex(x) {
  const vol = pos(x.volumen), monto = pos(x.monto), ult = pos(x.ultimo), v = num(x.variacion);
  return {
    t: String(x.ticker || "").trim(), plazo: String(x.plazo || ""), seg: x.codigoSegmento === "M" || /mayor/i.test(x.segmento || "") ? "M" : "N",
    desc: String(x.descripcion || "").replace(/\s+/g, " ").trim(),
    vol, monto, min: pos(x.minimo), max: pos(x.maximo), ult, var: v,
    vwap: vol && monto ? +(monto / vol).toFixed(4) : null,
    ayer: pos(x.cierreAnterior) || (ult && v != null && v > -100 ? +(ult / (1 + v / 100)).toFixed(2) : null),
  };
}

// las puntas: [["10:01", 1555], ...] por lado. A3 manda la hora de Buenos Aires rotulada como UTC (la rueda abre a las
// 10 y el primer dato dice 10:01Z); si algún día la manda en UTC de verdad (primer dato después de las 12:30Z), se
// corre tres horas
export function puntasForex(o) {
  const serie = a => (Array.isArray(a) ? a : []).filter(p => p && isFinite(p.time) && p.value > 0).map(p => [+p.time, +p.value]).sort((a, b) => a[0] - b[0]);
  const bid = serie(o?.bid), offer = serie(o?.offer);
  const t0 = Math.min(bid[0]?.[0] ?? Infinity, offer[0]?.[0] ?? Infinity);
  const corr = isFinite(t0) && t0 % 86400 >= 12.5 * 3600 ? -3 * 3600 : 0;
  const hm = t => new Date((t + corr) * 1000).toISOString().slice(11, 16);
  return { bid: bid.map(([t, v]) => [hm(t), v]), offer: offer.map(([t, v]) => [hm(t), v]) };
}

// tres pedidos a la vez, 8 segundos cada uno. Sin las filas no hay nada que mostrar: error. Las puntas y el estado de
// la rueda pueden faltar
export async function a3Forex(fetchImpl, { timeout = 8000, now = new Date() } = {}) {
  const hoy = new Date(now.getTime() - 3 * 3600e3).toISOString().slice(0, 10);   // el día de Buenos Aires
  const get = async u => {
    const r = await fetchImpl(A3_API + u, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (tradingweb; rueda de cambios)" }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const txt = await r.text();
    try { return JSON.parse(txt); } catch (e) { throw new Error("no devolvió datos (" + txt.slice(0, 60).replace(/\s+/g, " ") + ")"); }
  };
  const motivo = r => String(r.reason?.message || r.reason) + (r.reason?.cause ? " (" + (r.reason.cause.code || r.reason.cause.message || r.reason.cause) + ")" : "");
  const [datos, ofertas, estado] = await Promise.allSettled([
    get("datos/FOR"), get("forex/ofertasgrafico?oTitulo=" + encodeURIComponent(JSON.stringify({ ...A3_PUNTAS, fechaConsulta: hoy }))), get("estado")]);
  if (datos.status !== "fulfilled" || !Array.isArray(datos.value)) throw new Error("A3 no respondió (" + (datos.status === "fulfilled" ? "respuesta inesperada" : motivo(datos)) + ")");
  const errores = [];
  if (ofertas.status !== "fulfilled") errores.push("puntas: " + motivo(ofertas));
  return {
    fuente: "A3 Mercados, Market Data (tiempo real)", dia: hoy, estado: estado.status === "fulfilled" ? estado.value?.estado || null : null,
    filas: datos.value.filter(x => x && x.ticker).map(filaForex),
    puntas: { titulo: A3_PUNTAS.codTitulo + " " + A3_PUNTAS.plazo, ...puntasForex(ofertas.status === "fulfilled" ? ofertas.value : null) },
    errores,
  };
}
