/**
 * Knowledge base behind `avoqado_help` / `avoqado_internal_docs` (src/mcp/knowledge).
 * Fixture articles live in a temp dir; one regression test reads the REAL bundled assets so a
 * broken sync (scripts/sync-mcp-help.sh) or a missing overview fails here, not in production.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  findArticle,
  HELP_DIR,
  INTERNAL_DOCS_ALLOWLIST,
  loadHelpArticles,
  loadInternalDocs,
  normalize,
  parseFrontmatter,
} from '../../../src/mcp/knowledge'

const write = (root: string, rel: string, content: string) => {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

let tmp: string
let docsDir: string
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-help-'))
  docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-docs-')) // sibling, NOT inside tmp (the help walk is recursive)
  write(
    tmp,
    '_overview.md',
    `---
title: Qué es Avoqado
description: Resumen general
category: general
keywords:
  - estetica
  - gimnasio
  - plan
---

## Qué es Avoqado

Plataforma todo-en-uno.`,
  )
  write(
    tmp,
    'ventas/crear-liga-pago.md',
    `---
title: Crear una liga de pago
description: Aprende a crear y compartir una liga de pago.
product: dashboard
category: ventas
featureCode: AVOQADO_PAYMENT_LINKS
roles:
  - OWNER
  - ADMIN
relatedArticles:
  - ver-pagos
---

## Crear la liga

1. Entra a **Ventas > Ligas de Pago**.`,
  )
  write(
    tmp,
    'ventas/ver-pagos.md',
    `---
title: Ver pagos
description: Revisa los cobros de tu local.
category: ventas
roles:
  - OWNER
---

Lista de pagos con su método (tarjeta, efectivo).`,
  )
  write(
    tmp,
    '_facturacion.md',
    `---
title: Cómo funciona la facturación CFDI
description: Timbrado, factura global y nómina.
category: general
---

Facturación para tu negocio.`,
  )
  write(
    tmp,
    'equipo/gestionar-miembros.md',
    `---
title: Gestionar miembros del equipo
description: Invita, da de alta y desactiva empleados.
category: equipo
---

Alta de un miembro.`,
  )
  write(docsDir, 'ARCHITECTURE_OVERVIEW.md', '# Architecture Overview\n\nExpress + Prisma.')
  write(docsDir, 'PAYMENT_ARCHITECTURE.md', 'no heading here')
  write(docsDir, 'MP_SUPPORT_TICKET_DRAFT.md', '# not allowlisted')
})
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(docsDir, { recursive: true, force: true })
})

describe('parseFrontmatter', () => {
  it('parses scalars and lists, and strips the frontmatter from the body', () => {
    const { meta, body } = parseFrontmatter(`---\ntitle: Hola\nroles:\n  - OWNER\n  - ADMIN\n---\n\n# Body`)
    expect(meta.title).toBe('Hola')
    expect(meta.roles).toEqual(['OWNER', 'ADMIN'])
    expect(body).toBe('# Body')
  })

  it('returns the whole text as body when there is no frontmatter', () => {
    expect(parseFrontmatter('# Solo cuerpo')).toEqual({ meta: {}, body: '# Solo cuerpo' })
  })
})

describe('loadHelpArticles', () => {
  it('reads every .md recursively, strips the leading _ of manual overviews and builds the public URL for synced articles', () => {
    const articles = loadHelpArticles(tmp)
    const slugs = articles.map(a => a.slug).sort()
    expect(slugs).toEqual(['crear-liga-pago', 'facturacion', 'gestionar-miembros', 'overview', 'ver-pagos'])

    const liga = articles.find(a => a.slug === 'crear-liga-pago')!
    expect(liga.title).toBe('Crear una liga de pago')
    expect(liga.category).toBe('ventas')
    expect(liga.featureCode).toBe('AVOQADO_PAYMENT_LINKS')
    expect(liga.roles).toEqual(['OWNER', 'ADMIN'])
    expect(liga.related).toEqual(['ver-pagos'])
    expect(liga.url).toBe('https://avoqado.io/help/dashboard/ventas/crear-liga-pago')
    expect(liga.body).toContain('Ventas > Ligas de Pago')

    const overview = articles.find(a => a.slug === 'overview')!
    expect(overview.url).toBeUndefined() // hand-written, no public page
    expect(overview.category).toBe('general')
    expect(overview.keywords).toEqual(['estetica', 'gimnasio', 'plan'])
    expect(liga.keywords).toEqual([]) // absent frontmatter → empty, never undefined
  })

  it('returns [] for a missing directory instead of throwing', () => {
    expect(loadHelpArticles(path.join(tmp, 'nope'))).toEqual([])
  })
})

describe('findArticle', () => {
  const articles = () => loadHelpArticles(tmp)

  it('matches an exact slug', () => {
    expect(findArticle(articles(), 'ver-pagos').article?.slug).toBe('ver-pagos')
  })

  it('matches by title substring ignoring accents and case', () => {
    expect(findArticle(articles(), 'LIGA DE PAGO').article?.slug).toBe('crear-liga-pago')
    expect(findArticle(articles(), 'qué es avoqado').article?.slug).toBe('overview')
  })

  it('matches a natural-language question by keywords in title/description', () => {
    expect(findArticle(articles(), '¿cómo creo una liga para cobrar?').article?.slug).toBe('crear-liga-pago')
  })

  it('ignores question stopwords ("cómo", "funciona", "doy"…) so a how-to title does not hijack unrelated questions', () => {
    expect(findArticle(articles(), '¿cómo doy de alta a un empleado?').article?.slug).toBe('gestionar-miembros')
    expect(findArticle(articles(), '¿Avoqado tiene facturación?').article?.slug).toBe('facturacion')
    expect(findArticle(articles(), 'cómo funciona la liga de pago').article?.slug).toBe('crear-liga-pago')
  })

  it('a body-only hit is NOT enough to match NOR to suggest (it was pure noise: "¿usan Redis?" used to surface "Revisar reportes de ventas")', () => {
    const r = findArticle(articles(), 'tarjeta') // appears only in ver-pagos' BODY
    expect(r.article).toBeNull()
    expect(r.suggestions).toEqual([])
  })

  it('a description-level hit is too weak to answer, but strong enough to suggest', () => {
    const r = findArticle(articles(), 'cobros') // ver-pagos description: "Revisa los cobros de tu local."
    expect(r.article).toBeNull()
    expect(r.suggestions.map(s => s.slug)).toContain('ver-pagos')
  })

  it("declared keywords rank at TITLE weight, so an article answers the operator's own vocabulary", () => {
    // "estética"/"gimnasio" appear in NO title and NO body of the fixture — only in `keywords`.
    expect(findArticle(articles(), '¿Avoqado sirve para una estética?').article?.slug).toBe('overview')
    expect(findArticle(articles(), '¿sirve para un gimnasio?').article?.slug).toBe('overview')
  })

  it('a fully generic question ("¿qué es Avoqado?", "¿para qué sirve?") returns the overview instead of nothing', () => {
    for (const q of ['¿Qué es Avoqado?', '¿Para qué sirve Avoqado?', '¿Qué hace Avoqado?', '¿De qué se trata esto?']) {
      expect(findArticle(articles(), q).article?.slug).toBe('overview')
    }
  })

  it('returns null and no suggestions when nothing matches at all', () => {
    expect(findArticle(articles(), 'xyzzy')).toEqual({ article: null, suggestions: [] })
  })

  it('normalize strips accents and case', () => {
    expect(normalize('Facturación CFDI')).toBe('facturacion cfdi')
  })
})

describe('loadInternalDocs (superadmin allowlist)', () => {
  it('serves ONLY allowlisted names, uses the first heading as title, and skips missing files silently', () => {
    const docs = loadInternalDocs(docsDir, ['ARCHITECTURE_OVERVIEW', 'PAYMENT_ARCHITECTURE', 'DOES_NOT_EXIST'])
    expect(docs.map(d => d.name)).toEqual(['ARCHITECTURE_OVERVIEW', 'PAYMENT_ARCHITECTURE'])
    expect(docs[0].title).toBe('Architecture Overview')
    expect(docs[1].title).toBe('PAYMENT_ARCHITECTURE') // no heading → falls back to the name
    expect(docs[0].body).toContain('Express + Prisma')
  })

  it('never returns a file that is not on the allowlist even if it exists', () => {
    const docs = loadInternalDocs(docsDir, ['ARCHITECTURE_OVERVIEW'])
    expect(docs.find(d => d.name === 'MP_SUPPORT_TICKET_DRAFT')).toBeUndefined()
  })
})

describe('bundled assets (regression: the real files the server ships)', () => {
  it('src/assets/mcp-knowledge/help has the overview + the synced help-center articles', () => {
    const articles = loadHelpArticles(HELP_DIR)
    expect(articles.find(a => a.slug === 'overview')?.title).toMatch(/Avoqado/)
    const factura = articles.find(a => a.slug === 'facturacion-y-contabilidad')!
    expect(factura).toBeDefined()
    // The two hand-written articles carry the operator vocabulary the landing articles lack.
    expect(factura.keywords).toEqual(expect.arrayContaining(['cfdi', 'sat', 'conciliacion', 'nomina']))
    expect(articles.find(a => a.slug === 'overview')!.keywords).toEqual(expect.arrayContaining(['estetica', 'premium', 'precio']))
    expect(articles.filter(a => a.url).length).toBeGreaterThanOrEqual(30) // synced from avoqado-landing
    // Every synced article has a title and a category folder — a broken sync shows up here.
    for (const a of articles) expect(a.title).toBeTruthy()
  })

  it('the internal-docs allowlist only names docs that actually exist in docs/', () => {
    const docs = loadInternalDocs()
    expect(docs.map(d => d.name).sort()).toEqual([...INTERNAL_DOCS_ALLOWLIST].sort())
  })
})
