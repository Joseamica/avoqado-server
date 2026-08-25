/**
 * Knowledge base behind the two "explain Avoqado" MCP tools:
 *
 *   - `avoqado_help`          (everyone)   → src/assets/mcp-knowledge/help/**.md
 *                                            (the public help-center articles, synced from
 *                                            avoqado-landing via scripts/sync-mcp-help.sh, plus
 *                                            the hand-written `_*.md` overviews)
 *   - `avoqado_internal_docs` (SUPERADMIN) → docs/<allowlist>.md (architecture / internals)
 *
 * WHY a curated knowledge base instead of letting the model improvise: without it the assistant
 * answers "¿qué hace Avoqado?" by guessing from tool names. With it, the founder controls the
 * message — and the boundary: customers get product knowledge, only a superadmin gets internals.
 *
 * Path resolution works in BOTH dev (src/mcp/knowledge → src/assets, <repo>/docs) and prod
 * (dist/src/mcp/knowledge → dist/src/assets, dist/docs) because the relative layout is identical;
 * copy:assets + scripts/copy-mcp-internal-docs.js keep the dist side populated.
 */
import fs from 'fs'
import path from 'path'
import internalDocsAllowlist from './internal-docs.json'

export interface KnowledgeArticle {
  /** File basename without `.md`; a leading `_` (hand-written overviews) is stripped. */
  slug: string
  title: string
  description: string
  category: string
  featureCode?: string
  /** Frontmatter `keywords:` — operator words the article should answer to, scored at title weight. */
  keywords: string[]
  roles: string[]
  related: string[]
  /** Markdown body (frontmatter removed). */
  body: string
  /** Public help-center URL, only for articles synced from the landing (category folder). */
  url?: string
}

export interface InternalDoc {
  name: string
  title: string
  sizeChars: number
  body: string
}

export const HELP_DIR = path.resolve(__dirname, '../../assets/mcp-knowledge/help')
export const INTERNAL_DOCS_DIR = path.resolve(__dirname, '../../../docs')
export const INTERNAL_DOCS_ALLOWLIST: readonly string[] = internalDocsAllowlist.docs
const HELP_CENTER_BASE_URL = 'https://avoqado.io/help/dashboard'

// ── Frontmatter ────────────────────────────────────────────────────────────────────────────────

/**
 * Minimal YAML-frontmatter parser for the subset the help articles use: `key: value` scalars and
 * `key:` followed by `  - item` lists. No dependency needed; anything fancier is out of scope.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string | string[]>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { meta: {}, body: raw }
  const meta: Record<string, string | string[]> = {}
  let currentList: string | null = null
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && currentList) {
      ;(meta[currentList] as string[]).push(item[1].trim())
      continue
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    const [, key, value] = kv
    if (value === '') {
      meta[key] = []
      currentList = key
    } else {
      meta[key] = value.replace(/^["']|["']$/g, '')
      currentList = null
    }
  }
  return { meta, body: raw.slice(m[0].length).trim() }
}

// ── Help articles ──────────────────────────────────────────────────────────────────────────────

function walkMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkMarkdown(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out.sort()
}

const asList = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : [])
const asString = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(', ') : (v ?? ''))

/** Read every `.md` under `dir` (recursively) into articles. Pure function of the filesystem. */
export function loadHelpArticles(dir: string = HELP_DIR): KnowledgeArticle[] {
  return walkMarkdown(dir).map(file => {
    const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
    const base = path.basename(file, '.md')
    const isManual = base.startsWith('_')
    const folder = path.relative(dir, path.dirname(file))
    const category = asString(meta.category) || (folder && folder !== '.' ? folder : 'general')
    const slug = isManual ? base.slice(1) : base
    return {
      slug,
      title: asString(meta.title) || slug,
      description: asString(meta.description),
      category,
      featureCode: asString(meta.featureCode) || undefined,
      keywords: asList(meta.keywords),
      roles: asList(meta.roles),
      related: asList(meta.relatedArticles),
      body,
      // Only landing-synced articles (inside a category folder) have a public page.
      url: !isManual && folder && folder !== '.' ? `${HELP_CENTER_BASE_URL}/${folder}/${slug}` : undefined,
    }
  })
}

