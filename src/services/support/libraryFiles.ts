// Lectura de los archivos de la biblioteca de soporte (modo híbrido). Sin base de datos ni variables de entorno: lo usan el
// cargador de knowledge.service y el script scripts/support-eval/aprobar-biblioteca.ts, que debe poder correr suelto.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import logger from '@/config/logger'
import { normalize, parseFrontmatter } from '@/mcp/knowledge'
import type { HelpApp } from './knowledge.service'

export const products: HelpApp[] = ['dashboard', 'android', 'windows', 'tpv']
export const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SUPPORT_HELP_DIRECTORY = path.resolve(__dirname, '../../assets/mcp-support-help')
/** El manual interno: páginas sólo para el asistente de WhatsApp. Su raíz es su marca; nunca llevan enlace público ni entran al MCP. */
export const SUPPORT_MANUAL_DIRECTORY = path.resolve(__dirname, '../../assets/mcp-support-manual')

export interface ManualGates {
  requiredPermissions: string[]
  featureCode?: string
  gateKind?: 'CORE' | 'FEATURE' | 'MODULE' | 'COMMISSIONS'
  activationKey?: string
}
export interface LibrarySource {
  id: string
  app: HelpApp
  general: boolean
  raw: Buffer
  title: string
  summary: string
  steps: string[]
  keywords: string[]
  body: string
  /** Página del manual interno (vive en SUPPORT_MANUAL_DIRECTORY). */
  internal: boolean
  task?: string
  versionMin?: string
  versionMax?: string
  deviceFamily?: 'PAX' | 'NEXGO'
  money: boolean
  /** tpv, android o windows: en qué aparato se probó la página. */
  deviceTested?: string
  /** dashboard: en qué navegador se probó la página. */
  browserTested?: string
  /** Sólo internas: sus candados, del frontmatter. buildManifest los copia a su entrada del manifiesto. */
  gates?: ManualGates
}
export const SUPPORT_LIBRARY_MANIFEST = path.join(SUPPORT_HELP_DIRECTORY, 'library-approved.json')
export const SUPPORT_OVERVIEW_DIRECTORY = path.resolve(__dirname, '../../assets/mcp-knowledge/help')
const OVERVIEWS = [
  ['_overview.md', 'general/overview'],
  ['_facturacion-y-contabilidad.md', 'general/facturacion-y-contabilidad'],
] as const

/** parseFrontmatter no lee un valor que va en renglones aparte (`description:` y el texto con sangría): este sí. */
function frontmatterText(raw: string, key: string): string {
  const lines = (raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '').split(/\r?\n/)
  const at = lines.findIndex(l => l.startsWith(`${key}:`))
  if (at < 0) return ''
  const inline = lines[at]
    .slice(key.length + 1)
    .trim()
    .replace(/^["']|["']$/g, '')
  if (inline) return inline
  const folded: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (!/^\s+\S/.test(line) || /^\s+-\s/.test(line)) break
    folded.push(line.trim())
  }
  return folded.join(' ')
}

/** Los archivos `<app>/<categoría>/<archivo>.md` de una raíz, en orden, con su id. */
function guideFiles(root: string): { file: string; id: string; app: HelpApp; category: string }[] {
  const out: { file: string; id: string; app: HelpApp; category: string }[] = []
  for (const app of products) {
    const dir = path.join(root, app)
    if (!fs.existsSync(dir)) continue
    for (const category of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!category.isDirectory() || !slug.test(category.name)) continue
      for (const file of fs
        .readdirSync(path.join(dir, category.name), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const name = file.name.replace(/\.md$/, '')
        const filename = path.join(dir, category.name, file.name)
        if (!file.isFile() || !file.name.endsWith('.md') || !slug.test(name) || fs.statSync(filename).size > 64_000) continue
        out.push({ file: filename, id: `${app}/${category.name}/${name}`, app, category: category.name })
      }
    }
  }
  return out
}

/** «N.N» o «N.N.N» → [mayor, menor, parche]; null si no tiene esa forma. */
export const versionParts = (s: string): number[] | null => {
  const match = s.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/)
  const tuple = match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null
  return tuple?.every(Number.isSafeInteger) ? tuple : null
}
/** < 0 si a es más vieja que b, 0 si son iguales, > 0 si es más nueva; null si alguna no es N.N(.N). */
export function compareVersions(a: string, b: string): number | null {
  const x = versionParts(a),
    y = versionParts(b)
  return x && y ? x[0] - y[0] || x[1] - y[1] || x[2] - y[2] : null
}

