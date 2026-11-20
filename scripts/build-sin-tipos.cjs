#!/usr/bin/env node
// Build de producción: emite dist/ archivo por archivo (ts.transpileModule), sin armar el programa entero.
// Por qué (20-nov-2026): `tsc -p tsconfig.build.json` ya pide más de 7 GB de heap (medido: 8 GB pasa con 7.8 GiB de RSS,
// 7 GB truena) y la máquina de build de Render tiene 8 GiB: el deploy de f423c3029 murió por falta de memoria.
// Los tipos NO se dejan de revisar: el CI corre `npm run typecheck` sobre el MISMO commit antes de desplegar.
// ponytail: transpilar suelto no ve tipos de otros archivos (const enum entre archivos, re-exportar sólo un tipo).
// Hoy el dist sale idéntico al de tsc (comprobado con diff); si eso cambia, el paso a TypeScript 7 (2.7 GB) es la salida.
const ts = require('typescript')
const fs = require('fs')
const path = require('path')

// `--comparar <dist de tsc> <dist de este script>`: el CI lo corre antes de desplegar (Codex r1 de #533). Transpilar suelto
// no ve otros archivos (const enum entre archivos, imports con alias o con `.js` hacia fuera del include): si algún día
// sale distinto de tsc, el CI se pone rojo en vez de desplegar un dist que no arranca. .js idénticos; .json mismo contenido.
if (process.argv[2] === '--comparar') {
  const [a, b] = process.argv.slice(3).map(d => path.resolve(d))
  const listar = (raiz, dir = raiz) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap(e => (e.isDirectory() ? listar(raiz, path.join(dir, e.name)) : [path.relative(raiz, path.join(dir, e.name))]))
  const enA = new Set(listar(a))
  const enB = new Set(listar(b))
  const malos = [...new Set([...enA, ...enB])].sort().filter(rel => {
    if (!enA.has(rel) || !enB.has(rel)) return true
    const x = fs.readFileSync(path.join(a, rel))
    const y = fs.readFileSync(path.join(b, rel))
    if (rel.endsWith('.json')) return JSON.stringify(JSON.parse(x)) !== JSON.stringify(JSON.parse(y))
    return !x.equals(y)
  })
  for (const rel of malos)
    console.error(`distinto de tsc: ${rel}${enA.has(rel) ? '' : ' (sólo aquí)'}${enB.has(rel) ? '' : ' (falta aquí)'}`)
  console.log(`build-sin-tipos --comparar: ${enA.size} archivos de tsc, ${malos.length} distintos`)
  process.exit(malos.length ? 1 : 0)
}

const proyecto = process.argv[2] || 'tsconfig.build.json'
const cfg = ts.getParsedCommandLineOfConfigFile(
  proyecto,
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: d => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    },
  },
)
if (cfg.errors.length) {
  for (const d of cfg.errors) console.error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  process.exit(1)
}
const opciones = { ...cfg.options, outDir: process.argv[3] ? path.resolve(process.argv[3]) : cfg.options.outDir }
const raiz = opciones.rootDir || path.dirname(path.resolve(proyecto))

const destinoDe = archivo => path.join(opciones.outDir, path.relative(raiz, archivo))

// tsc también emite lo que se importa con ruta relativa desde fuera del `include` (p. ej. prisma/seed.ts → scripts/) y copia
// los .json importados (resolveJsonModule). Se sigue igual, con imports relativos: sin armar el programa.
const pendientes = cfg.fileNames.filter(f => !f.endsWith('.d.ts')).map(f => path.resolve(f))
const vistos = new Set(pendientes)
let errores = 0
let escritos = 0
while (pendientes.length) {
  const archivo = pendientes.shift()
  const texto = fs.readFileSync(archivo, 'utf8')
  for (const { fileName: spec } of ts.preProcessFile(texto, true, true).importedFiles) {
    if (!spec.startsWith('.')) continue
    const base = path.resolve(path.dirname(archivo), spec)
    const candidato = ['', '.ts', '.tsx', '/index.ts'].map(s => base + s).find(f => fs.existsSync(f) && fs.statSync(f).isFile())
    if (!candidato || vistos.has(candidato) || candidato.endsWith('.d.ts')) continue
    vistos.add(candidato)
    if (candidato.endsWith('.json')) {
      fs.mkdirSync(path.dirname(destinoDe(candidato)), { recursive: true })
      fs.copyFileSync(candidato, destinoDe(candidato))
      escritos++
    } else if (/\.tsx?$/.test(candidato)) pendientes.push(candidato)
  }
  const salida = ts.transpileModule(texto, {
    compilerOptions: opciones,
    fileName: archivo,
    reportDiagnostics: true,
  })
  for (const d of salida.diagnostics || []) {
    if (d.category !== ts.DiagnosticCategory.Error) continue
    errores++
    console.error(`${archivo}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
  }
  const destino = destinoDe(archivo).replace(/\.(m|c)?tsx?$/, (_, m) => `.${m || ''}js`)
  fs.mkdirSync(path.dirname(destino), { recursive: true })
  fs.writeFileSync(destino, salida.outputText)
  escritos++
}
if (errores) {
  console.error(`build-sin-tipos: ${errores} error(es) de sintaxis`)
  process.exit(1)
}
console.log(`build-sin-tipos: ${escritos} archivos en ${path.relative(process.cwd(), opciones.outDir) || '.'}`)
