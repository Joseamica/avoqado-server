/**
 * POST /mobile/venues/:venueId/payments/:paymentId/refund — devolver con «Efectivo de la caja» pide
 * `payments:refund-to-cash` EN LUGAR de `payments:refund` (founder, 1-oct-2026; la dependencia refund-to-cash → refund
 * deja la autorización equivalente).
 *
 * 🔴 UNA sola revisión por petición: el código del encargado (`x-permission-override`) es de un solo uso y de UN permiso.
 * Con dos revisiones encadenadas, un mesero que escogía efectivo gastaba el código en `payments:refund` y la segunda
 * lo rechazaba — callejón sin salida y una bitácora `PERMISSION_OVERRIDE_USED` falsa.
 *
 * Corre el `checkPermission` REAL con los permisos de fábrica (sólo la base va simulada).
 */
const mockStaffVenueFindUnique = jest.fn()
const mockConsumeOverride = jest.fn()
/** Máquina de efectivo (Codex r1 #14): el cobro que se devuelve; con folio, es una venta de la QuickPay. */
const mockPaymentFindFirst = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: async () => ({ active: true }) },
    staffVenue: { findFirst: async () => null, findUnique: (...a: unknown[]) => mockStaffVenueFindUnique(...a) },
    venue: { findUnique: async () => null },
    // Con una fila menor que OWNER, el resolutor pregunta en UNA consulta si es dueña de la org del venue (P2-6).
    staffOrganization: { findUnique: async () => null, findFirst: async () => null },
    venueRolePermission: { findUnique: async () => null },
    payment: { findFirst: (...a: unknown[]) => mockPaymentFindFirst(...a) },
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  ...jest.requireActual('@/services/dashboard/activity-log.service'),
  logAction: jest.fn(),
}))
jest.mock('@/services/mobile/permission-override.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/permission-override.mobile.service'),
  consumePermissionOverride: (...a: unknown[]) => mockConsumeOverride(...a),
  isManagerPinOverrideEnabled: async () => true,
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { StaffRole } from '@prisma/client'
import mobileRouter, { permisoDeReembolso } from '@/routes/mobile.routes'
import dashboardRouter from '@/routes/dashboard.routes'
import tpvRouter from '@/routes/tpv.routes'

async function correr(role: StaffRole, body: unknown, headers: Record<string, string> = {}, permiso: any = permisoDeReembolso) {
  mockStaffVenueFindUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
  const req: any = {
    method: 'POST',
    originalUrl: '/api/v1/mobile/venues/v1/payments/p1/refund',
    params: { venueId: 'v1', paymentId: 'p1' },
    headers,
    body,
    authContext: { userId: 'u1', venueId: 'v1', role },
  }
  const out: { status?: number; json?: any; next: boolean } = { next: false }
  const res: any = {
    status: (s: number) => ((out.status = s), res),
    json: (j: unknown) => ((out.json = j), res),
  }
  await permiso(req, res, () => {
    out.next = true
  })
  return out
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: null })
})

describe('el reembolso móvil revisa UN permiso según «Devolver con»', () => {
  it('🔴 CASHIER con refundMethod CASH ⇒ 403 con el permiso nuevo (overridable por el código del encargado)', async () => {
    const out = await correr(StaffRole.CASHIER, { amount: 5000, refundMethod: 'CASH' })
    expect(out.next).toBe(false)
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'payments:refund-to-cash', overridable: true })
  })

  it('🔴 WAITER (sin payments:refund) + CASH + código del encargado para refund-to-cash ⇒ pasa con UN solo consumo', async () => {
    mockConsumeOverride.mockResolvedValue({ authorizedById: 'sv-gerente' })
    const out = await correr(StaffRole.WAITER, { refundMethod: 'CASH' }, { 'x-permission-override': 'tok' })
    expect(out.next).toBe(true)
    expect(mockConsumeOverride).toHaveBeenCalledTimes(1)
    expect(mockConsumeOverride).toHaveBeenCalledWith(expect.objectContaining({ permission: 'payments:refund-to-cash', venueId: 'v1' }))
  })

  it('CASHIER con transferencia ⇒ pasa por payments:refund', async () => {
    expect(await correr(StaffRole.CASHIER, { amount: 5000, refundMethod: 'BANK_TRANSFER' })).toEqual({ next: true })
  })

  it('sin efectivo la revisión es payments:refund: el WAITER recibe ESE 403', async () => {
    const out = await correr(StaffRole.WAITER, { refundMethod: 'BANK_TRANSFER' })
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'payments:refund' })
  })

  it('CASHIER sin refundMethod («por el mismo medio») ⇒ pasa', async () => {
    expect(await correr(StaffRole.CASHIER, { amount: 5000 })).toEqual({ next: true })
    expect(await correr(StaffRole.CASHIER, undefined)).toEqual({ next: true })
  })

  it('MANAGER con refundMethod CASH ⇒ pasa', async () => {
    expect(await correr(StaffRole.MANAGER, { amount: 5000, refundMethod: 'CASH' })).toEqual({ next: true })
  })

  it('🔴 saldo a favor (STORE_CREDIT) pide payments:refund, no payments:refund-to-cash: el CASHIER pasa y el WAITER recibe ESE 403', async () => {
    expect(await correr(StaffRole.CASHIER, { amount: 5000, refundMethod: 'STORE_CREDIT', customerId: 'c1' })).toEqual({ next: true })
    const out = await correr(StaffRole.WAITER, { amount: 5000, refundMethod: 'STORE_CREDIT', customerId: 'c1' })
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'payments:refund' })
  })

  it('la ruta tiene UNA sola revisión de permiso, justo antes del controlador', () => {
    const capa = (mobileRouter as any).stack.find(
      (l: any) => l.route?.path === '/venues/:venueId/payments/:paymentId/refund' && l.route.methods.post,
    )
    const handlers = capa.route.stack.map((rl: any) => rl.handle)
    const conPermiso = handlers.filter((h: any) => typeof h.requiredPermission === 'string')
    expect(conPermiso).toEqual([permisoDeReembolso])
    expect((permisoDeReembolso as any).requiredPermission).toBe('payments:refund')
    expect(handlers.indexOf(permisoDeReembolso)).toBe(handlers.length - 2)
  })
})