/** Los pasos numerados de la sección «## Pasos» de un cuerpo; [] si no tiene. */
export const numberedSteps = (body: string): string[] =>
  ((body.split(/^## Pasos\s*$/m)[1] ?? '').split(/^## /m)[0] ?? '')
    .split('\n')
    .map(l => l.match(/^\s*\d+\.\s+(.*)$/)?.[1]?.trim())
    .filter((l): l is string => !!l)

/** La guía entera como se lee en WhatsApp: cada título de sección y las **negritas** de markdown, entre un asterisco. */
export const wholeGuide = (body: string) =>
  body
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm, '*$1*')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** «yyyy-mm-dd» de un día que existe (2026-02-30 no). */
export const isDay = (s?: string): s is string =>
  !!s &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().startsWith(s)
/**
 * Fuentes admisibles (R1-09): una interna de dinero sólo es fuente con su prueba. En la terminal y los POS, el recorrido en el
 * aparato (`deviceTested`); en el panel, el del navegador (`browserTested`; ahí un `deviceTested` no cuenta).
 */
function untestedReason(s: LibrarySource): 'not-device-tested' | 'not-browser-tested' | null {
  if (!s.internal || !s.money) return null
  if (s.app === 'dashboard') return isDay(s.browserTested) ? null : 'not-browser-tested'
  return isDay(s.deviceTested) ? null : 'not-device-tested'
}

/** Sólo las llaves con valor: lo que no trae el frontmatter no aparece. */
const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
const FAMILIES = ['PAX', 'NEXGO']
const GATE_KINDS = ['CORE', 'FEATURE', 'MODULE', 'COMMISSIONS']

/**
 * Lee los archivos de la biblioteca: guías por app/categoría, los resúmenes (una copia por app) y las páginas del manual
 * interno. «comingSoon» nunca entra. Una interna necesita su frontmatter completo (permisos, aunque sea `[]`, y de qué repo
 * y commit sale), nunca toma el id de una guía pública y, si es de dinero, entra sólo con su prueba (untestedReason).
 * Generar, firmar y cargar leen esta misma lista: lo firmado es exactamente lo que carga. `onExclude` recibe cada id que se
 * queda fuera con su motivo y, si sólo le falta la prueba, la fuente ya leída (el aviso de aprobar-biblioteca y el manual).
 */
export function readLibrarySources(
  helpDir = SUPPORT_HELP_DIRECTORY,
  overviewDir = SUPPORT_OVERVIEW_DIRECTORY,
  manualDir = SUPPORT_MANUAL_DIRECTORY,
  onExclude?: (id: string, reason: string, source?: LibrarySource) => void,
): LibrarySource[] {
  const out: LibrarySource[] = []
  const exclude = (id: string, reason: string, source?: LibrarySource) => {
    logger.warn('Support library guide excluded', { code: 'SUPPORT_LIBRARY_GUIDE_EXCLUDED', id, reason })
    onExclude?.(id, reason, source)
  }
  const add = (file: string, id: string, app: HelpApp, general: boolean, category?: string, internal = false) => {
    const raw = fs.readFileSync(file)
    const text = raw.toString('utf8')
    const { meta, body } = parseFrontmatter(text)
    if (meta.comingSoon === 'true') return
    if (!general && (meta.product !== app || meta.category !== category)) return internal ? exclude(id, 'metadata') : undefined
    const str = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : undefined)
    const title = frontmatterText(text, 'title'),
      summary = frontmatterText(text, 'description'),
      family = str('deviceFamily'),
      gateKind = str('gateKind'),
      min = str('versionMin'),
      max = str('versionMax'),
      listed = meta.requiredPermissions,
      // Una lista con renglones, o `[]` escrito así: un `requiredPermissions:` vacío no cuenta.
      permissions = Array.isArray(listed) && listed.length ? listed : listed === '[]' ? [] : undefined
    if (!title || !summary || (family && !FAMILIES.includes(family))) return exclude(id, 'metadata')
    // El híbrido compara versiones N.N(.N): un sufijo, otra forma o un mínimo arriba del máximo no se pueden ubicar.
    if ((min && !versionParts(min)) || (max && !versionParts(max)) || (min && max && compareVersions(min, max)! > 0))
      return exclude(id, 'metadata')
    if (
      internal &&
      (!permissions ||
        (gateKind && !GATE_KINDS.includes(gateKind)) ||
        (str('featureCode') && !gateKind) ||
        !/^avoqado-(?:tpv|android|web-dashboard)$/.test(str('sourceRepo') ?? '') ||
        !/^[a-f0-9]{40}$/.test(str('sourceRef') ?? ''))
    )
      return exclude(id, 'metadata')
    const numbered = numberedSteps(body)
    const source: LibrarySource = {
      id,
      app,
      general,
      raw,
      title,
      summary,
      steps: numbered.length ? numbered : [summary],
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      body,
      internal,
      money: str('money') === 'true',
      ...defined({
        task: str('task'),
        versionMin: min,
        versionMax: max,
        deviceFamily: family as LibrarySource['deviceFamily'],
        deviceTested: str('deviceTested'),
        browserTested: str('browserTested'),
      }),
      ...(internal
        ? {
            gates: {
              requiredPermissions: permissions!,
              ...defined({
                featureCode: str('featureCode'),
                gateKind: gateKind as ManualGates['gateKind'],
                activationKey: str('activationKey'),
              }),
            },
          }
        : {}),
    }
    const untested = untestedReason(source)
    if (untested) return exclude(id, untested, source)
    out.push(source)
  }
  const publicFiles = guideFiles(helpDir)
  for (const f of publicFiles) add(f.file, f.id, f.app, false, f.category)
  for (const [file, id] of OVERVIEWS)
    if (fs.existsSync(path.join(overviewDir, file))) for (const app of products) add(path.join(overviewDir, file), id, app, true)
  // Una interna nunca reutiliza el id de un archivo público (aunque esté «comingSoon»): una cita `id@hash` diría otra cosa.
  const publicIds = new Set(publicFiles.map(f => f.id))
  for (const f of guideFiles(manualDir))
    if (publicIds.has(f.id)) exclude(f.id, 'id-collision')
    else add(f.file, f.id, f.app, false, f.category, true)
  return out
}

/** JSON con las llaves ordenadas: dos objetos con lo mismo dan el mismo texto aunque cambie el orden. */
export const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value

/** Lo que sella la firma del manifiesto (R5-01): las entradas, las retiradas, quién y cuándo. sha256 del JSON canónico. */
export const manifestApprovalHash = (m: {
  approvedBy: string | null
  approvedAt: string | null
  retired: Record<string, string>
  guides: Record<string, unknown>
}): string =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical({ approvedAt: m.approvedAt, approvedBy: m.approvedBy, guides: m.guides, retired: m.retired })))
    .digest('hex')

