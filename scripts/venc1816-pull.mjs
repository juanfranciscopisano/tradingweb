// Pasa a buscar al backend la tabla de vencimientos del Tesoro de 1816 que mandó la página (la trajo el favorito) y, si es
// más nueva que la del repositorio, la escribe en venc1816.json. El commit lo hace la Action con su propio permiso.
import fs from "node:fs";
import { validarVenc1816, masNueva, VENC_PATH } from "../backend/venc1816.mjs";

const BASE = process.env.BACKEND_URL || "https://tradingweb1.onrender.com";

async function pedir() {
  // Render gratis se duerme: el primer pedido puede tardar casi un minuto en despertarlo
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(BASE + "/api/venc1816", { headers: { "User-Agent": "tradingweb-actions" }, signal: AbortSignal.timeout(90000) });
      if (r.status === 204) return null;
      if (r.ok) return await r.json();
      console.log("backend respondió", r.status);
    } catch (e) { console.log("backend sin respuesta:", e.message); }
    await new Promise(r => setTimeout(r, 5000));
  }
  return null;
}

const d = await pedir();
if (!d) { console.log("Nada pendiente en el backend"); process.exit(0); }
let datos;
try { datos = validarVenc1816(d); } catch (e) { console.log("Tabla inválida, no se guarda:", e.message); process.exit(0); }
let prev = null;
try { prev = JSON.parse(fs.readFileSync(VENC_PATH, "utf8")); } catch (e) {}
if (!masNueva(datos, prev)) { console.log("La del repositorio ya es la licitación del", prev.asOf, "(o más nueva)"); process.exit(0); }
const out = { ...datos, subido: new Date().toISOString() };
fs.writeFileSync(VENC_PATH, JSON.stringify(out));
console.log("venc1816.json: licitación del", datos.asOf, "con", datos.rows.length, "filas");
