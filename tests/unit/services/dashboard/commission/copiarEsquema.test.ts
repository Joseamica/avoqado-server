/**
 * Copiar un esquema de comisión: el origen se busca con el filtro del negocio de quien pide (si no es suyo, 404) y el
 * nombre nuevo llega como cambio, no como texto suelto.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    commissionConfig: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    commissionTier: { createMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { NotFoundError } from '@/errors/AppError'
import { copyCommissionConfig } from '@/services/dashboard/commission/commission-config.service'
import { copyConfig } from '@/controllers/dashboard/commission.dashboard.controller'

const db = prisma as any

const fila = (o: any) => ({
  name: 'Meseros',
  description: null,
  priority: 0,
  recipient: 'SERVER',
  trigger: 'PER_PAYMENT',
  calcType: 'PERCENTAGE',
  defaultRate: 0.05,
  minAmount: null,
  maxAmount: null,
  includeTips: false,
  includeDiscount: true,
  includeTax: true,
  attendanceLinked: false,
  attendanceLatePenaltyRate: null,
  roleRates: null,
  filterByCategories: false,
  categoryIds: [],
  filterByStaff: false,
  staffIds: [],
  useGoalAsTier: false,
  goalBonusRate: null,
  deletedAt: null,
  tiers: [],
  ...o,
})
const TABLA = [
  fila({ id: 'mio', venueId: 'venue-A', orgId: 'org-A' }),
  fila({ id: 'ajeno', venueId: 'venue-B', orgId: 'org-B' }),
  fila({ id: 'org-propio', venueId: null, orgId: 'org-A', name: 'Del grupo' }),
  fila({ id: 'org-ajeno', venueId: null, orgId: 'org-B' }),
  fila({ id: 'borrado', venueId: 'venue-A', orgId: 'org-A', deletedAt: new Date() }),
]
const coincide = (r: any, w: any): boolean =>
  Object.entries(w).every(([k, v]: [string, any]) => (k === 'OR' ? v.some((x: any) => coincide(r, x)) : r[k] === v))

beforeEach(() => {
  jest.clearAllMocks()
  db.venue.findUnique.mockResolvedValue({ id: 'venue-A', organizationId: 'org-A' })
  db.commissionConfig.findFirst.mockImplementation(async (a: any) => TABLA.find(r => coincide(r, a.where)) ?? null)
  // Una consulta SIN filtro de negocio (la fuga) ve todo.
  db.commissionConfig.findUnique.mockImplementation(async (a: any) => TABLA.find(r => r.id === a.where.id) ?? null)
  db.commissionConfig.create.mockImplementation(async (a: any) => ({ id: 'copia', ...a.data }))
  db.$transaction.mockImplementation(async (f: any) => f(db))
})

describe('copyCommissionConfig', () => {
  it('🔴 copiar el esquema de OTRO negocio responde 404 y no crea nada', async () => {
    await expect(copyCommissionConfig('ajeno', 'venue-A', 'u1')).rejects.toBeInstanceOf(NotFoundError)
    await expect(copyCommissionConfig('org-ajeno', 'venue-A', 'u1')).rejects.toBeInstanceOf(NotFoundError)
    expect(db.commissionConfig.create).not.toHaveBeenCalled()
  })
  it('un esquema borrado tampoco se copia', async () => {
    await expect(copyCommissionConfig('borrado', 'venue-A', 'u1')).rejects.toBeInstanceOf(NotFoundError)
  })
  it('🔴 uno propio con nombre nuevo: la copia trae ese nombre y los datos del origen', async () => {
    const c = await copyCommissionConfig('mio', 'venue-A', 'u1', { name: 'Meseros 2' })
    const d = db.commissionConfig.create.mock.calls[0][0].data
    expect(d).toEqual(expect.objectContaining({ venueId: 'venue-A', name: 'Meseros 2', defaultRate: 0.05, includeTax: true, includeDiscount: true }))
    expect(c.name).toBe('Meseros 2')
  })
  it('regresión: sin nombre nuevo, "(Copy)"; y el esquema del grupo (organización propia) sí se hereda', async () => {
    await copyCommissionConfig('mio', 'venue-A', 'u1')
    expect(db.commissionConfig.create.mock.calls[0][0].data.name).toBe('Meseros (Copy)')
    await copyCommissionConfig('org-propio', 'venue-A', 'u1')
    expect(db.commissionConfig.create.mock.calls[1][0].data.name).toBe('Del grupo (Copy)')
  })
})

describe('controlador copyConfig', () => {
  const llamar = async (body: any) => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()
    await copyConfig({ params: { venueId: 'venue-A', configId: 'mio' }, body, authContext: { userId: 'u1' } } as any, res, next)
    return { res, next }
  }
  it('🔴 el nombre del cuerpo llega como cambio ({ name }), no como texto', async () => {
    const { res } = await llamar({ name: 'Nuevo' })
    expect(db.commissionConfig.create.mock.calls[0][0].data.name).toBe('Nuevo')
    expect(res.status).toHaveBeenCalledWith(201)
  })
  it('sin nombre en el cuerpo: "(Copy)"', async () => {
    await llamar({})
    expect(db.commissionConfig.create.mock.calls[0][0].data.name).toBe('Meseros (Copy)')
  })
})
