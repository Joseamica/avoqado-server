import type { HelpAccess, HelpContext, HelpGate } from './access.service'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import logger from '@/config/logger'
import { parseFrontmatter, findArticle, type KnowledgeArticle } from '@/mcp/knowledge'
import { resolveHelpAccess } from './access.service'
import {
  SUPPORT_HELP_DIRECTORY,
  SUPPORT_LIBRARY_MANIFEST,
  canonical,
  compareVersions,
  duplicateTitles,
  manifestApprovalHash,
  products,
  readLibrarySources,
  slug,
  versionParts,
  wholeGuide,
} from './libraryFiles'
export { SUPPORT_HELP_DIRECTORY, compareVersions, manifestApprovalHash }
export type HelpApp = 'dashboard' | 'android' | 'windows' | 'tpv'
export interface HelpQuery {
  topic: string
  app: HelpApp
  appVersion?: string
  deviceFamily?: 'PAX' | 'NEXGO'
  sectionId?: string
}
export interface VerifiedSection extends HelpGate {
  id: string
  app: HelpApp
  title: string
  summary: string
  steps: string[]
  publicUrl: string
  requiredPermissions: string[]
  versionMin?: string
  versionMax?: string
  deviceFamily?: 'PAX' | 'NEXGO'
  keywords: string[]
  /**
   * T-F6 (Codex H3): la guía entera como se lee en WhatsApp (wholeGuide). Una respuesta da los pasos de una guía sólo con todo
   * lo demás que trae (condiciones y advertencias): entera, o su tarjeta. Sin ella, sólo la tarjeta.
   */
  whole?: string
}
export interface HelpResult {
  kind: 'ANSWER' | 'NO_COVERAGE' | 'ASK_VERSION' | 'ASK_DEVICE'
  sections: VerifiedSection[]
  access: HelpAccess | null
}
/**
 * La versión cae en [min, max]. Sin rango, cualquiera; un rango exacto (min = max, aunque traiga sufijo) sólo esa; si no,
 * todas tienen que ser N.N(.N).
 */
export function matchesVersionRange(version: string, min?: string, max?: string): boolean {
  if (!min && !max) return true
  if (min === version && max === version) return true
  const fromMin = min ? compareVersions(version, min) : 0,
    toMax = max ? compareVersions(version, max) : 0
  return fromMin !== null && toMax !== null && fromMin >= 0 && toMax <= 0
}
// Dos o más partes: `payments:create`, y también `billing:subscriptions:read` (49 permisos tienen tres).
const permissionPattern = /^[a-zA-Z][\w-]*(?::[\w*-]+)+$/
const commercialKinds = ['FEATURE', 'MODULE', 'COMMISSIONS']
/** Validación de candados compartida por las guías verificadas (frontmatter) y la biblioteca (manifiesto). null = inválidos. */
function parseGates(gateKind?: string, rawFeatureCode?: string, activationKey?: string): HelpGate | null {
  // Existing help featureCode can be a white-label category, not a commercial entitlement.
  const featureCode = gateKind === 'CORE' ? undefined : rawFeatureCode
  if (featureCode && !commercialKinds.includes(gateKind ?? '')) return null
  if (gateKind && gateKind !== 'CORE' && (!featureCode || !commercialKinds.includes(gateKind))) return null
  return {
    ...(featureCode ? { featureCode, gateKind: gateKind as HelpGate['gateKind'] } : {}),
    ...(activationKey ? { activationKey } : {}),
  }
}

