/**
 * La lista de la organización (App de campo, bloque 1, Tarea 8). Prisma va mockeado con datos en memoria que respetan
 * los filtros que el servicio manda (organización, sucursales, ids, nombre), para probar comportamiento y no sólo llamadas.
 */
import prisma from '@/utils/prismaClient'
import { sucursalesConCampo } from '@/services/tpv/campo/celular/personasDeCampo'
import { listarCelularesDeCampo } from '@/services/tpv/campo/celular/celularesDeLaOrganizacion.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findMany: jest.fn(), count: jest.fn() },
    celularDeCampo: { findMany: jest.fn() },
    codigoDeCelular: { findMany: jest.fn() },
    timeEntry: { findMany: jest.fn() },
    envioRetenidoDeCampo: { groupBy: jest.fn() },
  },
}))
jest.mock('@/services/tpv/campo/celular/personasDeCampo', () => ({
  filtroDePromotor: jest.requireActual('@/services/tpv/campo/celular/personasDeCampo').filtroDePromotor,
  sucursalesConCampo: jest.fn(),
}))

const db = prisma as any
const ORG = 'org1'
const AHORA = new Date('2026-11-09T12:00:00.000Z')
const hora = (h: number) => new Date(AHORA.getTime() + h * 3600_000)

const sv = (id: string, venueId: string, pin: string | null = '1234') => ({ id, venueId, pin, venue: { name: `Tienda ${venueId}` } })
// a: ACTIVO · b: código vivo · c: sin celular (y 4 más) · d: sin celular, otra sucursal
let personas: any[]
let celulares: any[]
let codigos: any[]
let checadas: any[]
let retenidos: any[]

beforeEach(() => {
  jest.resetAllMocks()
  jest.useFakeTimers().setSystemTime(AHORA)
  personas = [
    { id: 'a', firstName: 'Ana', lastName: 'Lopez', phone: '+521', venues: [sv('sva', 'v1'), sv('sva2', 'v2', null)] },
    { id: 'b', firstName: 'Beto', lastName: 'Ruiz', phone: null, venues: [sv('svb', 'v1')] },
    { id: 'c', firstName: 'Carla', lastName: 'Lopez Diaz', phone: '+523', venues: [sv('svc', 'v1')] },
    { id: 'd', firstName: 'Diego', lastName: 'Perez', phone: '+524', venues: [sv('svd', 'v2')] },
  ]
  celulares = [
    {
      id: 'cel-a',
      organizationId: ORG,
      staffId: 'a',
      staffIdVinculado: 'a',
      marca: 'Samsung',
      modelo: 'A15',
      versionApp: '1.0',
      createdAt: hora(-48),
      vistoAt: hora(-1),
      porSubir: 2,
    },
    // De OTRA organización: no debe hacer ACTIVO a nadie de ésta.
    {
      id: 'cel-x',
      organizationId: 'otra',
      staffId: 'c',
      staffIdVinculado: 'c',
      marca: 'X',
      modelo: 'Y',
      versionApp: '9',
      createdAt: hora(-5),
      vistoAt: null,
      porSubir: 0,
    },
    // Desvinculado: no cuenta.
    {
      id: 'cel-old',
      organizationId: ORG,
      staffId: 'd',
      staffIdVinculado: null,
      marca: 'Z',
      modelo: 'Z',
      versionApp: '1',
      createdAt: hora(-90),
      vistoAt: null,
      porSubir: 0,
    },
  ]
  codigos = [
    { organizationId: ORG, staffId: 'b', codigo: 'ABC234', expiraAt: hora(24), usadoAt: null, anuladoAt: null },
    { organizationId: ORG, staffId: 'c', codigo: 'VENCID', expiraAt: hora(-1), usadoAt: null, anuladoAt: null },
    { organizationId: ORG, staffId: 'd', codigo: 'USADO2', expiraAt: hora(24), usadoAt: hora(-2), anuladoAt: null },
  ]
  checadas = [
    { staffId: 'a', venueId: 'v1', clockInTime: hora(-3), clockInLatitude: 19.4 },
    { staffId: 'a', venueId: 'v2', clockInTime: hora(-30), clockInLatitude: null },
    { staffId: 'b', venueId: 'v1', clockInTime: hora(-10), clockInLatitude: null },
  ]
  retenidos = [
    { staffId: 'a', estado: 'PENDIENTE' },
    { staffId: 'a', estado: 'APLICANDO' },
    { staffId: 'a', estado: 'APLICADO' },
    { staffId: 'b', estado: 'DESCARTADO' },
  ]
  ;(sucursalesConCampo as jest.Mock).mockResolvedValue(['v1', 'v2'])

  const palabras = (where: any): string[] =>
    (where?.AND ?? []).flatMap((x: any) => (x.AND ?? []).map((w: any) => w.OR[0].firstName.contains.toLowerCase()))
  db.staff.findMany.mockImplementation(({ where, skip, take }: any) => {
    const sucs: string[] = where.venues.some.venueId.in
    let r = personas.filter(p => p.venues.some((v: any) => sucs.includes(v.venueId)))
    if (where.id?.in) r = r.filter(p => where.id.in.includes(p.id))
    for (const w of palabras(where)) r = r.filter(p => `${p.firstName} ${p.lastName}`.toLowerCase().includes(w))
    r = [...r].sort((x, y) => x.firstName.localeCompare(y.firstName) || x.id.localeCompare(y.id))
    if (take === undefined) return Promise.resolve(r.map(p => ({ id: p.id })))
    return Promise.resolve(r.slice(skip, skip + take).map(p => ({ ...p, venues: p.venues.filter((v: any) => sucs.includes(v.venueId)) })))
  })
  db.staff.count.mockImplementation(async (a: any) => (await db.staff.findMany({ where: a.where })).length)
  db.celularDeCampo.findMany.mockImplementation(({ where }: any) =>
    Promise.resolve(
      celulares.filter(
        c =>
          c.organizationId === where.organizationId &&
          c.staffIdVinculado !== null &&
          (!where.staffIdVinculado?.in || where.staffIdVinculado.in.includes(c.staffIdVinculado)),
      ),
    ),
  )
  db.codigoDeCelular.findMany.mockImplementation(({ where }: any) =>
    Promise.resolve(
      codigos.filter(
        c => c.organizationId === where.organizationId && c.usadoAt === null && c.anuladoAt === null && c.expiraAt > where.expiraAt.gt,
      ),
    ),
  )
  db.timeEntry.findMany.mockImplementation(({ where }: any) =>
    Promise.resolve(
      checadas
        .filter(t => where.staffId.in.includes(t.staffId) && t.clockInTime >= where.clockInTime.gte)
        .sort((x, y) => y.clockInTime.getTime() - x.clockInTime.getTime()),
    ),
  )
  db.envioRetenidoDeCampo.groupBy.mockImplementation(({ where }: any) => {
    const cuenta = new Map<string, number>()
    for (const r of retenidos) {
      if (where.staffId.in.includes(r.staffId) && where.estado.in.includes(r.estado))
        cuenta.set(r.staffId, (cuenta.get(r.staffId) ?? 0) + 1)
    }
    return Promise.resolve([...cuenta].map(([staffId, n]) => ({ staffId, _count: { _all: n } })))
  })
})
afterEach(() => jest.useRealTimers())