let helpCache: KnowledgeArticle[] | null = null
/** Cached help articles (loaded once per process; the files are static assets). */
export function getHelpArticles(): KnowledgeArticle[] {
  if (!helpCache) helpCache = loadHelpArticles()
  return helpCache
}

/** Strip accents + case so "Facturación" matches "facturacion". */
export const normalize = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()

/**
 * Words that carry no topic signal in a Spanish how-to question. Without this list, "¿cómo funciona
 * el inventario?" matched the article titled "Cómo funciona la facturación…" on "como"+"funciona".
 */
const STOPWORDS = new Set(
  (
    'a al algo ante asi bien cada como con cual cuales cuando cuanto cuanta cuantos cuantas de del desde donde doy dar ' +
    'esto eso hace hacen sirve sirven trata significa consiste ofrece ofrecen incluye incluyen ' +
    'el ella ellas ellos en entre era eres es esa ese eso esta estas este esto estos fue funciona funcionan ha hace hacer hago hay ' +
    'la las le les lo los me mi mis muy nada ni no nos o os otra otro para pero poder podria puedo puede pueden por que ' +
    'quien quiero quisiera se sea ser si sin sobre son soy su sus tal tambien tan te tener tengo ti tiene tienen tu tus un ' +
    'una unas uno unos usa usar uso ver y ya yo avoqado ayuda'
  ).split(' '),
)

/**
 * Operator vocabulary → the words the help-center articles actually use. Weighted below exact
 * query words so a synonym never outranks a literal title hit.
 */
const SYNONYMS: Record<string, string[]> = {
  empleado: ['miembro', 'equipo', 'usuario', 'personal'],
  trabajador: ['miembro', 'equipo', 'usuario', 'personal'],
  colaborador: ['miembro', 'equipo', 'usuario', 'personal'],
  staff: ['miembro', 'equipo', 'usuario', 'personal'],
  alta: ['agrega', 'agregar', 'crear', 'invitar'],
  factura: ['facturacion', 'cfdi'],
  facturar: ['facturacion', 'cfdi'],
  nomina: ['facturacion', 'contabilidad'],
  contador: ['contabilidad'],
  contable: ['contabilidad'],
  conciliacion: ['contabilidad', 'banco'],
  banco: ['conciliacion', 'saldo', 'liquidacion'],
  cobrar: ['pago', 'cobro'],
  cobro: ['pago'],
  stock: ['inventario', 'existencias'],
  existencias: ['inventario'],
  cita: ['reservacion', 'agenda'],
  reserva: ['reservacion'],
  agenda: ['reservacion'],
  propina: ['tips'],
  sucursal: ['local', 'venue'],
  plan: ['suscripcion', 'precio'],
  precio: ['plan', 'suscripcion'],
  rol: ['permiso'],
  tpv: ['terminal'],
  producto: ['menu'],
  menu: ['producto'],
  descuento: ['promocion', 'cupon'],
  link: ['liga'],
  enlace: ['liga'],
  turno: ['corte'],
  resena: ['opinion'],
}

/** The hand-written general article; also the answer to a fully generic question. */
export const OVERVIEW_SLUG = 'overview'

const tokenize = (s: string): string[] =>
  normalize(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/** Whole-token match with plural/stem tolerance: "empleado"≈"empleados", "reservaciones"≈"reservacion" — but never "alta" inside "lealtad". */
const tokenHit = (tokens: string[], w: string): boolean =>
  tokens.some(t => t === w || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t) && w.length - t.length <= 2))

export interface ArticleMatch {
  article: KnowledgeArticle | null
  /** Runner-up titles/slugs, for a "did you mean" when nothing (or something weak) matched. */
  suggestions: Array<{ slug: string; title: string }>
}