// ── Firma por guía (D22) ──────────────────────────────────────────────────────────────────────
// La propuesta (library-approved.json) la escribe el generador; las firmas viven aparte, en library-signatures.json junto a
// ella, y sólo las escribe `--firmar`. Así regenerar la propuesta nunca borra una firma, y una rama que la regenera con el
// formato viejo (firma en null) no choca ni deja al bot sin guías.

/** Una guía tal como se firmó: su entrada de la propuesta (sha256 + candados), quién, cuándo y el sello de las cuatro cosas. */
export interface GuideApproval {
  entry: Record<string, unknown>
  approvedBy: string
  approvedAt: string
  approvedHash: string
}
/** La salida firmada de una guía (retirada o quitada): sólo la consulta el generador, para no revivirla al importar. */
export interface GuideExit {
  approvedBy: string
  approvedAt: string
  approvedHash: string
}
export interface LibrarySignatures {
  version: 1
  guides: Record<string, GuideApproval>
  exits?: Record<string, GuideExit>
}
export const SUPPORT_LIBRARY_SIGNATURES = path.join(SUPPORT_HELP_DIRECTORY, 'library-signatures.json')
/** Las firmas van junto a su propuesta. */
export const signaturesPathFor = (manifest: string) => path.join(path.dirname(manifest), 'library-signatures.json')
/** El sello de una firma: sha256 del JSON canónico de id + entrada + quién + cuándo. Retocar cualquiera lo rompe. */
export const approvalHash = (id: string, a: Pick<GuideApproval, 'entry' | 'approvedBy' | 'approvedAt'>): string =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical({ approvedAt: a.approvedAt, approvedBy: a.approvedBy, entry: a.entry, id })))
    .digest('hex')