const base = { page: 1, pageSize: 50 }

describe('listarCelularesDeCampo', () => {
  it('sin ninguna sucursal con el módulo: disponible false y lista vacía', async () => {
    ;(sucursalesConCampo as jest.Mock).mockResolvedValue([])
    const r = await listarCelularesDeCampo(ORG, base)
    expect(r).toEqual({ disponible: false, items: [], total: 0, conteos: { SIN_CELULAR: 0, CODIGO_SIN_USAR: 0, ACTIVO: 0 }, porRevisar: 0 })
    expect(db.staff.findMany).not.toHaveBeenCalled()
  })

  it('los tres estados y sus conteos; el celular de otra organización y el código vencido o usado no cuentan', async () => {
    const r = await listarCelularesDeCampo(ORG, base)
    expect(r.disponible).toBe(true)
    expect(Object.fromEntries(r.items.map(i => [i.staffId, i.estado]))).toEqual({
      a: 'ACTIVO',
      b: 'CODIGO_SIN_USAR',
      c: 'SIN_CELULAR',
      d: 'SIN_CELULAR',
    })
    expect(r.conteos).toEqual({ ACTIVO: 1, CODIGO_SIN_USAR: 1, SIN_CELULAR: 2 })
    expect(r.total).toBe(4)
  })

  it('arma la fila: sucursales con tienePin, código, celular, última checada y por revisar', async () => {
    const r = await listarCelularesDeCampo(ORG, base)
    const a = r.items.find(i => i.staffId === 'a')!
    expect(a).toEqual({
      staffId: 'a',
      nombre: 'Ana Lopez',
      telefono: '+521',
      sucursales: [
        { venueId: 'v1', staffVenueId: 'sva', nombre: 'Tienda v1', tienePin: true },
        { venueId: 'v2', staffVenueId: 'sva2', nombre: 'Tienda v2', tienePin: false },
      ],
      estado: 'ACTIVO',
      codigo: null,
      celular: {
        id: 'cel-a',
        marca: 'Samsung',
        modelo: 'A15',
        versionApp: '1.0',
        activadoAt: hora(-48).toISOString(),
        vistoAt: hora(-1).toISOString(),
        porSubir: 2,
      },
      ultimaChecada: { at: hora(-3).toISOString(), conUbicacion: true, venueId: 'v1' },
      porRevisar: 2, // PENDIENTE + APLICANDO; el APLICADO no cuenta
    })
    const b = r.items.find(i => i.staffId === 'b')!
    expect(b.codigo).toEqual({ codigo: 'ABC234', expiraAt: hora(24).toISOString() })
    expect(b.ultimaChecada).toEqual({ at: hora(-10).toISOString(), conUbicacion: false, venueId: 'v1' })
    expect(b.porRevisar).toBe(0) // DESCARTADO no cuenta
    expect(r.items.find(i => i.staffId === 'c')!.ultimaChecada).toBeNull()
    expect(r.porRevisar).toBe(2)
  })

  it('nunca devuelve el PIN', async () => {
    const r = await listarCelularesDeCampo(ORG, base)
    expect(JSON.stringify(r)).not.toContain('1234')
    expect(JSON.stringify(r)).not.toMatch(/"pin"/)
  })

  it('filtro estado: sólo ese estado, total del filtro y conteos de los tres', async () => {
    const r = await listarCelularesDeCampo(ORG, { ...base, estado: 'SIN_CELULAR' })
    expect(r.items.map(i => i.staffId)).toEqual(['c', 'd'])
    expect(r.total).toBe(2)
    expect(r.conteos).toEqual({ ACTIVO: 1, CODIGO_SIN_USAR: 1, SIN_CELULAR: 2 })
  })

  it('filtro venueId: sólo los promotores de esa sucursal; conteos y por revisar respetan la sucursal, no el estado', async () => {
    const r = await listarCelularesDeCampo(ORG, { ...base, venueId: 'v2', estado: 'ACTIVO' })
    // En v2: a (ACTIVO) y d (SIN_CELULAR).
    expect(r.items.map(i => i.staffId)).toEqual(['a'])
    expect(r.items[0].sucursales.map(s => s.venueId)).toEqual(['v2'])
    expect(r.conteos).toEqual({ ACTIVO: 1, CODIGO_SIN_USAR: 0, SIN_CELULAR: 1 })
    expect(r.porRevisar).toBe(2)
    const sinA = await listarCelularesDeCampo(ORG, { ...base, venueId: 'v1' })
    expect(sinA.conteos).toEqual({ ACTIVO: 1, CODIGO_SIN_USAR: 1, SIN_CELULAR: 1 })
  })

  it('una sucursal que no es de campo: lista vacía pero disponible', async () => {
    const r = await listarCelularesDeCampo(ORG, { ...base, venueId: 'otra-tienda' })
    expect(r.disponible).toBe(true)
    expect(r.items).toEqual([])
    expect(r.total).toBe(0)
  })

  it('q busca por nombre y no cambia los conteos', async () => {
    const r = await listarCelularesDeCampo(ORG, { ...base, q: 'lopez' })
    expect(r.items.map(i => i.staffId)).toEqual(['a', 'c'])
    expect(r.total).toBe(2)
    expect(r.conteos.ACTIVO + r.conteos.CODIGO_SIN_USAR + r.conteos.SIN_CELULAR).toBe(4)
  })

  it('dos páginas: sin repetir ni perder a nadie, con total, en orden estable', async () => {
    const p1 = await listarCelularesDeCampo(ORG, { page: 1, pageSize: 3 })
    const p2 = await listarCelularesDeCampo(ORG, { page: 2, pageSize: 3 })
    expect(p1.items.map(i => i.staffId)).toEqual(['a', 'b', 'c'])
    expect(p2.items.map(i => i.staffId)).toEqual(['d'])
    expect(p1.total).toBe(4)
    expect(p2.total).toBe(4)
    const order = db.staff.findMany.mock.calls.map((c: any) => c[0]).find((a: any) => a.take === 3).orderBy
    expect(order).toEqual([{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }])
  })

  it('sin N+1: una consulta de checadas y una de retenidos por página, acotadas a la página y a 48 h', async () => {
    await listarCelularesDeCampo(ORG, { page: 1, pageSize: 2 })
    expect(db.timeEntry.findMany).toHaveBeenCalledTimes(1)
    const w = db.timeEntry.findMany.mock.calls[0][0].where
    expect(w.staffId.in).toEqual(['a', 'b'])
    expect(w.clockInTime.gte).toEqual(hora(-48))
    expect(db.envioRetenidoDeCampo.groupBy).toHaveBeenCalledTimes(1)
  })
})