/**
 * Find the best article for a free-text topic: exact slug → whole-phrase title match → weighted
 * keyword score (title/slug 10 · description 5 · body 1, synonyms at 60 %) over whole tokens,
 * with Spanish question stopwords removed. Below a title-level hit (< 6) nothing is returned as a
 * match — only suggestions — so the assistant never presents a weak guess as the answer.
 */
export function findArticle(articles: KnowledgeArticle[], topic: string): ArticleMatch {
  const q = normalize(topic)
  if (!q) return { article: null, suggestions: [] }
  const exact = articles.find(a => normalize(a.slug) === q)
  if (exact) return { article: exact, suggestions: [] }

  const words = tokenize(q).filter(w => w.length >= 3 && !STOPWORDS.has(w))
  // "¿Qué es Avoqado?" / "¿para qué sirve?" reduce to zero topic words. That is not "no match" —
  // it is the most generic question there is, and the overview is exactly its answer. Without this
  // the single most likely first question a customer asks returned nothing.
  if (words.length === 0) {
    const overview = articles.find(a => a.slug === OVERVIEW_SLUG)
    return { article: overview ?? null, suggestions: [] }
  }
  const terms = new Map<string, number>()
  for (const w of words) terms.set(w, 1)
  for (const w of words) for (const syn of SYNONYMS[w] ?? []) if (!terms.has(syn)) terms.set(syn, 0.6)

  const MIN_MATCH = 6
  // A body-only hit (1 pt) is noise: "¿usan Redis?" surfaced "Revisar reportes de ventas" merely
  // because some body contained "usan". Only description-level (5) or better may be suggested.
  const MIN_SUGGEST = 5
  const scored = articles
    .map(a => {
      const slugTokens = tokenize(a.slug)
      // Declared keywords rank with the title: it is how an article claims the operator's own
      // vocabulary ("estética", "SAT", "corte de caja") without stuffing it into the prose.
      const titleTokens = [...tokenize(a.title), ...a.keywords.flatMap(tokenize)]
      const headTokens = tokenize(a.description)
      const bodyTokens = tokenize(a.body)
      let score = normalize(a.title).includes(q) || normalize(a.slug).includes(q) ? 100 : 0
      for (const [w, weight] of terms) {
        if (tokenHit(slugTokens, w) || tokenHit(titleTokens, w)) score += 10 * weight
        else if (tokenHit(headTokens, w)) score += 5 * weight
        else if (tokenHit(bodyTokens, w)) score += 1 * weight
      }
      return { a, score }
    })
    .filter(x => x.score > 0)
    // Tie-break toward the shorter title: the general article beats its "…avanzado" sibling.
    .sort((x, y) => y.score - x.score || x.a.title.length - y.a.title.length)

  const hasBest = scored.length > 0 && scored[0].score >= MIN_MATCH
  const suggestions = scored
    .slice(hasBest ? 1 : 0, 5)
    .filter(x => x.score >= MIN_SUGGEST)
    .map(x => ({ slug: x.a.slug, title: x.a.title }))
  return { article: hasBest ? scored[0].a : null, suggestions }
}

// ── Internal docs (superadmin) ─────────────────────────────────────────────────────────────────

/** Read the allowlisted internal docs that exist under `dir`. Missing files are skipped, never errors. */
export function loadInternalDocs(dir: string = INTERNAL_DOCS_DIR, allowlist: readonly string[] = INTERNAL_DOCS_ALLOWLIST): InternalDoc[] {
  const docs: InternalDoc[] = []
  for (const name of allowlist) {
    const file = path.join(dir, `${name}.md`)
    if (!fs.existsSync(file)) continue
    const body = fs.readFileSync(file, 'utf8')
    const heading = body.match(/^#\s+(.+)$/m)
    docs.push({ name, title: heading ? heading[1].trim() : name, sizeChars: body.length, body })
  }
  return docs
}

let internalCache: InternalDoc[] | null = null
export function getInternalDocs(): InternalDoc[] {
  if (!internalCache) internalCache = loadInternalDocs()
  return internalCache
}

/** Test hook: drop the process caches. */
export function resetKnowledgeCaches(): void {
  helpCache = null
  internalCache = null
}
