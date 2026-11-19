import { findArticle, indexTokens, loadHelpArticles, tokenHit, tokenize } from '@/mcp/knowledge'
import {
  compareVersions,
  loadSupportLibrary,
  matchesVersionRange,
  sourceRef,
  type HelpApp,
  type LibraryGuide,
} from '@/services/support/knowledge.service'
import {
  UNDERSTAND_INDEX_CAP,
  guideIdsOf,
  hybridDraftGuides,
  hybridNeeds,
  savedGuidesNeed,
  scopeSupportLibrary,
  topSupportCandidates,
} from '@/services/support/hybrid.service'
import { deviceFamilyOf, mergeDeviceContext, normalizeAppVersion } from '@/services/support/deviceContext.service'

/** Una página de la biblioteca; `app` sale del id salvo en las copias generales. */
const page = (id: string, extra: Partial<LibraryGuide> = {}): LibraryGuide => ({
  id,
  app: id.split('/')[0] as HelpApp,
  title: id,
  summary: id,
  steps: [id],
  publicUrl: '',
  requiredPermissions: [],
  keywords: [],
  body: id,
  general: false,
  internal: true,
  hash: 'a'.repeat(64),
  ...extra,
})
const ids = (guides: LibraryGuide[]) => guides.map(g => `${g.id}:${g.app}`)

describe('version and device of the conversation', () => {
  it('normalizes 2.25.42-escritorio and 2.19.0 (130); rejects «beta»', () => {
    expect(normalizeAppVersion('2.25.42-escritorio')).toBe('2.25.42')
    expect(normalizeAppVersion('2.19.0 (130)')).toBe('2.19.0')
    expect(normalizeAppVersion('2.13.2-nexgo-prod')).toBe('2.13.2')
    expect(normalizeAppVersion('uso la 2.19')).toBe('2.19')
    expect(normalizeAppVersion('beta')).toBeNull()
    expect(normalizeAppVersion(null)).toBeNull()
    expect(normalizeAppVersion('1.2.3.4')).toBeNull()
    // El punto final de una frase no es parte de la versión; un punto seguido de un dígito sí la invalida.
    expect(normalizeAppVersion('Tengo la 2.19.0.')).toBe('2.19.0')
    expect(normalizeAppVersion('la 2.19.')).toBe('2.19')
    expect(normalizeAppVersion('2.25.42-escritorio.')).toBe('2.25.42')
    // Más de 40 caracteres no es una versión escrita: es otra cosa.
    expect(normalizeAppVersion(`${'x'.repeat(35)} 2.19.0`)).toBeNull()
  })

  it('a brand starting with PAX or Nexgo is that family; any other brand is unknown', () => {
    expect(deviceFamilyOf('PAX')).toBe('PAX')
    expect(deviceFamilyOf('pax A920')).toBe('PAX')
    expect(deviceFamilyOf('NEXGO')).toBe('NEXGO')
    expect(deviceFamilyOf('Nexgo N86')).toBe('NEXGO')
    expect(deviceFamilyOf('SUNMI')).toBeNull()
    expect(deviceFamilyOf(null)).toBeNull()
  })

  it('compareVersions and matchesVersionRange read N.N(.N) only; an exact suffix matches only itself', () => {
    expect(compareVersions('2.19.0', '2.18.9')).toBeGreaterThan(0)
    expect(compareVersions('2.19', '2.19.0')).toBe(0)
    expect(compareVersions('2.9.0', '2.10.0')).toBeLessThan(0)
    expect(compareVersions('2.13.2-nexgo-prod', '2.13.2')).toBeNull()
    expect(matchesVersionRange('2.19.0', '2.19.0', '2.20.0')).toBe(true)
    expect(matchesVersionRange('2.18.0', '2.19.0')).toBe(false)
    expect(matchesVersionRange('2.21.0', undefined, '2.20.0')).toBe(false)
    expect(matchesVersionRange('beta')).toBe(true)
    expect(matchesVersionRange('beta', '2.19.0')).toBe(false)
    expect(matchesVersionRange('2.13.2-nexgo-prod', '2.13.2-nexgo-prod', '2.13.2-nexgo-prod')).toBe(true)
  })

  it('what the conversation says wins; the rest comes only from one value shared by every device of that app', () => {
    const tpv = (brand: string | null, version: string | null) => ({ type: 'TPV_ANDROID', brand, version })
    const said = { appVersion: null, deviceFamily: null }
    expect(mergeDeviceContext('tpv', said, [tpv('PAX', '2.16.0'), tpv('PAX', '2.16.0-pax-prod')])).toEqual({
      version: '2.16.0',
      family: 'PAX',
    })
    expect(mergeDeviceContext('tpv', said, [tpv('PAX', '2.16.0'), tpv('NEXGO', '2.16.0')])).toEqual({ version: '2.16.0' })
    expect(mergeDeviceContext('tpv', said, [tpv('PAX', '2.16.0'), tpv('Ingenico', '2.16.0')])).toEqual({ version: '2.16.0' })
    expect(mergeDeviceContext('tpv', said, [tpv('PAX', '2.16.0'), tpv('PAX', null)])).toEqual({ family: 'PAX' })
    expect(mergeDeviceContext('tpv', { appVersion: '2.19.0 (130)', deviceFamily: 'NEXGO' }, [tpv('PAX', '2.16.0')])).toEqual({
      version: '2.19.0',
      family: 'NEXGO',
    })
    // App por aparato, como scripts/versiones-vivas.py: el POS de Windows reporta «-escritorio».
    const pos = [
      { type: 'POS_ANDROID', brand: 'SUNMI', version: '2.25.42' },
      { type: 'POS_ANDROID', brand: 'Dell', version: '2.25.41-escritorio' },
    ]
    expect(mergeDeviceContext('android', said, pos)).toEqual({ version: '2.25.42' })
    expect(mergeDeviceContext('windows', said, pos)).toEqual({ version: '2.25.41' })
    expect(mergeDeviceContext('tpv', said, pos)).toEqual({})
    expect(mergeDeviceContext('dashboard', said, [tpv('PAX', '2.16.0')])).toEqual({})
  })
})

