import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import {
  esPromotorDeCampo,
  sucursalesConCampo,
  sucursalesDeCampoDeLaPersona,
  sucursalesDeLaPersona,
} from '@/services/tpv/campo/celular/personasDeCampo'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findMany: jest.fn() }, staffVenue: { findMany: jest.fn() } },
}))
jest.mock('@/services/modules/module.service', () => ({
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
  moduleService: { isModuleEnabled: jest.fn(), venuesWithModule: jest.fn() },
}))
const db = prisma as any
const fila = (venueId: string, role: string) => ({ id: `sv-${venueId}`, venueId, role, pin: '1', venue: { name: venueId } })

/** El doble aplica el filtro de rol de la consulta, como Postgres (R3-5: el rol va en el `where`). */
const conRol =
  (filas: any[]) =>
  async ({ where }: any) =>
    filas.filter(f => !where.role || where.role.in.includes(f.role))

beforeEach(() => {
  jest.resetAllMocks()
  db.venue.findMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }])
  ;(moduleService.isModuleEnabled as jest.Mock).mockImplementation((id: string) => Promise.resolve(id === 'v1'))
  ;(moduleService.venuesWithModule as jest.Mock).mockImplementation(async (ids: string[]) => new Set(ids.filter(id => id === 'v1')))
})

it('sucursalesConCampo: sólo las que tienen el módulo, con UNA consulta de módulo para todas (S6)', async () => {
  expect(await sucursalesConCampo('o')).toEqual(['v1'])
  expect(moduleService.venuesWithModule).toHaveBeenCalledTimes(1)
  expect(moduleService.venuesWithModule).toHaveBeenCalledWith(['v1', 'v2'], 'SERIALIZED_INVENTORY')
  expect(moduleService.isModuleEnabled).not.toHaveBeenCalled()
})

describe('sucursalesDeCampoDeLaPersona (S13: activar y entrar)', () => {
  it('sólo las de rol de promotor y con el módulo', async () => {
    db.staffVenue.findMany.mockImplementation(conRol([fila('v1', 'CASHIER'), fila('v1b', 'MANAGER'), fila('v2', 'WAITER')]))
    ;(moduleService.venuesWithModule as jest.Mock).mockImplementation(async (ids: string[]) => new Set(ids.filter(id => id !== 'v2')))
    const r = await sucursalesDeCampoDeLaPersona('s', 'o')
    expect(r.map(x => x.venueId)).toEqual(['v1'])
    expect(moduleService.venuesWithModule).toHaveBeenCalledWith(['v1', 'v2'], 'SERIALIZED_INVENTORY')
  })
  it('sin ninguna de promotor no consulta el módulo', async () => {
    db.staffVenue.findMany.mockImplementation(conRol([fila('v1', 'MANAGER')]))
    expect(await sucursalesDeCampoDeLaPersona('s', 'o')).toEqual([])
    expect(moduleService.venuesWithModule).not.toHaveBeenCalled()
  })
})

it('sucursalesDeLaPersona filtra por persona activa, StaffVenue activo y sucursal operativa de la org', async () => {
  db.staffVenue.findMany.mockResolvedValue([fila('v1', 'WAITER')])
  const r = await sucursalesDeLaPersona('s', 'o')
  const where = db.staffVenue.findMany.mock.calls[0][0].where
  expect(where).toMatchObject({ staffId: 's', active: true, staff: { active: true }, venue: { organizationId: 'o' } })
  expect(where.venue.status.in).toEqual(expect.arrayContaining(['ACTIVE']))
  expect(where.venue.status.in).not.toContain('CLOSED')
  expect(r[0]).toEqual({ staffVenueId: 'sv-v1', venueId: 'v1', nombre: 'v1', role: 'WAITER', pin: '1' })
})