/** El sello de una salida firmada. */
export const exitHash = (id: string, a: Pick<GuideExit, 'approvedBy' | 'approvedAt'>): string =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical({ approvedAt: a.approvedAt, approvedBy: a.approvedBy, exit: true, id })))
    .digest('hex')
export const sameEntry = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
/** Una firma vale si trae sus cuatro partes y su sello coincide (nadie la retocó a mano ni la movió de guía). */
export function validApproval(id: string, a: unknown): a is GuideApproval {
  const x = a as Partial<GuideApproval> | null
  return (
    !!x &&
    typeof x === 'object' &&
    !!x.entry &&
    typeof x.entry === 'object' &&
    !Array.isArray(x.entry) &&
    typeof x.approvedBy === 'string' &&
    !!x.approvedBy.trim() &&
    typeof x.approvedAt === 'string' &&
    !!x.approvedAt &&
    x.approvedHash === approvalHash(id, x as GuideApproval)
  )
}

/** Formato de antes: la firma del manifiesto sigue valiendo (firmado y su approvedHash coincide con el conjunto). */
export const legacySignatureValid = (m: {
  approvedBy?: string | null
  approvedAt?: string | null
  approvedHash?: string | null
  retired?: Record<string, string>
  guides?: Record<string, unknown>
}): boolean =>
  !!m.approvedBy &&
  !!m.approvedAt &&
  !!m.guides &&
  m.approvedHash ===
    manifestApprovalHash({ approvedBy: m.approvedBy, approvedAt: m.approvedAt, retired: m.retired ?? {}, guides: m.guides })

const signaturesSchema = z.object({
  version: z.literal(1),
  guides: z.record(z.string(), z.unknown()),
  exits: z.record(z.string(), z.unknown()).optional(),
})
/** Lee library-signatures.json igual para el cargador y el generador; truena si no tiene la forma esperada. */
export const parseSignatures = (text: string): LibrarySignatures => signaturesSchema.parse(JSON.parse(text)) as LibrarySignatures

/** Títulos que se repiten entre guías distintas (sin acentos, mayúsculas ni signos): la aclaración muestra cada opción por su título. */
export function duplicateTitles(guides: { id: string; title: string }[]): string[][] {
  const byTitle = new Map<string, Set<string>>()
  for (const g of guides) {
    const key = normalize(g.title)
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
    byTitle.set(key, (byTitle.get(key) ?? new Set<string>()).add(g.id))
  }
  return [...byTitle.values()].filter(ids => ids.size > 1).map(ids => [...ids])
}
