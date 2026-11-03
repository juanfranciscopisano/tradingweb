// Datos por entidad del BCRA ("Información de entidades financieras"): cada mes publica un .7z con TXT de todas las
// entidades (todos los meses desde julio de 2011; antes, los cierres de año desde 2006) y un PDF por entidad (desde 2001).
// Corre en GitHub Actions (.github/workflows/bcra.yml). Por ahora, el diagnóstico: qué traen los archivos.
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const BASE = "https://www.bcra.gob.ar/archivos/Pdfs/PublicacionesEstadisticas/Entidades/";
const UA = "Mozilla/5.0 (tradingweb; datos de bancos)";
const YUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const isoOf = t => new Date(t * 1000).toISOString().slice(0, 10);

export async function diagnostico({ fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "latin1", maxBuffer: 1 << 29 }); } catch (e) { return "ERR " + String(e.stderr || e.message).slice(0, 300); } };
  const dir = await mkdtemp(join(tmpdir(), "bcra-"));
  const bajar = async (url, dest) => {
    const r = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const b = Buffer.from(await r.arrayBuffer()); await writeFile(dest, b); return b.length;
  };
  for (const m of ["202607", "201107", "200612"]) {
    try {
      const f = join(dir, m + "d.7z"), n = await bajar(BASE + m + "d.7z", f), out = join(dir, m);
      log(`\n===== ${m}d.7z: ${(n / 1e6).toFixed(1)} MB`);
      sh("7z", ["x", "-y", "-o" + out, f]);
      const lista = sh("bash", ["-c", `cd '${out}' && find . -type f -printf '%s %p\\n' | sort -k2`]);
      log(lista.slice(0, 8000));
      for (const p of lista.split("\n").map(l => l.split(" ").slice(1).join(" ")).filter(p => /\.txt$/i.test(p)).slice(0, 80)) {
        const head = sh("bash", ["-c", `cd '${out}' && head -c 900 '${p}'`]);
        log(`-- ${p}: ${head.replace(/\r/g, "").split("\n").slice(0, 4).join(" ⏎ ").slice(0, 700)}`);
      }
      if (m === "202607") for (const p of lista.split("\n").map(l => l.split(" ").slice(1).join(" ")).filter(p => /\.pdf$/i.test(p)).slice(0, 2)) {
        const t = sh("pdftotext", ["-layout", join(out, p), "-"]);
        log(`-- diccionario ${p}:\n` + t.split("\n").slice(0, 400).join("\n").slice(0, 20000));
      }
    } catch (e) { log(`${m}d.7z: ${e.message}`); }
  }
  for (const m of ["200107", "200312", "200712", "201012"]) {
    try {
      const f = join(dir, m + "e.pdf"), n = await bajar(BASE + m + "e.pdf", f);
      const t = sh("pdftotext", ["-layout", f, "-"]), lines = t.split("\n"), i = lines.findIndex(l => /GALICIA/i.test(l));
      log(`\n===== ${m}e.pdf: ${(n / 1e6).toFixed(1)} MB, ${lines.length} líneas, Galicia en la línea ${i}`);
      log(lines.slice(0, 40).join("\n").slice(0, 3000));
      log("...\n" + lines.slice(Math.max(0, i - 5), i + 140).join("\n").slice(0, 12000));
    } catch (e) { log(`${m}e.pdf: ${e.message}`); }
  }
  for (const s of ["GGAL.BA", "BMA.BA", "BBAR.BA", "FRAN.BA", "BHIP.BA", "BPAT.BA", "SUPV.BA", "VALO.BA", "GGAL", "BMA", "BBAR", "BFR", "^MERV"]) {
    try {
      const r = await fetchImpl(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?period1=${Date.UTC(1999, 11, 1) / 1000}&period2=${Math.floor(Date.now() / 1000)}&interval=1mo&events=splits`, { headers: { "User-Agent": YUA, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      const j = await r.json(), x = j?.chart?.result?.[0], ts = x?.timestamp || [], cl = x?.indicators?.quote?.[0]?.close || [];
      const k = cl.findIndex(v => v > 0);
      log(`${s}: HTTP ${r.status}, ${ts.length} meses, primero ${k >= 0 ? isoOf(ts[k]) + " " + cl[k] : "—"}, último ${ts.length ? isoOf(ts.at(-1)) + " " + cl.at(-1) : "—"}; splits ${JSON.stringify(Object.values(x?.events?.splits || {}).map(v => isoOf(v.date) + " " + v.splitRatio))}`);
    } catch (e) { log(`${s}: ${e.message}`); }
  }
}

// segundo diagnóstico: la estructura técnico-contable (balances, balance histórico, indicadores, deudores) y la
// información histórica del último archivo, con el formato de cada tema y las primeras y últimas líneas de Galicia
export async function diagnostico2({ fetchImpl = globalThis.fetch, log = console.log, mes = "202607" } = {}) {
  const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "latin1", maxBuffer: 1 << 29 }); } catch (e) { return "ERR " + String(e.stderr || e.message).slice(0, 300); } };
  const dir = await mkdtemp(join(tmpdir(), "bcra-"));
  const r = await fetchImpl(BASE + mes + "d.7z", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(180000) });
  const f = join(dir, "a.7z"); await writeFile(f, Buffer.from(await r.arrayBuffer()));
  const out = join(dir, "x"); sh("7z", ["x", "-y", "-o" + out, f]);
  log(sh("bash", ["-c", `cd '${out}' && find . -type d | sort | while read d; do n=$(find "$d" -maxdepth 1 -type f | wc -l); s=$(du -sk "$d" | cut -f1); echo "$d  $n archivos  $s KB"; done`]).slice(0, 12000));
  const temas = sh("bash", ["-c", `cd '${out}' && find . -type d \\( -ipath '*Tec_Cont*' -o -ipath '*Info_Hist*' -o -ipath '*Nomina*' \\) | sort`]).split("\n").filter(Boolean);
  for (const d of temas) {
    log(`\n##### ${d}`);
    log(sh("bash", ["-c", `cd '${out}/${d}' && ls -la | head -12 && for f in $(ls | grep -i -E '^formato'); do echo "--- $f"; cat "$f"; done`]).slice(0, 6000));
    log(sh("bash", ["-c", `cd '${out}/${d}' && for f in $(ls | grep -i -E '^(00007|galicia|completo|nomina)' | head -3); do echo "--- $f ($(wc -l < "$f") líneas)"; head -6 "$f"; echo "   ..."; tail -3 "$f"; done`]).slice(0, 8000));
  }
}

// tercer diagnóstico: el balance histórico (balhist.txt): desde cuándo hay datos de cada banco y qué cuentas usa en
// cada época (las de primer nivel y las de patrimonio), y el plan de cuentas con su fecha de baja
export async function diagnostico3({ fetchImpl = globalThis.fetch, log = console.log, mes = "202607" } = {}) {
  const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "latin1", maxBuffer: 1 << 30 }); } catch (e) { return "ERR " + String(e.stderr || e.message).slice(0, 300); } };
  const dir = await mkdtemp(join(tmpdir(), "bcra-"));
  const r = await fetchImpl(BASE + mes + "d.7z", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(180000) });
  const f = join(dir, "a.7z"); await writeFile(f, Buffer.from(await r.arrayBuffer()));
  sh("7z", ["e", "-y", "-o" + dir, f, "-r", "balhist.txt", "cuentas.txt"]);
  const B = join(dir, "balhist.txt");
  log(sh("bash", ["-c", `head -5 '${B}'; echo ...; tail -3 '${B}'; echo; cut -f1 '${B}' | sort | uniq -c | sort -rn | head -5; echo "entidades: $(cut -f1 '${B}' | sort -u | wc -l)"; echo "fechas: $(cut -f2 '${B}' | sort -u | head -3 | tr '\n' ' ') ... $(cut -f2 '${B}' | sort -u | tail -3 | tr '\n' ' ') ($(cut -f2 '${B}' | sort -u | wc -l))"`]));
  for (const c of ["00007", "00285", "00017", "00027", "00034", "00044", "00198"]) {
    log(`\n===== ${c}: ` + sh("bash", ["-c", `grep -P '^"?${c}"?\t' '${B}' > '${dir}/e.txt'; wc -l < '${dir}/e.txt'; cut -f2 '${dir}/e.txt' | sort -u | head -2 | tr '\n' ' '; echo -n '... '; cut -f2 '${dir}/e.txt' | sort -u | tail -1; echo "meses: $(cut -f2 '${dir}/e.txt' | sort -u | wc -l)"`]));
    for (const m of ["200001", "200012", "200512", "201012", "201712", "202607"]) {
      log(`  ${m}: ` + sh("bash", ["-c", `grep -P '\t"?${m}"?\t' '${dir}/e.txt' | awk -F'\t' '{gsub(/"/,"",$3); if ($3 ~ /^[1-9]0000$|^[1-9]00000$|^4[0-9]0000$|^65[0-9]000$|^41[0-9]00[0-9]$/) printf "%s=%s  ", $3, $4}'`]).slice(0, 900));
    }
  }
  const C = join(dir, "cuentas.txt");
  log("\ncuentas de primer nivel y de patrimonio:\n" + sh("bash", ["-c", `awk -F'\t' '{c=$1; gsub(/"/,"",c); if (c ~ /^[1-9]00000$|^4[0-9]0000$|^65[0-9]000$|^41[0-9][0-9]0[0-9]$|^5[0-9]0000$|^6[0-9]0000$/) print}' '${C}' | head -120`]).slice(0, 12000));
}

export async function main({ modo = process.env.MODO || "diario", log = console.log } = {}) {
  if (modo === "diagnostico3") return diagnostico3({ log });
  if (modo === "diagnostico") return diagnostico({ log });
  if (modo === "diagnostico2") return diagnostico2({ log });
  log("bcra: modo " + modo + " todavía no implementado");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch(e => { console.error(e); process.exit(1); });
