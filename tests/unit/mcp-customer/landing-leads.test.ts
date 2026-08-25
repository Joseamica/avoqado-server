/**
 * landing_leads (2026-08-23): los leads de la landing son datos de PLATAFORMA
 * (el alta nace sin venue), asi que no los puede cubrir el scope por venue de
 * get_activity_log. El candado es `scope.isSuperAdmin` — y este archivo existe
 * sobre todo por el primer test: un dueno de venue NO puede leer los leads de
 * Avoqado, que incluyen datos de contacto de prospectos.
 */
import { registerLandingLeadTools } from '../../../src/mcp/tools/landingLeads'
import type { McpScope } from '../../../src/mcp/scope'

const mockFindMany = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { activityLog: { findMany: (...a: unknown[]) => mockFindMany(...(a as [])) } },
}))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

function registrar(isSuperAdmin: boolean): Handler {
  const handlers = new Map<string, Handler>()
  const scope = {
    staffId: 'staff-1',
    activeOrg: 'o1',
    allowedVenueIds: ['v1'],
    perVenueAccess: new Map(),
    isSuperAdmin,
  } as McpScope
  registerLandingLeadTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as Handler) } as never, scope)
  return handlers.get('landing_leads')!
}

const fila = (utm: Record<string, string> | null, source = 'landing_restaurantes', email = 'a@b.com') => ({
  id: 'log-1',
  createdAt: new Date('2026-08-20T18:00:00.000Z'),
  data: { source, organizationId: 'org-1', ...(utm ? { utm } : {}) },
  staff: { firstName: 'Ana', lastName: 'Ruiz', email },
})

beforeEach(() => jest.clearAllMocks())

describe('landing_leads', () => {
  // 1. FEATURE NUEVO
  it('🔴 un scope NO superadmin no recibe nada y NO consulta la base', async () => {
    const out = parse(await registrar(false)({}, {}))
    expect(out.error).toMatch(/SUPERADMIN/)
    expect(out.leads).toBeUndefined()
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('superadmin: agrupa por campana y ordena por volumen', async () => {
    mockFindMany.mockResolvedValue([
      fila({ utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'Stories', utm_content: 'A' }),
      fila({ utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'Stories', utm_content: 'A' }),
      fila({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'Busqueda', utm_content: '' }),
    ])
    const out = parse(await registrar(true)({}, {}))
    expect(out.total).toBe(3)
    expect(out.porCampana[0]).toMatchObject({ utm_source: 'meta', utm_campaign: 'Stories', leads: 2 })
    expect(out.porCampana[1]).toMatchObject({ utm_source: 'google', leads: 1 })
  })

  it('solo lee el alta de landing, no el resto de la bitacora', async () => {
    mockFindMany.mockResolvedValue([])
    await registrar(true)({}, {})
    expect(mockFindMany.mock.calls[0][0].where).toMatchObject({ action: 'LANDING_SIGNUP_CREATED' })
  })

  it('un lead SIN utm cae en "(sin campana)" en vez de desaparecer — es el sintoma de un anuncio sin parametros', async () => {
    mockFindMany.mockResolvedValue([fila(null)])
    const out = parse(await registrar(true)({}, {}))
    expect(out.total).toBe(1)
    expect(out.porCampana[0]).toMatchObject({ utm_source: '(sin campana)', leads: 1 })
  })

  it('filtra por landing de origen', async () => {
    mockFindMany.mockResolvedValue([fila({ utm_source: 'meta' }, 'landing_restaurantes'), fila({ utm_source: 'meta' }, 'landing_retail')])
    const out = parse(await registrar(true)({ source: 'landing_retail' }, {}))
    expect(out.total).toBe(1)
    expect(out.leads[0].landing).toBe('landing_retail')
  })

  it('🔴 el rango de fechas se interpreta en hora de Mexico, no en la del host (produccion corre en UTC)', async () => {
    mockFindMany.mockResolvedValue([])
    await registrar(true)({ startDate: '2026-08-20', endDate: '2026-08-20' }, {})
    const { createdAt } = mockFindMany.mock.calls[0][0].where
    // Medianoche del 20-ago en Mexico (UTC-6) = 06:00Z del mismo dia.
    expect((createdAt.gte as Date).toISOString()).toBe('2026-08-20T06:00:00.000Z')
    expect((createdAt.lte as Date).toISOString()).toBe('2026-08-21T05:59:59.999Z')
  })

  it('`limit` acota la lista pero el resumen sigue contando todo', async () => {
    mockFindMany.mockResolvedValue([fila({ utm_source: 'meta' }), fila({ utm_source: 'meta' }), fila({ utm_source: 'meta' })])
    const out = parse(await registrar(true)({ limit: 1 }, {}))
    expect(out.leads).toHaveLength(1)
    expect(out.total).toBe(3)
    expect(out.porCampana[0].leads).toBe(3)
  })

  // 2. REGRESION / no romper lo de al lado
  it('sin filtro de fecha NO manda createdAt (no acota la consulta por accidente)', async () => {
    mockFindMany.mockResolvedValue([])
    await registrar(true)({}, {})
    expect(mockFindMany.mock.calls[0][0].where.createdAt).toBeUndefined()
  })

  it('devuelve el utm crudo del lead, sin perder llaves que no se agrupan (gclid/fbclid)', async () => {
    mockFindMany.mockResolvedValue([fila({ utm_source: 'meta', fbclid: 'IwAR123', utm_term: 'broad-mx' })])
    const out = parse(await registrar(true)({}, {}))
    expect(out.leads[0].utm).toMatchObject({ fbclid: 'IwAR123', utm_term: 'broad-mx' })
  })
})