describe('scopeSupportLibrary', () => {
  const overview = (app: HelpApp) => page('general/overview', { app, general: true })

  it('scope keeps app, dashboard and its own general copy; drops other apps', () => {
    const library = [
      page('android/caja/abrir-caja'),
      page('dashboard/menu/gestionar-productos'),
      page('tpv/cobro/cobrar-con-tarjeta'),
      page('windows/caja/abrir-caja'),
      ...(['android', 'dashboard', 'tpv', 'windows'] as const).map(overview),
    ]
    const tpv = scopeSupportLibrary(library, { app: 'tpv' })
    expect(ids(tpv.guides)).toEqual([
      'dashboard/menu/gestionar-productos:dashboard',
      'tpv/cobro/cobrar-con-tarjeta:tpv',
      'general/overview:tpv',
    ])
    expect(tpv.outdated.size).toBe(0)
    expect(ids(scopeSupportLibrary(library, { app: 'dashboard' }).guides)).toEqual([
      'dashboard/menu/gestionar-productos:dashboard',
      'general/overview:dashboard',
    ])
  })

  it('known family drops the other family; unknown keeps both variants', () => {
    const library = [
      page('tpv/cobro/cobrar-con-pax', { deviceFamily: 'PAX' }),
      page('tpv/cobro/cobrar-con-nexgo', { deviceFamily: 'NEXGO' }),
      page('tpv/cobro/reimprimir'),
    ]
    expect(scopeSupportLibrary(library, { app: 'tpv', family: 'PAX' }).guides.map(g => g.id)).toEqual([
      'tpv/cobro/cobrar-con-pax',
      'tpv/cobro/reimprimir',
    ])
    expect(scopeSupportLibrary(library, { app: 'tpv', family: 'NEXGO' }).guides.map(g => g.id)).toEqual([
      'tpv/cobro/cobrar-con-nexgo',
      'tpv/cobro/reimprimir',
    ])
    expect(scopeSupportLibrary(library, { app: 'tpv' }).guides).toEqual(library)
  })

  it('known version drops pages whose versionMax is older; keeps a newer page only when its task has no matching page, and marks it outdated', () => {
    const library = [
      page('tpv/cobro/cobrar-viejo', { versionMax: '2.17.0', task: 'cobrar' }),
      page('tpv/cobro/cobrar', { versionMin: '2.10.0', versionMax: '2.18.5', task: 'cobrar' }),
      page('tpv/cobro/cobrar-nuevo', { versionMin: '2.19.0', task: 'cobrar' }),
      page('tpv/propina/propina-219', { versionMin: '2.19.0', task: 'propina' }),
      page('tpv/propina/propina-220', { versionMin: '2.20.0', task: 'propina' }),
      page('tpv/cierre/cerrar-turno', { versionMin: '2.21.0' }),
      page('tpv/cobro/reimprimir'),
    ]
    const scoped = scopeSupportLibrary(library, { app: 'tpv', version: '2.18.0' })
    expect(scoped.guides.map(g => g.id)).toEqual([
      'tpv/cobro/cobrar',
      'tpv/propina/propina-219',
      'tpv/cierre/cerrar-turno',
      'tpv/cobro/reimprimir',
    ])
    expect([...scoped.outdated]).toEqual([
      ['tpv/propina/propina-219', '2.19.0'],
      ['tpv/cierre/cerrar-turno', '2.21.0'],
    ])
    // Sin versión se quedan todas las variantes y nada es viejo.
    const unknown = scopeSupportLibrary(library, { app: 'tpv' })
    expect(unknown.guides).toEqual(library)
    expect(unknown.outdated.size).toBe(0)
  })

  it('hybridNeeds asks DEVICE before VERSION, and nothing when both are known', () => {
    const both = [page('tpv/cobro/cobrar-con-pax', { deviceFamily: 'PAX', versionMin: '2.19.0' })]
    expect(hybridNeeds(both, { app: 'tpv' })).toBe('DEVICE')
    expect(hybridNeeds(both, { app: 'tpv', family: 'PAX' })).toBe('VERSION')
    expect(hybridNeeds(both, { app: 'tpv', family: 'PAX', version: '2.19.0' })).toBeNull()
    expect(hybridNeeds([page('tpv/cobro/reimprimir')], { app: 'tpv' })).toBeNull()
    expect(hybridNeeds([page('tpv/cobro/cerrar', { versionMax: '2.20.0' })], { app: 'tpv', family: 'NEXGO' })).toBe('VERSION')
    expect(hybridNeeds([], { app: 'tpv' })).toBeNull()
  })

  // T-F5 (se quita la respuesta parcial de T-F2/T-F3): con la versión o el equipo sin saber, CUALQUIER guía elegida que
  // dependa de eso hace preguntar primero, aunque otra guía (la del panel) no dependa. Nunca se contesta con una parte.
  it('T-F5: any chosen guide that depends on what is unknown asks first, even next to a guide that does not', () => {
    const tip = page('android/propina/agregar-propina', { versionMin: '2.24.0' })
    const close = page('android/caja/cerrar-caja', { versionMax: '2.20.0' })
    const panel = page('dashboard/menu/gestionar-productos')
    expect(hybridNeeds([tip, panel], { app: 'android' })).toBe('VERSION')
    expect(hybridNeeds([panel, tip], { app: 'android' })).toBe('VERSION')
    expect(hybridNeeds([tip, close], { app: 'android' })).toBe('VERSION')
    expect(hybridNeeds([tip, panel], { app: 'android', version: '2.25.0' })).toBeNull()
    const pax = page('tpv/cobro/cobrar-con-pax', { deviceFamily: 'PAX' })
    const terminals = page('dashboard/terminales/gestionar-terminales')
    const tpvTip = page('tpv/propina/agregar-propina', { versionMin: '2.19.0' })
    expect(hybridNeeds([pax, terminals], { app: 'tpv' })).toBe('DEVICE')
    expect(hybridNeeds([terminals, pax], { app: 'tpv' })).toBe('DEVICE')
    expect(hybridNeeds([pax, tpvTip], { app: 'tpv' })).toBe('DEVICE')
    expect(hybridNeeds([pax, tpvTip], { app: 'tpv', family: 'PAX' })).toBe('VERSION')
    expect(hybridNeeds([pax, terminals], { app: 'tpv', family: 'PAX' })).toBeNull()
  })

  // T-F22 (examen b-tf21-r1): con la biblioteca real y sin saber versión ni equipo. c13 («con la terminal tmb se puede cobrar en
  // efectivo o nomas tarjeta») y su gemelo («¿la terminal acepta tarjetas con chip o sólo sin contacto?») son un sí o no que contesta
  // general/overview: con él no se pregunta nada, aunque su guía de pasos sola pediría la versión o el equipo. Las guías de pasos de
  // c15, c38, c40 y c41 dependen de la versión y la siguen pidiendo. El cambio de T-F22 está en entender (hybrid-understand); esto
  // fija que el código no lo contradice.
  it('T-F22 (real library): the yes or no of c13 and its twin, answered by general/overview, asks nothing; c15, c38, c40 and c41 still ask the version', () => {
    const library = loadSupportLibrary({ allowDraft: true })
    const need = (app: HelpApp, chosenIds: string[]) => {
      const chosen = hybridDraftGuides(chosenIds, scopeSupportLibrary(library, { app }).guides)
      expect(chosen.map(g => g.id)).toEqual(chosenIds)
      return hybridNeeds(chosen, { app })
    }
    expect(need('tpv', ['general/overview'])).toBeNull()
    expect(need('tpv', ['tpv/cobro/cobrar-en-efectivo'])).toBe('VERSION')
    expect(need('tpv', ['tpv/cobro/cobrar-con-tarjeta-pax'])).toBe('DEVICE')
    expect(need('android', ['android/cobro/cobrar-sin-internet'])).toBe('VERSION')
    expect(need('windows', ['windows/cobro/cobrar-en-efectivo'])).toBe('VERSION')
    expect(need('android', ['android/recibos/imprimir-y-reimprimir-recibo'])).toBe('VERSION')
    expect(need('android', ['android/impresoras/agregar-y-probar-impresora'])).toBe('VERSION')
  })

  // T-F5 (Codex P1 y r2-3): lo guardado (RECUPERAR, la reconstrucción de la cola) es todo o nada contra el alcance de hoy.
  it('savedGuidesNeed: all or nothing; what no longer fits or is gone is GONE, what needs an unknown version or terminal asks (T-F5)', () => {
    const stamp = page('android/lealtad/sello-que-no-se-sumo', { versionMin: '2.25.7' })
    const panel = page('dashboard/clientes/configurar-lealtad')
    const pax = page('tpv/cobro/cobrar-con-pax', { deviceFamily: 'PAX' })
    const ended = page('android/caja/cerrar-caja', { versionMax: '2.20.0' })
    const refs = (...guides: LibraryGuide[]) => guides.map(sourceRef)
    const need = (guides: LibraryGuide[], scope: Parameters<typeof savedGuidesNeed>[2], sourceIds = refs(...guides)) =>
      savedGuidesNeed(sourceIds, guides, scope)
    // Every saved guide still fits: rebuilt with all of them.
    expect(need([stamp, panel], { app: 'android', version: '2.25.7' })).toBeNull()
    expect(need([panel], { app: 'android' })).toBeNull()
    // Codex's repro: an ANDROID guide from 2.25.7 with the version unknown asks, alone or next to a panel guide (never the panel alone).
    expect(need([stamp], { app: 'android' })).toBe('VERSION')
    expect(need([stamp, panel], { app: 'android' })).toBe('VERSION')
    expect(need([pax, page('dashboard/terminales/gestionar-terminales')], { app: 'tpv' })).toBe('DEVICE')
    // No longer fits: another app, another terminal, a version that ended or one that has not reached them yet; alone or not.
    expect(need([stamp], { app: 'windows', version: '2.25.7' })).toBe('GONE')
    expect(need([pax], { app: 'tpv', family: 'NEXGO' })).toBe('GONE')
    expect(need([ended, panel], { app: 'android', version: '2.25.0' })).toBe('GONE')
    expect(need([stamp, panel], { app: 'android', version: '2.25.0' })).toBe('GONE')
    // A saved guide the library no longer has (retired) is GONE too: what is left is never sent on its own.
    expect(need([panel], { app: 'android' }, refs(stamp, panel))).toBe('GONE')
    expect(need([], { app: 'android' }, refs(panel))).toBe('GONE')
    // What no longer fits wins over asking: the version would not bring it back.
    expect(need([pax, stamp], { app: 'android' })).toBe('GONE')
    // A general overview fits any app: any copy resolves its id (they are identical).
    const overview = page('general/overview', { app: 'dashboard', general: true })
    expect(need([overview], { app: 'tpv' })).toBeNull()
  })
})