describe('Codex r1 #14 (decisión c): devolver en efectivo una venta de la máquina pide payments:refund-to-cash', () => {
  const permisoDe = (router: any, ruta: string) => {
    const capa = router.stack.find((l: any) => l.route?.path === ruta && l.route.methods.post)
    return capa.route.stack.map((rl: any) => rl.handle).find((h: any) => typeof h.requiredPermission === 'string')
  }
  const PANEL = () => permisoDe(dashboardRouter, '/venues/:venueId/payments/:paymentId/refund')
  const TERMINAL = () => permisoDe(tpvRouter, '/venues/:venueId/refunds')

  beforeEach(() => mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: 'AQ0123456789AB' }))

  it.each([
    ['sin refundMethod («por el mismo medio»)', { amount: 5000 }],
    ['con refundMethod CASH', { amount: 5000, refundMethod: 'CASH' }],
  ])('🔴 POS · CASHIER %s ⇒ 403 refund-to-cash (overridable)', async (_n, body) => {
    const out = await correr(StaffRole.CASHIER, body)
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'payments:refund-to-cash', overridable: true })
  })

  it('el cobro se busca en ESTA sucursal', async () => {
    await correr(StaffRole.CASHIER, { amount: 5000 })
    expect(mockPaymentFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p1', venueId: 'v1' } }))
  })

  it('POS · por transferencia o a saldo a favor no sale de la gaveta: payments:refund (el CASHIER pasa)', async () => {
    expect(await correr(StaffRole.CASHIER, { refundMethod: 'BANK_TRANSFER' })).toEqual({ next: true })
    expect(await correr(StaffRole.CASHIER, { refundMethod: 'STORE_CREDIT', customerId: 'c1' })).toEqual({ next: true })
  })

  it('POS · MANAGER (tiene refund-to-cash) pasa con las dos formas', async () => {
    expect(await correr(StaffRole.MANAGER, { amount: 5000 })).toEqual({ next: true })
    expect(await correr(StaffRole.MANAGER, { amount: 5000, refundMethod: 'CASH' })).toEqual({ next: true })
  })

  it('🔴 POS · si no se puede leer el cobro, se exige el permiso más alto (nunca se concede por el fallo)', async () => {
    mockPaymentFindFirst.mockRejectedValue(new Error('db caída'))
    const out = await correr(StaffRole.CASHIER, { amount: 5000 })
    expect(out.json).toMatchObject({ required: 'payments:refund-to-cash' })
  })

  it.each([
    ['sin refundMethod', { amount: 50 }],
    ['con refundMethod CASH', { amount: 50, refundMethod: 'CASH' }],
  ])('🔴 PANEL · CASHIER %s sobre una venta de la máquina ⇒ 403 refund-to-cash', async (_n, body) => {
    const out = await correr(StaffRole.CASHIER, body, {}, PANEL())
    expect(out.json).toMatchObject({ required: 'payments:refund-to-cash' })
  })

  it('PANEL · una venta que NO es de la máquina sigue como siempre (payments:refund)', async () => {
    mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: null })
    expect(await correr(StaffRole.CASHIER, { amount: 50 }, {}, PANEL())).toEqual({ next: true })
  })

  it('🔴 TERMINAL · el cobro viene en el cuerpo (originalPaymentId): una venta de la máquina pide refund-to-cash', async () => {
    const out = await correr(StaffRole.CASHIER, { originalPaymentId: 'p1', amount: 50 }, {}, TERMINAL())
    expect(out.json).toMatchObject({ required: 'payments:refund-to-cash' })
    mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: null })
    expect(await correr(StaffRole.CASHIER, { originalPaymentId: 'p1', amount: 50 }, {}, TERMINAL())).toEqual({ next: true })
  })
})