export function loadVerifiedSections(directory = SUPPORT_HELP_DIRECTORY): VerifiedSection[] {
  const sections: VerifiedSection[] = []
  for (const app of products) {
    const root = path.join(directory, app)
    if (!fs.existsSync(root)) continue
    for (const category of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!category.isDirectory() || !slug.test(category.name)) continue
      for (const file of fs
        .readdirSync(path.join(root, category.name), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const name = file.name.replace(/\.md$/, '')
        if (!file.isFile() || !file.name.endsWith('.md') || !slug.test(name)) continue
        const filename = path.join(root, category.name, file.name)
        if (fs.statSync(filename).size > 64_000) continue
        const raw = fs.readFileSync(filename, 'utf8')
        const { meta, body } = parseFrontmatter(raw)
        const frontmatter = raw.slice(0, raw.indexOf('\n---', 4))
        const str = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : undefined)
        const list = (key: string): string[] | undefined =>
          Array.isArray(meta[key]) && meta[key].length > 0
            ? (meta[key] as string[])
            : (Array.isArray(meta[key]) || meta[key] === '[]') && new RegExp(`^${key}:[ \t]*\\[\\][ \t]*$`, 'm').test(frontmatter)
              ? []
              : undefined
        if (
          str('supportVerified') !== 'true' ||
          str('comingSoon') === 'true' ||
          str('product') !== app ||
          str('category') !== category.name
        )
          continue
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(str('verifiedAt') ?? '') ||
          !Number.isFinite(Date.parse(`${str('verifiedAt')}T00:00:00Z`)) ||
          new Date(`${str('verifiedAt')}T00:00:00Z`).toISOString().slice(0, 10) !== str('verifiedAt')
        )
          continue
        if (!/^avoqado-(?:web-dashboard|android|tpv|landing)@[a-f0-9]{40}$/.test(str('publishedSourceRef') ?? '')) continue
        const permissions = list('requiredPermissions'),
          steps = list('supportSteps'),
          summary = str('supportSummary'),
          title = str('title')
        if (
          !permissions ||
          permissions.some(p => !permissionPattern.test(p)) ||
          !steps?.length ||
          !title ||
          !summary ||
          summary.length > 450 ||
          steps.some(s => !s.trim())
        )
          continue
        const gates = parseGates(str('gateKind'), str('featureCode'), str('activationKey'))
        if (!gates) continue
        const min = str('versionMin'),
          max = str('versionMax'),
          family = str('deviceFamily')
        const exactSuffix = min === max && /^\d+\.\d+(?:\.\d+)?-[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(min ?? '')
        if (
          (min && !versionParts(min) && !exactSuffix) ||
          (max && !versionParts(max) && !exactSuffix) ||
          (family && !['PAX', 'NEXGO'].includes(family))
        )
          continue
        if (min && max && (compareVersions(min, max) ?? 0) > 0) continue
        const id = `${app}/${category.name}/${name}`
        sections.push({
          id,
          app,
          title,
          summary,
          steps,
          publicUrl: `https://avoqado.io/help/${id}`,
          requiredPermissions: permissions,
          keywords: list('keywords') ?? [],
          whole: wholeGuide(body),
          ...(min ? { versionMin: min } : {}),
          ...(max ? { versionMax: max } : {}),
          ...(family ? { deviceFamily: family as 'PAX' | 'NEXGO' } : {}),
          ...gates,
        })
      }
    }
  }
  return sections.sort((a, b) => a.id.localeCompare(b.id))
}

// ── Biblioteca única del modo híbrido ──────────────────────────────────────────────────────────
// Las guías de mcp-support-help (sin «comingSoon»), dos resúmenes del MCP (una copia por app) y las páginas del manual
// interno (mcp-support-manual). Sólo responden las guías cuyo archivo coincide con el manifiesto aprobado
// (library-approved.json); ahí viven también sus candados.

export interface LibraryGuide extends VerifiedSection {
  body: string
  general: boolean
  /** sha256(archivo + JSON canónico de los candados de su entrada del manifiesto) */
  hash: string
  /** Página del manual interno: nunca lleva enlace (`publicUrl: ''`); la respuesta la cita por su título. */
  internal: boolean
  task?: string
}
const HELP_HOME = 'https://avoqado.io/help'
/** Cambia si cambia el archivo o cualquiera de sus candados: lo aprobado es el conjunto. */
export const libraryGuideHash = (file: Buffer | string, gates: object): string =>
  crypto
    .createHash('sha256')
    .update(file)
    .update(JSON.stringify(canonical(gates)))
    .digest('hex')