describe('esPromotorDeCampo (A8)', () => {
  it('WAITER/CASHIER en sucursal con módulo → sí', async () => {
    db.staffVenue.findMany.mockResolvedValue([fila('v1', 'CASHIER')])
    expect(await esPromotorDeCampo('s', 'o')).toBe(true)
  })
  it('rol de piso distinto (MANAGER) → no', async () => {
    db.staffVenue.findMany.mockImplementation(conRol([fila('v1', 'MANAGER')]))
    expect(await esPromotorDeCampo('s', 'o')).toBe(false)
  })
  it('WAITER en sucursal sin el módulo → no', async () => {
    db.staffVenue.findMany.mockResolvedValue([fila('v2', 'WAITER')])
    expect(await esPromotorDeCampo('s', 'o')).toBe(false)
  })
  it('sin sucursales → no', async () => {
    db.staffVenue.findMany.mockResolvedValue([])
    expect(await esPromotorDeCampo('s', 'o')).toBe(false)
  })
  it('con el conjunto precalculado no vuelve a consultar el módulo', async () => {
    db.staffVenue.findMany.mockResolvedValue([fila('v9', 'WAITER')])
    expect(await esPromotorDeCampo('s', 'o', new Set(['v9']))).toBe(true)
    expect(moduleService.isModuleEnabled).not.toHaveBeenCalled()
    expect(moduleService.venuesWithModule).not.toHaveBeenCalled()
  })
})

describe('R3-5 · ningún tope corta candidatos antes de filtrar', () => {
  it('sucursalesDeCampoDeLaPersona y esPromotorDeCampo piden el rol de campo EN la consulta (200 de gerente no tapan la de promotora)', async () => {
    db.staffVenue.findMany.mockResolvedValue([fila('v1', 'CASHIER')])
    await sucursalesDeCampoDeLaPersona('s', 'o')
    await esPromotorDeCampo('s', 'o', new Set(['v1']))
    for (const [args] of db.staffVenue.findMany.mock.calls) {
      expect(args.where).toMatchObject({ staffId: 's', active: true, staff: { active: true }, role: { in: ['WAITER', 'CASHIER'] } })
    }
  })

  it('sucursalesConCampo recorre TODAS las sucursales de la org en páginas de 2000 (la 2001 con el módulo sí sale)', async () => {
    const pagina1 = Array.from({ length: 2000 }, (_, i) => ({ id: `v${String(i).padStart(4, '0')}` }))
    db.venue.findMany.mockResolvedValueOnce(pagina1).mockResolvedValueOnce([{ id: 'vUltima' }])
    ;(moduleService.venuesWithModule as jest.Mock).mockImplementation(async (ids: string[]) => new Set(ids.filter(id => id === 'vUltima')))
    expect(await sucursalesConCampo('o')).toEqual(['vUltima'])
    const [p1, p2] = db.venue.findMany.mock.calls.map((c: any[]) => c[0])
    expect(p1).toMatchObject({ where: { organizationId: 'o' }, orderBy: { id: 'asc' }, take: 2000 })
    expect(p1.cursor).toBeUndefined()
    expect(p2).toMatchObject({ take: 2000, skip: 1, cursor: { id: 'v1999' } })
    expect(db.venue.findMany).toHaveBeenCalledTimes(2)
  })

  it('sucursalesDeLaPersona (la baja) recorre todas sus asignaciones en páginas, completa', async () => {
    const pagina1 = Array.from({ length: 200 }, (_, i) => fila(`m${i}`, 'MANAGER'))
    db.staffVenue.findMany.mockResolvedValueOnce(pagina1).mockResolvedValueOnce([fila('vTarde', 'CASHIER')])
    const r = await sucursalesDeLaPersona('s', 'o')
    expect(r).toHaveLength(201)
    expect(r[200].venueId).toBe('vTarde')
    const [, p2] = db.staffVenue.findMany.mock.calls.map((c: any[]) => c[0])
    expect(p2).toMatchObject({ take: 200, skip: 1, cursor: { id: 'sv-m199' } })
  })
})
