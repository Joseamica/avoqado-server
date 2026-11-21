/**
 * Biblioteca aprobada del soporte por WhatsApp (modo híbrido): la propuesta y la firma por guía (D22).
 *
 * Sin argumentos: escribe la PROPUESTA, `src/assets/mcp-support-help/library-approved.json`, con el sha256 ACTUAL de cada guía
 * (públicas y del manual interno), conserva los candados (y cualquier etiqueta) ya escritos de las públicas, copia los de las
 * internas de su frontmatter, quita las guías que ya no existen y las de `retired` (públicas que una interna cubre mejor;
 * `retired` se conserva). Su approvedBy/approvedAt/approvedHash quedan siempre en null: son del formato de antes y las ramas
 * viejas los escriben así. Nunca toca las firmas, salvo una vez: si todavía no hay `library-signatures.json` y la propuesta
 * anterior trae una firma vieja válida, la convierte (cada guía queda firmada con el mismo nombre y fecha).
 * Imprime lo pendiente de firma: `pendiente de firma (nueva o cambiada): <id>` y `pendiente de firma (sale de la lista): <id>`.
 * Con `--firmar "<nombre>" [ids…]`: firma en `library-signatures.json` lo pendiente (o sólo esos ids), únicamente si ningún
 * archivo cambió desde que se generó la propuesta, e imprime `firmada: <id>` y `salida firmada: <id>`.
 * En los dos modos falla si dos guías distintas tienen el mismo título, avisa cuántas guías quedan sin candado e imprime cada
 * página de dinero que no es fuente por falta de su prueba (R1-09): `fuera (NO PROBADO EN APARATO): <id>` o
 * `fuera (NO PROBADO EN NAVEGADOR): <id>`. Generar, firmar y cargar leen la misma readLibrarySources: una página fuera no se
 * puede firmar.
 *
 * Uso: TS_NODE_TRANSPILE_ONLY=1 npx ts-node -r tsconfig-paths/register scripts/support-eval/aprobar-biblioteca.ts [--firmar "<nombre>" [ids…]]
 */
import crypto from 'crypto'
import fs from 'fs'
import {
  SUPPORT_LIBRARY_MANIFEST,
  SUPPORT_LIBRARY_SIGNATURES,
  approvalHash,
  duplicateTitles,
  manifestApprovalHash,
  readLibrarySources,
  sameEntry,
  validApproval,
  type GuideApproval,
  type LibrarySignatures,
  type LibrarySource,
} from '@/services/support/libraryFiles'

