// Vencimientos del Tesoro de 1816 (gráfico del Informe): la tabla no está en la API de 1816, así que la trae un favorito
// del navegador desde la pantalla de 1816 con la sesión de quien la tiene abierta. La página la manda acá y el backend la
// guarda en el repositorio (venc1816.json), así se ve desde cualquier navegador. Escribe con un token de GitHub que vive
// solo en Render (GITHUB_TOKEN: fine-grained, este repositorio, Contents de lectura y escritura).
export const VENC_PATH = "venc1816.json";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DIA = 86400000;

// lo que manda el favorito: { v: 1, asOf, nota, fx, rows: [[fecha de pago, instrumento, curva, ajuste, millones de $]] }.
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
  return { v: 1, asOf: d.asOf, nota, fx: +d.fx.toFixed(4), rows };
}

// a lo sumo 6 subidas por hora (el favorito se toca después de cada licitación)
const subidas = [];
export function limiteSubidas(now = Date.now()) {
  while (subidas.length && subidas[0] < now - 3600e3) subidas.shift();
  if (subidas.length >= 6) return false;
  subidas.push(now); return true;
}

// escribe venc1816.json con la API de contenidos de GitHub. No pisa una licitación más nueva que la que ya está
export async function subirVenc1816(d, { fetchImpl, token, repo = "juanfranciscopisano/tradingweb", branch = "main", now = new Date() }) {
  if (!token) { const e = new Error("falta GITHUB_TOKEN en Render"); e.status = 503; throw e; }
  const datos = validarVenc1816(d, now);
  const api = `https://api.github.com/repos/${repo}/contents/${VENC_PATH}`;
  const h = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tradingweb-backend" };
  const g = await fetchImpl(api + "?ref=" + branch, { headers: h, signal: AbortSignal.timeout(15000) });
  let sha = null;
  if (g.status === 200) {
    const cur = await g.json(); sha = cur.sha;
    try {
      const prev = JSON.parse(Buffer.from(cur.content || "", "base64").toString("utf8"));
      if (prev.asOf > datos.asOf) { const e = new Error("ya está la licitación del " + prev.asOf + ", más nueva"); e.status = 409; throw e; }
    } catch (e) { if (e.status) throw e; }
  } else if (g.status !== 404) { const e = new Error(g.status === 401 || g.status === 403 ? "GitHub rechazó el token (" + g.status + "): revisá que sea de este repo y con Contents de lectura y escritura" : "GitHub respondió " + g.status + " al leer"); e.status = 502; throw e; }
  const out = { ...datos, subido: now.toISOString() };
  const p = await fetchImpl(api, {
    method: "PUT", headers: { ...h, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ message: "1816: vencimientos del Tesoro (licitación del " + datos.asOf + ")", content: Buffer.from(JSON.stringify(out)).toString("base64"), branch, ...(sha ? { sha } : {}) }),
  });
  if (!p.ok) { const e = new Error(p.status === 401 || p.status === 403 ? "GitHub rechazó el token (" + p.status + "): falta permiso de escritura en Contents" : "GitHub respondió " + p.status + " al guardar"); e.status = 502; throw e; }
  return { ok: true, asOf: datos.asOf, filas: datos.rows.length, subido: out.subido };
}