const manifestSchema = z.object({
  version: z.literal(1),
  approvedBy: z.string().min(1).nullable(),
  approvedAt: z.string().min(1).nullable(),
  // Un manifiesto de antes de R5-01 no los trae: sin approvedHash no carga firmado.
  approvedHash: z.string().nullable().default(null),
  retired: z.record(z.string(), z.string()).default({}),
  guides: z.record(z.string(), z.unknown()),
})
export type Manifest = z.infer<typeof manifestSchema>
const entrySchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  requiredPermissions: z.array(z.string().regex(permissionPattern)),
  featureCode: z.string().min(1).optional(),
  gateKind: z.enum(['CORE', 'FEATURE', 'MODULE', 'COMMISSIONS']).optional(),
  activationKey: z.string().min(1).optional(),
})

/**
 * Sólo carga lo aprobado: la firma del manifiesto, que sella todo el conjunto (salvo `allowDraft`, que es del examen), el
 * sha256 del archivo y los candados válidos. Una guía retirada no está en `guides`: no carga. Lo que no cumple sale con un
 * registro de su id, nunca de su texto. Dos títulos iguales entre guías distintas rompen la carga: la aclaración se las
 * muestra a la persona por su título.
 */
export function loadSupportLibrary(
  options: { helpDir?: string; overviewDir?: string; manifest?: string; allowDraft?: boolean; manualDir?: string } = {},
): LibraryGuide[] {
  let manifest: Manifest
  try {
    manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(options.manifest ?? SUPPORT_LIBRARY_MANIFEST, 'utf8')))
  } catch {
    logger.error('Support library manifest unreadable', { code: 'SUPPORT_LIBRARY_MANIFEST_INVALID' })
    return []
  }
  if (!options.allowDraft) {
    if (!(manifest.approvedBy && manifest.approvedAt)) return []
    // Quitar una entrada o retirar una guía después de firmar cambia lo firmado: no carga nada.
    if (manifest.approvedHash !== manifestApprovalHash(manifest)) {
      logger.error('Support library manifest tampered', { code: 'SUPPORT_LIBRARY_MANIFEST_TAMPERED' })
      return []
    }
  }
  const entries = new Map(Object.entries(manifest.guides))
  const guides: LibraryGuide[] = []
  const excluded = new Set<string>()
  const exclude = (id: string, reason: string) => {
    if (excluded.has(id)) return
    excluded.add(id)
    logger.warn('Support library guide excluded', { code: 'SUPPORT_LIBRARY_GUIDE_EXCLUDED', id, reason })
  }
  for (const source of readLibrarySources(options.helpDir, options.overviewDir, options.manualDir)) {
    const listed = entrySchema.safeParse(entries.get(source.id))
    if (!listed.success) {
      exclude(source.id, entries.has(source.id) ? 'gates' : 'unlisted')
      continue
    }
    const { sha256, ...entry } = listed.data
    if (sha256 !== crypto.createHash('sha256').update(source.raw).digest('hex')) {
      exclude(source.id, 'changed')
      continue
    }
    const gates = parseGates(entry.gateKind, entry.featureCode, entry.activationKey)
    if (!gates) {
      exclude(source.id, 'gates')
      continue
    }
    guides.push({
      id: source.id,
      app: source.app,
      title: source.title,
      summary: source.summary,
      steps: source.steps,
      publicUrl: source.internal ? '' : source.general ? HELP_HOME : `${HELP_HOME}/${source.id}`,
      requiredPermissions: entry.requiredPermissions,
      keywords: source.keywords,
      ...(source.versionMin ? { versionMin: source.versionMin } : {}),
      ...(source.versionMax ? { versionMax: source.versionMax } : {}),
      ...(source.deviceFamily ? { deviceFamily: source.deviceFamily } : {}),
      ...gates,
      body: source.body,
      general: source.general,
      internal: source.internal,
      ...(source.task ? { task: source.task } : {}),
      hash: libraryGuideHash(source.raw, entry),
    })
  }
  const repeated = duplicateTitles(guides)
  // Fails closed: a clarification could not tell two guides with the same title apart. The generator refuses them first.
  if (repeated.length) {
    logger.error('Support library has repeated titles', { code: 'SUPPORT_LIBRARY_DUPLICATE_TITLE', ids: repeated })
    return []
  }
  return guides.sort((a, b) => a.id.localeCompare(b.id) || a.app.localeCompare(b.app))
}

