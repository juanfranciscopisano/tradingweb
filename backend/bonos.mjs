// Precios de bonos y letras del Tesoro para la pestaña Bonos: los paneles de títulos públicos y de letras de los datos
// abiertos de BYMA (20 minutos de demora), con todas las especies (también las que no operaron hoy, con su cierre
// anterior) y los tres plazos. La clasificación por grupo la hace la página, que es la que también lee la fuente de
// respaldo cuando BYMA no responde.
export const BYMA_FREE = "https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/";
export const PANELES = ["public-bonds", "lebacs"];

const num = v => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);

// una fila por especie y plazo: settlementType 1 = contado inmediato, 2 = 24 hs, 3 = 48 hs
export function filaByma(x, panel) {
  return {
    s: String(x.symbol || "").trim(), p: String(x.settlementType ?? ""), ult: num(x.trade), cie: num(x.closingPrice), ant: num(x.previousClosingPrice),
    hora: String(x.tradeHour || "").slice(0, 8), vto: String(x.maturityDate || "").slice(0, 10), mon: x.denominationCcy || "", panel,
  };
}

// todas las páginas de cada panel; si un panel no responde siguen los otros, y si no responde ninguno, error
export async function bymaBonos(fetchImpl, { paginas = 10, timeout = 15000 } = {}) {
  const filas = [], errores = [];
  for (const panel of PANELES) {
    try {
      for (let pg = 1; pg <= paginas; pg++) {
        const r = await fetchImpl(BYMA_FREE + panel, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ excludeZeroPxAndQty: false, T2: true, T1: true, T0: true, page_number: pg }), signal: AbortSignal.timeout(timeout),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json(), d = Array.isArray(j) ? j : j.data || [];
        for (const x of d) if (x && x.symbol) filas.push(filaByma(x, panel));
        const tot = j?.content?.page_count ?? j?.page_count ?? 1;
        if (!d.length || pg >= tot) break;
      }
    } catch (e) { errores.push(panel + ": " + e.message + (e.cause ? " (" + (e.cause.code || e.cause.message || e.cause) + ")" : "")); }
  }
  if (!filas.length) throw new Error("BYMA no respondió (" + errores.join("; ") + ")");
  return { filas, errores };
}