type Entry = Record<string, unknown> & { sha256: string; requiredPermissions: string[] }
export interface Manifest {
  version: 1
  /** Formato de antes de D22: el generador los deja en null; la firma vive en library-signatures.json. */
  approvedBy: string | null
  approvedAt: string | null
  /** Formato de antes: manifestApprovalHash del conjunto firmado (R5-01). */
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

/**
 * Una firma vieja (todo el conjunto) que sigue valiendo, convertida a firmas por guía con el mismo nombre y fecha; null si
 * no hay firma o no vale (sin approvedHash, o el conjunto cambió desde que se firmó).
 */
export function importLegacySignature(previous: unknown): LibrarySignatures | null {
  const prev = previous as Partial<Manifest> | null
  if (!prev?.approvedBy || !prev.approvedAt || !prev.guides || typeof prev.guides !== 'object') return null
  const sealed = { approvedBy: prev.approvedBy, approvedAt: prev.approvedAt, retired: prev.retired ?? {}, guides: prev.guides }
  if (prev.approvedHash !== manifestApprovalHash(sealed)) return null
  const guides: Record<string, GuideApproval> = {}
  for (const [id, entry] of Object.entries(prev.guides)) {
    const approval = { entry: entry as Record<string, unknown>, approvedBy: prev.approvedBy, approvedAt: prev.approvedAt }
    guides[id] = { ...approval, approvedHash: approvalHash(id, approval) }
  }
  return { version: 1, guides }
}

/** Lo que espera la firma: las guías de la propuesta sin firma válida o distintas de lo firmado, y las firmadas que ya no están. */
export function pendingChanges(
  manifest: Pick<Manifest, 'guides'>,
  signatures: LibrarySignatures,
): { changed: string[]; leaving: string[] } {
  const changed = Object.keys(manifest.guides).filter(id => {
    const approval = signatures.guides[id]
    return !validApproval(id, approval) || !sameEntry(manifest.guides[id], approval.entry)
  })
  const leaving = Object.keys(signatures.guides).filter(id => !(id in manifest.guides))
  return { changed: changed.sort(), leaving: leaving.sort() }
}

/**
 * `--firmar`: firma lo pendiente (o sólo `ids`, que tienen que estar pendientes) y conserva intacta cada firma que ya
 * estaba al día. Sólo si la propuesta coincide con los archivos de hoy: se firma lo que se revisó.
 */
export function signGuides(
  manifest: Manifest,
  signatures: LibrarySignatures,
  sources: LibrarySource[],
  name: string,
  ids?: string[],
  now = new Date(),
): { signatures: LibrarySignatures; signed: string[]; left: string[] } {
  const by = name.trim()
  if (!by) throw new Error('Falta el nombre de quien firma: --firmar "<nombre>".')
  const current = digests(signableSources(sources, manifest))
  const unchanged =
    current.size === Object.keys(manifest.guides).length && [...current].every(([id, sha]) => manifest.guides[id]?.sha256 === sha)
  if (!unchanged)
    throw new Error('Las guías cambiaron desde que se generó el manifiesto: córrelo otra vez sin --firmar, revísalo y firma de nuevo.')
  const pending = pendingChanges(manifest, signatures)
  const wanted = ids?.length ? new Set(ids) : null
  const notPending = [...(wanted ?? [])].filter(id => !pending.changed.includes(id) && !pending.leaving.includes(id))
  if (notPending.length) throw new Error(`No está pendiente de firma: ${notPending.join(', ')}`)
  const pick = (id: string) => !wanted || wanted.has(id)
  const signed = pending.changed.filter(pick)
  const left = pending.leaving.filter(pick)
  const guides = { ...signatures.guides }
  for (const id of left) delete guides[id]
  for (const id of signed) {
    const approval = { entry: manifest.guides[id] as Record<string, unknown>, approvedBy: by, approvedAt: now.toISOString() }
    guides[id] = { ...approval, approvedHash: approvalHash(id, approval) }
  }
  const sorted = Object.fromEntries(Object.entries(guides).sort(([a], [b]) => (a < b ? -1 : 1)))
  return { signatures: { version: 1, guides: sorted }, signed, left }
}

/** Guías sin ningún candado (permisos, función de plan ni ajuste): responden igual a cualquiera. */
export const ungatedGuides = (manifest: Manifest) =>
  Object.entries(manifest.guides)
    .filter(([, e]) => !e.requiredPermissions.length && !e.featureCode && !e.gateKind && !e.activationKey)
    .map(([id]) => id)

const write = (file: string, data: unknown) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)

function main() {
  const args = process.argv.slice(2)
  const at = args.indexOf('--firmar')
  const previous = fs.existsSync(SUPPORT_LIBRARY_MANIFEST) ? JSON.parse(fs.readFileSync(SUPPORT_LIBRARY_MANIFEST, 'utf8')) : null
  const excluded: { id: string; reason: string }[] = []
  const sources = readLibrarySources(undefined, undefined, undefined, (id, reason) => excluded.push({ id, reason }))
  const repeated = duplicateTitles(signableSources(sources, previous))
  if (repeated.length) throw new Error(`Títulos repetidos entre guías distintas: ${repeated.map(ids => ids.join(' = ')).join('; ')}`)
  const stored: LibrarySignatures | null = fs.existsSync(SUPPORT_LIBRARY_SIGNATURES)
    ? JSON.parse(fs.readFileSync(SUPPORT_LIBRARY_SIGNATURES, 'utf8'))
    : null
  const converted = stored ? null : importLegacySignature(previous)
  let signatures: LibrarySignatures = stored ?? converted ?? { version: 1, guides: {} }
  if (converted) console.log(`firma vieja convertida: ${Object.keys(converted.guides).length} guías firmadas por ${previous.approvedBy}`)
  let next: Manifest
  if (at >= 0) {
    if (!previous) throw new Error('No hay manifiesto que firmar: córrelo primero sin --firmar.')
    next = previous
    const result = signGuides(previous, signatures, sources, args[at + 1] ?? '', args.slice(at + 2))
    signatures = result.signatures
    write(SUPPORT_LIBRARY_SIGNATURES, signatures)
    for (const id of result.signed) console.log(`firmada: ${id}`)
    for (const id of result.left) console.log(`salida firmada: ${id}`)
  } else {
    next = buildManifest(previous, sources)
    write(SUPPORT_LIBRARY_MANIFEST, next)
    if (converted) write(SUPPORT_LIBRARY_SIGNATURES, converted)
  }
  const pending = pendingChanges(next, signatures)
  console.log(
    `${Object.keys(next.guides).length} guías en la lista · ${Object.keys(signatures.guides).length} firmadas · ` +
      `${pending.changed.length + pending.leaving.length} pendientes de firma`,
  )
  for (const id of pending.changed) console.log(`pendiente de firma (nueva o cambiada): ${id}`)
  for (const id of pending.leaving) console.log(`pendiente de firma (sale de la lista): ${id}`)
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
