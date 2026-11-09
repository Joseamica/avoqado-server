/**
 * Códigos por persona (App de campo, bloque 1, Tarea 2). Prisma y los ayudantes de personas van mockeados.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { esPromotorDeCampo, sucursalesConCampo, sucursalesDeLaPersona } from '@/services/tpv/campo/celular/personasDeCampo'
import { generarCodigos, INTENTOS_DEL_CODIGO, VIGENCIA_DEL_CODIGO_MS } from '@/services/tpv/campo/celular/codigoDeCelular.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn(), findMany: jest.fn() },
    codigoDeCelular: { upsert: jest.fn(), findMany: jest.fn() },
    celularDeCampo: { findMany: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/personasDeCampo', () => ({
  filtroDePromotor: jest.requireActual('@/services/tpv/campo/celular/personasDeCampo').filtroDePromotor,
  esPromotorDeCampo: jest.fn(),
  sucursalesConCampo: jest.fn(),
  sucursalesDeLaPersona: jest.fn(),
}))

const db = prisma as any
const ORG = 'org1'
const AHORA = new Date('2026-11-09T12:00:00.000Z')
const persona = (id: string) => ({ id, firstName: `N${id}`, lastName: 'Apellido', phone: `+52${id}`, active: true })
const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['codigo'] },
  })

beforeEach(() => {
  jest.resetAllMocks()
  jest.useFakeTimers().setSystemTime(AHORA)
  ;(logAction as jest.Mock).mockResolvedValue(undefined)
  ;(esPromotorDeCampo as jest.Mock).mockResolvedValue(true)
  ;(sucursalesConCampo as jest.Mock).mockResolvedValue(['v1'])
  ;(sucursalesDeLaPersona as jest.Mock).mockResolvedValue([
    { staffVenueId: 'sv', venueId: 'v1', nombre: 'Tienda', role: 'WAITER', pin: '1234' },
  ])
  db.staff.findUnique.mockImplementation(({ where }: any) => Promise.resolve(persona(where.id)))
  db.codigoDeCelular.upsert.mockImplementation(({ create }: any) => Promise.resolve(create))
})
afterEach(() => jest.useRealTimers())

describe('generarCodigos · staffIds', () => {
  it('genera código de 6 caracteres del alfabeto, 7 días exactos, intentos 0 y limpia el estado', async () => {
    const r = await generarCodigos({ organizationId: ORG, generadoPor: 'admin', staffIds: ['a'] })
    const arg = db.codigoDeCelular.upsert.mock.calls[0][0]
    expect(arg.where).toEqual({ organizationId_staffId: { organizationId: ORG, staffId: 'a' } })
    for (const d of [arg.create, arg.update]) {
      expect(d.codigo).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
      expect(d.expiraAt.getTime()).toBe(AHORA.getTime() + VIGENCIA_DEL_CODIGO_MS)
      expect(d.intentos).toBe(0)
      expect(d.generadoPor).toBe('admin')
    }
    expect(arg.update).toMatchObject({ usadoAt: null, usadoPorAparatoId: null, anuladoAt: null })
    expect(INTENTOS_DEL_CODIGO).toBe(5)
    expect(r.generados).toEqual([
      { staffId: 'a', nombre: 'Na Apellido', telefono: '+52a', codigo: arg.create.codigo, expiraAt: '2026-11-16T12:00:00.000Z' },
    ])
    expect(r.omitidos).toEqual([])
    expect(r.restantes).toBe(0)
  })

  it('un no promotor sale en omitidos y no se le genera nada', async () => {
    ;(esPromotorDeCampo as jest.Mock).mockImplementation((id: string) => Promise.resolve(id !== 'x'))
    const r = await generarCodigos({ organizationId: ORG, generadoPor: 'admin', staffIds: ['x', 'a'] })
    expect(r.omitidos).toEqual([{ staffId: 'x', motivo: 'NO_ES_PROMOTOR' }])
    expect(r.generados.map(g => g.staffId)).toEqual(['a'])
    expect(db.codigoDeCelular.upsert).toHaveBeenCalledTimes(1)
  })

  it('ids repetidos: un solo código y se calcula el módulo una vez', async () => {
    const r = await generarCodigos({ organizationId: ORG, generadoPor: 'admin', staffIds: ['a', 'a', 'b'] })
    expect(r.generados.map(g => g.staffId)).toEqual(['a', 'b'])
    expect(db.codigoDeCelular.upsert).toHaveBeenCalledTimes(2)
    expect(sucursalesConCampo).toHaveBeenCalledTimes(1)
  })

  it('un choque del único de codigo (P2002) se reintenta y luego sale bien', async () => {
    db.codigoDeCelular.upsert.mockRejectedValueOnce(p2002()).mockRejectedValueOnce(p2002())
    const r = await generarCodigos({ organizationId: ORG, generadoPor: 'admin', staffIds: ['a'] })
    expect(db.codigoDeCelular.upsert).toHaveBeenCalledTimes(3)
    expect(r.generados).toHaveLength(1)
  })

  it('tras 3 choques seguidos deja de reintentar y falla', async () => {
    db.codigoDeCelular.upsert.mockRejectedValue(p2002())
    await expect(generarCodigos({ organizationId: ORG, generadoPor: 'admin', staffIds: ['a'] })).rejects.toBeDefined()
    expect(db.codigoDeCelular.upsert).toHaveBeenCalledTimes(3)
  })

  it('la bitácora no lleva el código', async () => {
    const r = await generarCodigos({ organizationId: ORG, generadoPor: 'admin', staffIds: ['a'] })
    expect(logAction).toHaveBeenCalledTimes(1)
    const p = (logAction as jest.Mock).mock.calls[0][0]
    expect(p).toMatchObject({
      staffId: 'admin',
      venueId: 'v1',
      organizationId: ORG,
      action: 'CAMPO_CODIGO_GENERADO',
      entity: 'Staff',
      entityId: 'a',
      data: { expiraAt: '2026-11-16T12:00:00.000Z' },
    })
    expect(JSON.stringify(p)).not.toContain(r.generados[0].codigo)
  })
})

describe('generarCodigos · todosLosSinCelular', () => {
  beforeEach(() => {
    db.staff.findMany.mockResolvedValue(['a', 'b', 'c', 'd'].map(persona))
    db.celularDeCampo.findMany.mockResolvedValue([{ staffId: 'a' }]) // vinculado
    db.codigoDeCelular.findMany.mockResolvedValue([{ staffId: 'b' }]) // código vivo (la consulta ya excluye vencidos)
  })

  it('salta al vinculado y al del código vivo, e incluye al de código vencido', async () => {
    const r = await generarCodigos({ organizationId: ORG, generadoPor: 'admin', todosLosSinCelular: true })
    expect(r.generados.map(g => g.staffId)).toEqual(['c', 'd'])
    expect(r.restantes).toBe(0)
    const some = db.staff.findMany.mock.calls[0][0].where.venues.some
    expect(some.venue).toEqual({ status: { in: expect.arrayContaining(['ACTIVE']) } })
    expect(some).toMatchObject({ active: true, role: { in: ['WAITER', 'CASHIER'] }, venueId: { in: ['v1'] } })
    const filtro = db.codigoDeCelular.findMany.mock.calls[0][0].where
    expect(filtro).toMatchObject({ organizationId: ORG, usadoAt: null, anuladoAt: null, expiraAt: { gt: AHORA } })
  })

  it('con venueId: sólo promotores de esa sucursal de campo; si no es de campo, 0', async () => {
    ;(sucursalesConCampo as jest.Mock).mockResolvedValue(['v1', 'v2'])
    await generarCodigos({ organizationId: ORG, generadoPor: 'admin', todosLosSinCelular: true, venueId: 'v2' })
    expect(db.staff.findMany.mock.calls[0][0].where.venues.some.venueId).toEqual({ in: ['v2'] })

    db.staff.findMany.mockClear()
    db.codigoDeCelular.upsert.mockClear()
    const r = await generarCodigos({ organizationId: ORG, generadoPor: 'admin', todosLosSinCelular: true, venueId: 'otra' })
    expect(r.generados).toEqual([])
    expect(db.staff.findMany).not.toHaveBeenCalled()
    expect(db.codigoDeCelular.upsert).not.toHaveBeenCalled()
  })

  it('hasta 200 por llamada y dice cuántos restan', async () => {
    db.staff.findMany.mockResolvedValue(Array.from({ length: 250 }, (_, i) => persona(`s${String(i).padStart(3, '0')}`)))
    db.celularDeCampo.findMany.mockResolvedValue([])
    db.codigoDeCelular.findMany.mockResolvedValue([])
    const r = await generarCodigos({ organizationId: ORG, generadoPor: 'admin', todosLosSinCelular: true })
    expect(r.generados).toHaveLength(200)
    expect(r.restantes).toBe(50)
  })
})

describe('generarCodigos · alcance y tope (S3, S6)', () => {
  it('S3 · staffIds con alcance: el promotor se mide sólo contra las sucursales de campo del alcance', async () => {
    ;(sucursalesConCampo as jest.Mock).mockResolvedValue(['v1', 'v2'])
    await generarCodigos({ organizationId: ORG, generadoPor: 'sup', staffIds: ['a'], venueIds: ['v2', 'vFuera'] })
    expect((esPromotorDeCampo as jest.Mock).mock.calls[0][2]).toEqual(new Set(['v2']))
  })

  it('S3 · todosLosSinCelular con alcance: sólo sus sucursales; fuera del alcance, nada', async () => {
    ;(sucursalesConCampo as jest.Mock).mockResolvedValue(['v1', 'v2'])
    db.staff.findMany.mockResolvedValue([])
    db.celularDeCampo.findMany.mockResolvedValue([])
    db.codigoDeCelular.findMany.mockResolvedValue([])
    await generarCodigos({ organizationId: ORG, generadoPor: 'sup', todosLosSinCelular: true, venueIds: ['v1'] })
    expect(db.staff.findMany.mock.calls[0][0].where.venues.some.venueId).toEqual({ in: ['v1'] })
    db.staff.findMany.mockClear()
    const r = await generarCodigos({ organizationId: ORG, generadoPor: 'sup', todosLosSinCelular: true, venueId: 'v2', venueIds: ['v1'] })
    expect(r.generados).toEqual([])
    expect(db.staff.findMany).not.toHaveBeenCalled()
  })

  it('S6 · las tres consultas de candidatos tienen tope (10 000)', async () => {
    db.staff.findMany.mockResolvedValue([])
    db.celularDeCampo.findMany.mockResolvedValue([])
    db.codigoDeCelular.findMany.mockResolvedValue([])
    await generarCodigos({ organizationId: ORG, generadoPor: 'sup', todosLosSinCelular: true })
    expect(db.staff.findMany.mock.calls[0][0].take).toBe(10_000)
    expect(db.celularDeCampo.findMany.mock.calls[0][0].take).toBe(10_000)
    expect(db.codigoDeCelular.findMany.mock.calls[0][0].take).toBe(10_000)
  })
})
