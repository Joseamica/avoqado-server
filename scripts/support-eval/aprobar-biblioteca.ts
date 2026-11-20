/**
 * Manifiesto de la biblioteca aprobada del soporte por WhatsApp (modo híbrido).
 *
 * Sin argumentos: escribe `src/assets/mcp-support-help/library-approved.json` con el sha256 ACTUAL de cada guía (públicas y
 * del manual interno), conserva los candados (y cualquier etiqueta) ya escritos de las públicas, copia los de las internas de
 * su frontmatter, quita las guías que ya no existen y las de `retired` (públicas que una interna cubre mejor; `retired` se
 * conserva) y deja la firma (approvedBy, approvedAt, approvedHash) en null.
 * Con `--firmar "<nombre>"`: pone firma, fecha y el sello del conjunto (approvedHash), y únicamente si ningún archivo cambió
 * desde que se generó.
 * En los dos modos falla si dos guías distintas tienen el mismo título, avisa cuántas guías quedan sin candado e imprime cada
 * página de dinero que no es fuente por falta de su prueba (R1-09): `fuera (NO PROBADO EN APARATO): <id>` o
 * `fuera (NO PROBADO EN NAVEGADOR): <id>`. Generar, firmar y cargar leen la misma readLibrarySources.
 *
 * Uso: npx ts-node -r tsconfig-paths/register scripts/support-eval/aprobar-biblioteca.ts [--firmar "<nombre>"]
 */
import crypto from 'crypto'
import fs from 'fs'
import {
  SUPPORT_LIBRARY_MANIFEST,
  duplicateTitles,
  manifestApprovalHash,
  readLibrarySources,
  type LibrarySource,
} from '@/services/support/libraryFiles'

type Entry = Record<string, unknown> & { sha256: string; requiredPermissions: string[] }
export interface Manifest {
  version: 1
  approvedBy: string | null
  approvedAt: string | null
  /** manifestApprovalHash del conjunto firmado (R5-01); null hasta firmar. */
  approvedHash: string | null
  /** Guías que ya no se firman (una interna cubre mejor su tarea): id → motivo. */
  retired: Record<string, string>
  guides: Record<string, Entry>
}
const GATE_KEYS = ['requiredPermissions', 'featureCode', 'gateKind', 'activationKey']
/** El motivo con que readLibrarySources deja fuera una página de dinero sin su prueba → lo que se le dice a quien firma. */
export const UNTESTED_LABELS: Record<string, string> = {
  'not-device-tested': 'NO PROBADO EN APARATO',
  'not-browser-tested': 'NO PROBADO EN NAVEGADOR',
}
/** Las líneas `fuera (NO PROBADO …): <id>` de lo que readLibrarySources dejó fuera, en su orden; otro motivo no imprime nada. */
export const outsideLines = (excluded: { id: string; reason: string }[]): string[] =>
  excluded.filter(e => UNTESTED_LABELS[e.reason]).map(e => `fuera (${UNTESTED_LABELS[e.reason]}): ${e.id}`)

/** sha256 del archivo completo, una vez por id (los resúmenes se repiten por app con el mismo archivo). */
const digests = (sources: LibrarySource[]) =>
  new Map(sources.map(s => [s.id, crypto.createHash('sha256').update(s.raw).digest('hex')] as const))

/** Lo que se genera y se firma: las fuentes menos las de `retired`. */
export function signableSources(sources: LibrarySource[], manifest: Pick<Partial<Manifest>, 'retired'> | null): LibrarySource[] {
  const retired = new Set(Object.keys(manifest?.retired ?? {}))
  return sources.filter(s => !retired.has(s.id))
}

export function buildManifest(previous: unknown, sources: LibrarySource[]): Manifest {
  const prev = previous as Partial<Manifest> | null
  const old = (prev?.guides ?? {}) as Record<string, unknown>
  const retired = prev?.retired ?? {}
  const signable = signableSources(sources, { retired })
  const gatesOf = new Map(signable.map(s => [s.id, s.gates]))
  const guides: Record<string, Entry> = {}
  for (const [id, sha256] of [...digests(signable)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const kept = old[id] && typeof old[id] === 'object' ? (old[id] as object) : {}
    const gates = gatesOf.get(id)
    // Una interna: el frontmatter manda en sus candados; del manifiesto viejo sólo quedan las etiquetas.
    const labels = gates ? Object.fromEntries(Object.entries(kept).filter(([key]) => !GATE_KEYS.includes(key))) : kept
    guides[id] = Object.assign({ sha256, requiredPermissions: [] }, labels, { ...gates }, { sha256 })
  }
  return { version: 1, approvedBy: null, approvedAt: null, approvedHash: null, retired, guides }
}

export function signManifest(manifest: Manifest, sources: LibrarySource[], name: string, now = new Date()): Manifest {
  if (!name.trim()) throw new Error('Falta el nombre de quien firma: --firmar "<nombre>".')
  const current = digests(signableSources(sources, manifest))
  const unchanged =
    current.size === Object.keys(manifest.guides).length && [...current].every(([id, sha]) => manifest.guides[id]?.sha256 === sha)
  if (!unchanged)
    throw new Error('Las guías cambiaron desde que se generó el manifiesto: córrelo otra vez sin --firmar, revísalo y firma de nuevo.')
  // Un manifiesto de antes de R5-01 no trae retired: se firma con {} (lo mismo que lee la carga).
  const signed = { ...manifest, retired: manifest.retired ?? {}, approvedBy: name.trim(), approvedAt: now.toISOString() }
  return { ...signed, approvedHash: manifestApprovalHash(signed) }
}

/** Guías sin ningún candado (permisos, función de plan ni ajuste): responden igual a cualquiera. */
export const ungatedGuides = (manifest: Manifest) =>
  Object.entries(manifest.guides)
    .filter(([, e]) => !e.requiredPermissions.length && !e.featureCode && !e.gateKind && !e.activationKey)
    .map(([id]) => id)

function main() {
  const args = process.argv.slice(2)
  const at = args.indexOf('--firmar')
  const previous = fs.existsSync(SUPPORT_LIBRARY_MANIFEST) ? JSON.parse(fs.readFileSync(SUPPORT_LIBRARY_MANIFEST, 'utf8')) : null
  const excluded: { id: string; reason: string }[] = []
  const sources = readLibrarySources(undefined, undefined, undefined, (id, reason) => excluded.push({ id, reason }))
  const repeated = duplicateTitles(signableSources(sources, previous))
  if (repeated.length) throw new Error(`Títulos repetidos entre guías distintas: ${repeated.map(ids => ids.join(' = ')).join('; ')}`)
  let next: Manifest
  if (at >= 0) {
    if (!previous) throw new Error('No hay manifiesto que firmar: córrelo primero sin --firmar.')
    next = signManifest(previous, sources, args[at + 1] ?? '')
  } else next = buildManifest(previous, sources)
  fs.writeFileSync(SUPPORT_LIBRARY_MANIFEST, `${JSON.stringify(next, null, 2)}\n`)
  console.log(
    `${Object.keys(next.guides).length} guías en el manifiesto · firma: ${next.approvedBy ? `${next.approvedBy} (${next.approvedAt})` : 'null (falta firmar)'}`,
  )
  const open = ungatedGuides(next)
  console.log(`${open.length} sin candado (responden igual a cualquiera)${open.length ? `: ${open.join(', ')}` : ''}`)
  for (const line of outsideLines(excluded)) console.log(line)
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    console.error('aprobar-biblioteca:', (err as Error).message)
    process.exit(1)
  }
}