describe('top-N before understand (Task 3)', () => {
  /** Una página de la que sólo cuenta el título para el puntaje (id, resumen y cuerpo neutros). */
  const titled = (id: string, title: string, extra: Partial<LibraryGuide> = {}) =>
    page(id, { title, summary: 'Nada.', body: 'Nada.', ...extra })
  const byId = (guides: LibraryGuide[]) => guides.map(g => g.id)
  const fillers = (n: number) =>
    Array.from({ length: n }, (_, i) => titled(`dashboard/propinas/p${String(i).padStart(3, '0')}`, `Propinas ${i}`))

  it('findArticle returns exactly what it returned before', () => {
    // Salida guardada con el findArticle de antes de extraer scoreArticles (f1-t2), sobre los artículos reales del MCP.
    // La fila de facturación se volvió a sacar el 16-nov con ese mismo findArticle: develop reescribió la guía de billing (eb12482c5).
    // La del empleado, el 18-nov: el renglón «Básico» de _overview (develop, #484) dice «En el alta…» y suma «overview».
    const before: [string, string | null, string[]][] = [
      ['¿cómo doy de alta a un empleado?', 'gestionar-miembros', ['crear-liga-pago', 'overview']],
      ['¿Avoqado tiene facturación?', 'facturacion-y-contabilidad', ['comprar-addons-suscripciones']],
      [
        'cómo creo una liga de pago',
        'crear-liga-pago',
        ['ver-pagos', 'revisar-billing-detallado', 'revisar-reportes-avanzados', 'gestionar-cobros-avanzados'],
      ],
      ['¿cómo veo mis ventas del día?', 'revisar-reportes-ventas', ['entender-inicio-dashboard']],
      [
        'quiero agregar un producto al menú',
        'gestionar-productos',
        ['configurar-menu-avanzado', 'ver-pedidos', 'revisar-reportes-ventas', 'gestionar-miembros'],
      ],
      ['¿cómo hago el corte de caja?', null, []],
      ['inventario y existencias', 'gestionar-inventario', ['gestionar-inventario-avanzado']],
      ['¿qué es Avoqado?', 'overview', []],
      ['cambiar mi plan de suscripción', 'overview', ['comprar-addons-suscripciones', 'cambiar-sucursal']],
      ['propinas de los meseros', null, []],
    ]
    const articles = loadHelpArticles()
    expect(
      before.map(([topic]) => {
        const r = findArticle(articles, topic)
        return [topic, r.article?.slug ?? null, r.suggestions.map(s => s.slug)]
      }),
    ).toEqual(before)
  })

  it('the indexed tokenHit matches exactly what the linear scan matched, over the real help articles', () => {
    // El de antes de f1-t3-fix1, copiado tal cual: recorre todos los tokens por cada término.
    const linear = (tokens: string[], w: string): boolean =>
      tokens.some(t => t === w || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t) && w.length - t.length <= 2))
    const articles = loadHelpArticles()
    const fields = articles.flatMap(a => [
      tokenize(a.slug),
      [...tokenize(a.title), ...a.keywords.flatMap(tokenize)],
      tokenize(a.description),
      tokenize(a.body),
    ])
    // Términos de cada rama: el token exacto, sus prefijos (de 1 a todos menos uno) y el token con 1, 2 y 3 letras de más.
    const vocabulary = [...new Set(fields.flat())].sort().filter((_, i) => i % 6 === 0)
    const terms = new Set(['a', 'de', 'las', 'pago', 'pagos', 'pagoss', 'pagosss', 'inventari', 'reservacion', 'turnos'])
    for (const t of vocabulary) {
      for (let k = 1; k <= t.length; k++) terms.add(t.slice(0, k))
      for (const extra of ['s', 'es', 'ado']) terms.add(t + extra)
    }
    let hits = 0,
      checks = 0
    for (const tokens of fields) {
      const index = indexTokens(tokens)
      for (const w of terms) {
        const expected = linear(tokens, w)
        if (tokenHit(index, w) !== expected) throw new Error(`«${w}» en [${tokens.slice(0, 5).join(' ')}…]: esperaba ${expected}`)
        if (expected) hits++
        checks++
      }
    }
    // Que la tabla de verdad cubra las dos respuestas.
    expect(hits).toBeGreaterThan(1000)
    expect(checks - hits).toBeGreaterThan(1000)
  })

  it('under the cap every guide goes; over it, generals and keep always go and the rest by score', () => {
    const library = [
      titled('dashboard/a/corte', 'Corte de caja'), // «turno» → «corte» (sinónimo): 6
      titled('dashboard/a/inventario', 'Inventario'), // 0
      titled('dashboard/a/propinas', 'Propinas'), // 10
      titled('dashboard/a/propinas-turno', 'Propinas del turno'), // 20
      titled('dashboard/a/reportes', 'Reportes'), // 0
      titled('dashboard/a/sucursal', 'Cambiar de sucursal'), // 0, citada por una respuesta
      titled('general/overview', 'Qué es Avoqado', { app: 'dashboard', general: true }), // 0
    ]
    const input = { text: '¿Cómo reparto las propinas del turno?', keep: ['dashboard/a/sucursal'], app: 'dashboard' as const }
    expect(topSupportCandidates(library, input, library.length)).toBe(library)
    expect(byId(topSupportCandidates(library, input, 4))).toEqual([
      'dashboard/a/propinas',
      'dashboard/a/propinas-turno',
      'dashboard/a/sucursal',
      'general/overview',
    ])
    expect(byId(topSupportCandidates(library, input, 5))).toEqual([
      'dashboard/a/corte',
      'dashboard/a/propinas',
      'dashboard/a/propinas-turno',
      'dashboard/a/sucursal',
      'general/overview',
    ])
    // Lo que siempre entra no se recorta aunque pase del tope.
    expect(byId(topSupportCandidates(library, { ...input, keep: ['dashboard/a/sucursal', 'dashboard/a/reportes'] }, 2))).toEqual([
      'dashboard/a/reportes',
      'dashboard/a/sucursal',
      'general/overview',
    ])
  })

  it('T-F1: the cap fits every guide of the biggest app in the real library, with 20 % headroom', () => {
    const library = loadSupportLibrary({ allowDraft: true })
    const apps: HelpApp[] = ['dashboard', 'android', 'windows', 'tpv']
    const scoped = apps.map(app => ({ app, guides: scopeSupportLibrary(library, { app }).guides }))
    const biggest = Math.max(...scoped.map(s => s.guides.length))
    // El 17-nov la app más grande (ANDROID y WINDOWS) tenía 97: el tope viejo (40) dejaba fuera más de la mitad.
    expect(biggest).toBeGreaterThan(40)
    // Si esto truena, la biblioteca creció: sube el tope y vuelve a medir el costo contra la barra 7.
    expect(UNDERSTAND_INDEX_CAP).toBeGreaterThanOrEqual(Math.ceil(biggest * 1.2))
    // Con faltas de ortografía nada saca puntos, y aun así entender ve toda la app.
    for (const { app, guides } of scoped)
      expect(topSupportCandidates(guides, { text: 'la maqinita no aparese', keep: [], app })).toBe(guides)
  })

  it('keeps the guides of the last two answers even with score 0', () => {
    const inventory = titled('dashboard/z/inventario', 'Inventario')
    const branch = titled('dashboard/z/sucursal', 'Cambiar de sucursal')
    const library = [...fillers(UNDERSTAND_INDEX_CAP + 8), inventory, branch]
    const input = { text: '¿y si no hay internet? propinas', app: 'dashboard' as const }
    // Sin citarlas, las guías con puntaje (8 más que el tope) las sacan del índice.
    const plain = topSupportCandidates(library, { ...input, keep: [] })
    expect(plain).toHaveLength(UNDERSTAND_INDEX_CAP)
    expect(byId(plain)).not.toContain(inventory.id)
    expect(byId(plain)).not.toContain(branch.id)
    const keep = [...guideIdsOf([sourceRef(inventory)]), ...guideIdsOf([sourceRef(branch)])]
    expect(keep).toEqual([inventory.id, branch.id])
    const kept = topSupportCandidates(library, { ...input, keep })
    expect(kept).toHaveLength(UNDERSTAND_INDEX_CAP)
    expect(byId(kept)).toEqual(expect.arrayContaining([inventory.id, branch.id]))
  })

  it('a #clarify answer keeps its options', () => {
    const inventory = titled('dashboard/z/inventario', 'Inventario')
    const branch = titled('dashboard/z/sucursal', 'Cambiar de sucursal')
    const keep = guideIdsOf(['#clarify', sourceRef(inventory), sourceRef(branch)])
    expect(keep).toEqual([inventory.id, branch.id])
    // Lo que no es una cita no aporta nada; un id de antes de la flag (sin hash) sí es su guía.
    expect(guideIdsOf(['#clarify', 'No/Es Cita', 'dashboard/menu/gestionar-productos'])).toEqual(['dashboard/menu/gestionar-productos'])
    expect(guideIdsOf([])).toEqual([])
    const kept = topSupportCandidates([...fillers(UNDERSTAND_INDEX_CAP + 5), inventory, branch], {
      text: 'propinas',
      keep,
      app: 'dashboard',
    })
    expect(kept).toHaveLength(UNDERSTAND_INDEX_CAP)
    expect(byId(kept)).toEqual(expect.arrayContaining([inventory.id, branch.id]))
  })

  it('ties prefer the conversation app, then dashboard, then id; output is sorted by id', () => {
    const library = [
      titled('dashboard/a/propinas', 'Propinas'),
      titled('dashboard/b/propinas', 'Propinas'),
      titled('dashboard/z/propinas-turno', 'Propinas del turno'), // más puntaje: gana a cualquier empate
      titled('tpv/a/propinas', 'Propinas'),
      titled('tpv/b/propinas', 'Propinas'),
      titled('tpv/c/propinas', 'Propinas'),
      titled('tpv/d/inventario', 'Inventario'), // 0: de su app, pero sin puntaje
    ]
    const input = { text: 'propinas del turno', keep: [], app: 'tpv' as const }
    expect(byId(topSupportCandidates(library, input, 4))).toEqual([
      'dashboard/z/propinas-turno',
      'tpv/a/propinas',
      'tpv/b/propinas',
      'tpv/c/propinas',
    ])
    expect(byId(topSupportCandidates(library, input, 5))).toEqual([
      'dashboard/a/propinas',
      'dashboard/z/propinas-turno',
      'tpv/a/propinas',
      'tpv/b/propinas',
      'tpv/c/propinas',
    ])
    expect(byId(topSupportCandidates(library, input, 6))).toEqual([
      'dashboard/a/propinas',
      'dashboard/b/propinas',
      'dashboard/z/propinas-turno',
      'tpv/a/propinas',
      'tpv/b/propinas',
      'tpv/c/propinas',
    ])
  })

  it('a 36-guide library is unchanged by the cap', () => {
    const library = [
      ...Array.from({ length: 34 }, (_, i) => titled(`dashboard/guias/g${String(i).padStart(2, '0')}`, `Guía ${i}`)),
      titled('general/facturacion-y-contabilidad', 'Facturación y contabilidad', { app: 'dashboard', general: true }),
      titled('general/overview', 'Qué es Avoqado', { app: 'dashboard', general: true }),
    ]
    expect(library).toHaveLength(36)
    expect(topSupportCandidates(library, { text: 'propinas', keep: [], app: 'dashboard' })).toEqual(library)
  })
})
