/**
 * Índice «archivo citado → páginas» del manual interno del soporte (T12-1 b), sacado de evidencia/**.json. Lo lee el aviso
 * al editar del workspace (scripts/aviso-manual-soporte.py): quien cambia un archivo de una app que cita una página se entera
 * en ese mismo trabajo. tests/unit/services/support/manual-citas-indice.test.ts lo regenera en memoria y lo compara con el
 * archivo, así que nunca se queda viejo.
 *
 * Uso (desde avoqado-server): npx ts-node --transpile-only -r tsconfig-paths/register scripts/support-eval/manual/citas-indice.ts
 */
import fs from 'fs'
import path from 'path'
import { MANUAL_EVAL_DIRECTORY, readManualEvidence, type ManualEvidence } from './esquema'

export const CITATION_INDEX_FILE = path.join(MANUAL_EVAL_DIRECTORY, 'citas-indice.json')
/** Fijo, no una fecha: regenerar sin cambios no deja diferencia y la prueba compara el archivo entero. */
export const CITATION_INDEX_NOTE =
  'npx ts-node --transpile-only -r tsconfig-paths/register scripts/support-eval/manual/citas-indice.ts (no se edita a mano)'
const CITED = ['pasos', 'permisos', 'plan', 'sinInternet', 'rutas'] as const

export interface CitationIndex {
  generado: string
  /** `<sourceRepo>:<archivo>` → las páginas que lo citan, con el sourceRef de su evidencia. */
  porArchivo: Record<string, { pagina: string; sourceRef: string }[]>
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function buildCitationIndex(evidences: ManualEvidence[]): CitationIndex {
  const files = new Map<string, Map<string, string>>()
  for (const e of evidences)
    for (const kind of CITED)
      for (const { archivo } of e[kind] as { archivo: string }[]) {
        const key = `${e.sourceRepo}:${archivo}`
        files.set(key, (files.get(key) ?? new Map()).set(e.pagina, e.sourceRef))
      }
  const porArchivo: CitationIndex['porArchivo'] = {}
  for (const key of [...files.keys()].sort(byText))
    porArchivo[key] = [...files.get(key)!].sort(([a], [b]) => byText(a, b)).map(([pagina, sourceRef]) => ({ pagina, sourceRef }))
  return { generado: CITATION_INDEX_NOTE, porArchivo }
}

/** El texto del archivo: el que escribe el script y el que la prueba compara byte por byte (orden y formato incluidos). */
export const citationIndexText = (index: CitationIndex) => `${JSON.stringify(index, null, 2)}\n`

/** Cada evidencia de `<root>/evidencia/<app>/<categoría>/<tarea>.json`, validada con evidenceSchema, por id. */
export function readAllEvidence(root = MANUAL_EVAL_DIRECTORY): ManualEvidence[] {
  const base = path.join(root, 'evidencia')
  const walk = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
      : []
  return walk(base)
    .filter(f => f.endsWith('.json'))
    .map(f =>
      path
        .relative(base, f)
        .split(path.sep)
        .join('/')
        .replace(/\.json$/, ''),
    )
    .sort(byText)
    .map(id => readManualEvidence(id, root)!)
}

if (require.main === module) {
  const index = buildCitationIndex(readAllEvidence())
  fs.writeFileSync(CITATION_INDEX_FILE, citationIndexText(index))
  console.log(`${Object.keys(index.porArchivo).length} archivos citados → ${path.relative(process.cwd(), CITATION_INDEX_FILE)}`)
}
