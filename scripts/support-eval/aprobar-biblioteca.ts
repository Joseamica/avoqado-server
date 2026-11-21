/**
 * Biblioteca aprobada del soporte por WhatsApp (modo híbrido): la propuesta y la firma por guía (D22).
 *
 * Sin argumentos: escribe la PROPUESTA, `src/assets/mcp-support-help/library-approved.json`, con el sha256 ACTUAL de cada guía
 * (públicas y del manual interno), conserva los candados (y cualquier etiqueta) ya escritos de las públicas, copia los de las
 * internas de su frontmatter, quita las guías que ya no existen y las de `retired` (públicas que una interna cubre mejor;
 * `retired` se conserva). Su approvedBy/approvedAt/approvedHash quedan siempre en null: son del formato de antes y las ramas
 * viejas los escriben así. Nunca borra una firma por regenerar. Si la propuesta anterior trae una firma vieja que sigue
 * valiendo (p. ej. de una rama que firmó con el generador de antes), la pasa a `library-signatures.json` tal cual la firmó el
 * founder: cada guía de ese conjunto con su nombre y fecha, y fuera las que ese conjunto ya no traía. Escribe primero las
 * firmas y después la propuesta, y no escribe si otra corrida cambió las firmas mientras tanto.
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
  legacySignatureValid,
  parseSignatures,
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

const sortedGuides = (guides: Record<string, GuideApproval>) =>
  Object.fromEntries(Object.entries(guides).sort(([a], [b]) => (a < b ? -1 : 1)))

/**
 * Una firma vieja (todo el conjunto) que sigue valiendo, pasada a firmas por guía tal como la dio el founder: cada guía del
 * conjunto queda firmada (con la firma que ya tenía si es la misma entrada, o con el nombre y fecha de la vieja) y las que el
 * conjunto ya no traía quedan sin firma (su salida ya la firmó). null si no hay firma vieja o no vale.
 */
export function importLegacySignature(previous: unknown, stored: LibrarySignatures | null = null): LibrarySignatures | null {
  const prev = previous as Partial<Manifest> | null
  if (!prev || !legacySignatureValid(prev)) return null
  const guides: Record<string, GuideApproval> = {}
  for (const [id, entry] of Object.entries(prev.guides!)) {
    const kept = stored?.guides[id]
    if (validApproval(id, kept) && sameEntry(kept.entry, entry)) guides[id] = kept
    else {
      const approval = { entry: entry as Record<string, unknown>, approvedBy: prev.approvedBy!, approvedAt: prev.approvedAt! }
      guides[id] = { ...approval, approvedHash: approvalHash(id, approval) }
    }
  }
  return { version: 1, guides: sortedGuides(guides) }
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
  // Lo que el bot serviría con estas firmas: el cargador falla cerrado (biblioteca vacía) con dos títulos iguales. Pasa al
  // firmar sólo el reemplazo de una guía que se retira con el mismo título: se firman juntos o no se firma.
  const fileSha = digests(sources)
  const served = sources.filter(
    s =>
      validApproval(s.id, guides[s.id]) &&
      (!(s.id in manifest.guides) || sameEntry(manifest.guides[s.id], guides[s.id].entry)) &&
      guides[s.id].entry.sha256 === fileSha.get(s.id),
  )
  const repeated = duplicateTitles(served)
  if (repeated.length)
    throw new Error(
      `Firmar así deja guías con el mismo título y el bot se quedaría sin ninguna: ${repeated.map(ids => ids.join(' = ')).join('; ')}. Firma también la salida de la que se va.`,
    )
  return { signatures: { version: 1, guides: sortedGuides(guides) }, signed, left }
}

/**
 * Escribe las firmas ANTES que la propuesta: si algo corta a la mitad, la firma vieja sigue en la propuesta y nada se pierde.
 * `signaturesRead` es el texto de las firmas al empezar (null si no había): si otra corrida las cambió mientras tanto, no
 * escribe nada (dos firmas a la vez se pisarían).
 */
export function writeLibrary(
  out: { signatures?: LibrarySignatures; proposal?: Manifest },
  signaturesRead: string | null,
  files = { signatures: SUPPORT_LIBRARY_SIGNATURES, proposal: SUPPORT_LIBRARY_MANIFEST },
) {
  const now = fs.existsSync(files.signatures) ? fs.readFileSync(files.signatures, 'utf8') : null
  // ponytail: comparar y escribir no es atómico; la ventana es de milisegundos y quien firma es una persona.
  if (now !== signaturesRead) throw new Error('Otra corrida cambió library-signatures.json mientras tanto: vuelve a correr el comando.')
  const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`
  if (out.signatures) fs.writeFileSync(files.signatures, json(out.signatures))
  if (out.proposal) fs.writeFileSync(files.proposal, json(out.proposal))
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
  const signaturesRead = fs.existsSync(SUPPORT_LIBRARY_SIGNATURES) ? fs.readFileSync(SUPPORT_LIBRARY_SIGNATURES, 'utf8') : null
  // Mismo lector que el cargador: si él no lo puede leer, aquí tampoco se sigue como si nada.
  const stored = signaturesRead === null ? null : parseSignatures(signaturesRead)
  const converted = importLegacySignature(previous, stored)
  let signatures: LibrarySignatures = converted ?? stored ?? { version: 1, guides: {} }
  if (converted && !sameEntry(converted, stored))
    console.log(`firma vieja pasada a firmas por guía: ${Object.keys(converted.guides).length} guías firmadas por ${previous.approvedBy}`)
  let next: Manifest
  if (at >= 0) {
    if (!previous) throw new Error('No hay manifiesto que firmar: córrelo primero sin --firmar.')
    next = previous
    const result = signGuides(previous, signatures, sources, args[at + 1] ?? '', args.slice(at + 2))
    signatures = result.signatures
    writeLibrary({ signatures }, signaturesRead)
    for (const id of result.signed) console.log(`firmada: ${id}`)
    for (const id of result.left) console.log(`salida firmada: ${id}`)
  } else {
    next = buildManifest(previous, sources)
    writeLibrary({ signatures, proposal: next }, signaturesRead)
  }
  const pending = pendingChanges(next, signatures)
  const valid = Object.entries(signatures.guides).filter(([id, a]) => validApproval(id, a)).length
  console.log(
    `${Object.keys(next.guides).length} guías en la lista · ${valid} firmadas · ` +
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
