/**
 * `avoqado_help` (everyone) and `avoqado_internal_docs` (SUPERADMIN only) — src/mcp/tools/help.ts.
 * The knowledge module is mocked so this tests the tool contract, not the files on disk.
 */
import { registerHelpTools } from '../../../src/mcp/tools/help'
import type { McpScope } from '../../../src/mcp/scope'

const article = (slug: string, extra: Partial<Record<string, unknown>> = {}) => ({
  slug,
  title: `Título ${slug}`,
  description: `Descripción ${slug}`,
  category: 'ventas',
  keywords: [] as string[],
  roles: ['OWNER'],
  related: [] as string[],
  body: `Cuerpo de ${slug}`,
  ...extra,
})

const ARTICLES = [
  article('overview', { category: 'general', body: 'Avoqado es una plataforma.' }),
  article('crear-liga-pago', { related: ['ver-pagos'], url: 'https://avoqado.io/help/dashboard/ventas/crear-liga-pago', featureCode: 'X' }),
  article('ver-pagos'),
]
const DOCS = [
  { name: 'ARCHITECTURE_OVERVIEW', title: 'Architecture Overview', sizeChars: 20, body: 'x'.repeat(20) },
  { name: 'PAYMENT_ARCHITECTURE', title: 'Payments', sizeChars: 5000, body: 'y'.repeat(5000) },
]

jest.mock('../../../src/mcp/knowledge', () => {
  const actual = jest.requireActual('../../../src/mcp/knowledge')
  return { ...actual, getHelpArticles: () => ARTICLES, getInternalDocs: () => DOCS }
})

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

function register(scope: Partial<McpScope>) {
  const handlers = new Map<string, Handler>()
  const descriptions = new Map<string, string>()
  registerHelpTools(
    {
      tool: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as Handler)
        descriptions.set(a[0] as string, a[1] as string)
      },
    } as never,
    { staffId: 's1', activeOrg: 'o1', allowedVenueIds: [], perVenueAccess: new Map(), ...scope } as McpScope,
  )
  return { handlers, descriptions }
}

describe('registration by role', () => {
  it('a customer connection gets avoqado_help but NOT avoqado_internal_docs (not even listed)', () => {
    const { handlers } = register({ isSuperAdmin: undefined })
    expect([...handlers.keys()]).toEqual(['avoqado_help'])
  })

  it('a superadmin connection gets both', () => {
    const { handlers } = register({ isSuperAdmin: true })
    expect([...handlers.keys()].sort()).toEqual(['avoqado_help', 'avoqado_internal_docs'])
  })

  it('tool descriptions do not mention ORM / model / infra internals', () => {
    const { descriptions } = register({ isSuperAdmin: true })
    for (const d of descriptions.values()) expect(d).not.toMatch(/prisma|postgres|\b[A-Z][a-z]+\.[a-z]+Id\b/i)
  })
})

describe('avoqado_help', () => {
  const help = () => register({}).handlers.get('avoqado_help')!

  it('without topic returns the overview body + an index of the other articles', async () => {
    const out = parse(await help()({}, {}))
    expect(out.ok).toBe(true)
    expect(out.overview).toBe('Avoqado es una plataforma.')
    expect(out.articles.map((a: { slug: string }) => a.slug)).toEqual(['crear-liga-pago', 'ver-pagos'])
    expect(out.articles[0]).toMatchObject({
      title: 'Título crear-liga-pago',
      category: 'ventas',
      url: expect.stringContaining('avoqado.io'),
    })
    expect(out.articles[0].body).toBeUndefined() // index only — bodies come with a topic
  })

  it('with a topic returns the matching article body, its public url and resolved related articles', async () => {
    const out = parse(await help()({ topic: 'liga de pago' }, {}))
    expect(out.ok).toBe(true)
    expect(out.slug).toBe('crear-liga-pago')
    expect(out.body).toBe('Cuerpo de crear-liga-pago')
    expect(out.url).toBe('https://avoqado.io/help/dashboard/ventas/crear-liga-pago')
    expect(out.related).toEqual([expect.objectContaining({ slug: 'ver-pagos', title: 'Título ver-pagos' })])
  })

  it('with an unknown topic returns ok:false with a hint to contact support — never invents content', async () => {
    const out = parse(await help()({ topic: 'criptomonedas en marte' }, {}))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/No encontré/)
    expect(out.hint).toMatch(/hola@avoqado\.io/)
    expect(out.body).toBeUndefined()
  })
})

describe('avoqado_internal_docs (superadmin)', () => {
  const docs = () => register({ isSuperAdmin: true }).handlers.get('avoqado_internal_docs')!

  it('without doc returns the index (name, title, size) without bodies', async () => {
    const out = parse(await docs()({}, {}))
    expect(out.ok).toBe(true)
    expect(out.docs).toEqual([
      { name: 'ARCHITECTURE_OVERVIEW', title: 'Architecture Overview', sizeChars: 20 },
      { name: 'PAYMENT_ARCHITECTURE', title: 'Payments', sizeChars: 5000 },
    ])
  })

  it('returns a document by name (case-insensitive, .md tolerated) and truncates to maxChars', async () => {
    const full = parse(await docs()({ doc: 'architecture_overview.md' }, {}))
    expect(full).toMatchObject({ ok: true, name: 'ARCHITECTURE_OVERVIEW', truncated: false })
    expect(full.body).toHaveLength(20)

    const cut = parse(await docs()({ doc: 'PAYMENT_ARCHITECTURE', maxChars: 1000 }, {}))
    expect(cut.truncated).toBe(true)
    expect(cut.body).toHaveLength(1000)
    expect(cut.sizeChars).toBe(5000)
  })

  it('rejects a name outside the allowlist and lists what IS available', async () => {
    const out = parse(await docs()({ doc: 'SECRETS' }, {}))
    expect(out.ok).toBe(false)
    expect(out.available).toEqual(['ARCHITECTURE_OVERVIEW', 'PAYMENT_ARCHITECTURE'])
  })
})