/** Cita estable de una guía en `sourceIds`: `<id>@<8 primeros del hash>`. El marcador `#clarify` no es una cita. */
export const sourceRef = (g: Pick<LibraryGuide, 'id' | 'hash'>) => `${g.id}@${g.hash.slice(0, 8)}`
export function parseSourceRef(ref: string): { id: string; hash8?: string } | null {
  const match = ref.match(/^([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)(?:@([a-f0-9]{8}))?$/)
  return match ? { id: match[1], ...(match[2] ? { hash8: match[2] } : {}) } : null
}
/**
 * Las citas `id@hash8` de un mensaje (una aclaración lleva `#clarify` delante) contra la biblioteca vigente, con o sin la
 * flag. null = no son citas híbridas (un mensaje de antes de la flag): sigue el camino de hoy. Cada id se busca en
 * cualquier app: los resúmenes generales se repiten, idénticos, una vez por app. `same` = todas siguen con su hash.
 */
export function resolveSourceRefs(
  sourceIds: string[],
  load: () => LibraryGuide[],
): { clarify: boolean; guides: LibraryGuide[]; same: boolean } | null {
  const clarify = sourceIds[0] === '#clarify'
  const refs = (clarify ? sourceIds.slice(1) : sourceIds).map(parseSourceRef)
  if (!clarify && !(refs.length && refs.every(r => r?.hash8))) return null
  const library = load()
  const found = refs.map(r => (r?.hash8 ? library.find(g => g.id === r.id) : undefined))
  return {
    clarify,
    guides: found.filter((g): g is LibraryGuide => !!g),
    same: refs.length > 0 && found.every((g, i) => !!g && g.hash.slice(0, 8) === refs[i]!.hash8),
  }
}

export async function searchVerifiedHelp(
  query: HelpQuery,
  context: HelpContext | null,
  sections = loadVerifiedSections(),
): Promise<HelpResult> {
  const none: HelpResult = { kind: 'NO_COVERAGE', sections: [], access: null }
  const versionProvided =
    !!query.appVersion && (!!versionParts(query.appVersion) || /^\d+\.\d+(?:\.\d+)?-[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(query.appVersion))
  let pool = sections.filter(
    s =>
      s.app === query.app &&
      (!query.sectionId || s.id === query.sectionId) &&
      (!query.deviceFamily || !s.deviceFamily || s.deviceFamily === query.deviceFamily) &&
      (!versionProvided || matchesVersionRange(query.appVersion!, s.versionMin, s.versionMax)),
  )
  const candidates: VerifiedSection[] = []
  while (pool.length && candidates.length < 3) {
    const articles: KnowledgeArticle[] = pool.map(s => ({
      slug: s.id,
      title: s.title,
      description: s.summary,
      body: s.steps.join(' '),
      category: s.id.split('/')[1],
      keywords: s.keywords,
      roles: [],
      related: [],
    }))
    const best = query.sectionId ? articles[0] : findArticle(articles, query.topic).article
    if (!best) break
    candidates.push(pool.find(s => s.id === best.slug)!)
    pool = pool.filter(s => s.id !== best.slug)
  }
  if (!candidates.length) return none
  if (!query.deviceFamily && candidates.some(s => s.deviceFamily)) return { ...none, kind: 'ASK_DEVICE' }
  if (!versionProvided && candidates.some(s => s.versionMin || s.versionMax)) return { ...none, kind: 'ASK_VERSION' }
  return { kind: 'ANSWER', sections: candidates, access: await resolveHelpAccess(context, candidates) }
}
