// Vencimientos del Tesoro de 1816 (gráfico del Informe): la tabla no está en la API de 1816, así que la trae un favorito
// del navegador desde la pantalla de 1816 con la sesión de quien la tiene abierta. La página la manda acá, el backend la
// valida y la tiene en memoria, y la Action venc1816 la pasa a buscar y la guarda en el repositorio (venc1816.json) con el
// permiso propio de GitHub Actions: no hace falta ningún token. Si Render se duerme antes de que pase la Action, la página
// la vuelve a mandar en la visita siguiente, porque la de la web todavía es más vieja.
export const VENC_PATH = "venc1816.json";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ISO_T = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DIA = 86400000;

// lo que manda el favorito: { v: 1, asOf, nota, fx, cargado, rows: [[fecha de pago, instrumento, curva, ajuste, millones de $]] }.
// cargado es cuándo la trajo el favorito: con la misma licitación, vale la traída más tarde.
// Se valida todo: el endpoint es público y lo que pasa queda en el repositorio
export function validarVenc1816(d, now = new Date()) {
  if (!d || typeof d !== "object") throw new Error("no es una tabla");
  if (!ISO.test(d.asOf || "")) throw new Error("fecha de la licitación inválida");
  const t = Date.parse(d.asOf + "T12:00:00Z");
  if (!(t > now.getTime() - 120 * DIA && t < now.getTime() + 2 * DIA)) throw new Error("fecha de la licitación fuera de rango (" + d.asOf + ")");
  if (!(typeof d.fx === "number" && d.fx > 50 && d.fx < 100000)) throw new Error("tipo de cambio inválido");
  if (!Array.isArray(d.rows) || d.rows.length < 5 || d.rows.length > 20000) throw new Error("cantidad de filas inválida");
  const txt = (x, n) => typeof x === "string" && x.length > 0 && x.length <= n && !/[<>]/.test(x);
  const rows = d.rows.map((r, i) => {
    if (!Array.isArray(r) || r.length !== 5 || !ISO.test(r[0]) || !txt(r[1], 40) || !txt(r[2], 60) || !txt(r[3], 30)
      || typeof r[4] !== "number" || !isFinite(r[4]) || r[4] < 0 || r[4] > 1e9) throw new Error("fila " + (i + 1) + " inválida");
    return [r[0], r[1], r[2], r[3], Math.round(r[4] * 100) / 100];
  });
  const nota = typeof d.nota === "string" ? d.nota.replace(/[<>]/g, "").slice(0, 200) : "";
  const cargado = typeof d.cargado === "string" && ISO_T.test(d.cargado) && Date.parse(d.cargado) < now.getTime() + 2 * DIA ? d.cargado : "";
  return { v: 1, asOf: d.asOf, nota, fx: +d.fx.toFixed(4), cargado, rows };
}

// a es más nueva que b: licitación posterior o, la misma, traída más tarde
export const masNueva = (a, b) => !!a && (!b || a.asOf > b.asOf || (a.asOf === b.asOf && (a.cargado || "") > (b.cargado || "")));
export const mismaTabla = (a, b) => !!a && !!b && a.asOf === b.asOf && (a.cargado || "") === (b.cargado || "");

// a lo sumo 6 tablas distintas por hora (el favorito se toca después de cada licitación)
const subidas = [];
export function limiteSubidas(now = Date.now()) {
  while (subidas.length && subidas[0] < now - 3600e3) subidas.shift();
  if (subidas.length >= 6) return false;
  subidas.push(now); return true;
}

// la tabla más nueva recibida desde que arrancó el backend, hasta que la pase a buscar la Action
let pendiente = null;
export const verPendiente = () => pendiente;
export function _reset() { pendiente = null; subidas.length = 0; }

// lo que hace POST /api/venc1816: { status, body }
export function recibirVenc1816(d, now = new Date()) {
  let datos;
  try { datos = validarVenc1816(d, now); } catch (e) { return { status: 400, body: { error: e.message } }; }
  const resp = () => ({ status: 200, body: { ok: true, asOf: datos.asOf, filas: datos.rows.length, pendiente: true } });
  if (mismaTabla(datos, pendiente)) return resp();          // la misma que ya está: no cuenta para el límite
  if (pendiente && !masNueva(datos, pendiente)) return { status: 409, body: { error: "ya tengo la licitación del " + pendiente.asOf + ", más nueva" } };
  if (!limiteSubidas(now.getTime())) return { status: 429, body: { error: "demasiadas subidas en la última hora" } };
  pendiente = { ...datos, recibido: now.toISOString() };
  return resp();
}
