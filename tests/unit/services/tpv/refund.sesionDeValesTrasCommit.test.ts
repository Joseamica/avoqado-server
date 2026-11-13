/**
 * D649 segunda vuelta (Codex apps-viejas r4): si al reabrir el saldo la sesión de vales estaba tomada por otra caja, la terminal
 * (`recordRefund`) la sube DESPUÉS de su commit. Sin esto, si la otra caja revertía, nadie subía la versión y el POS seguía
 * proponiendo «Cobrar saldo» por lo de antes. La subida real (contra Postgres) la prueba `abonoDevueltoVuelveADeberse`.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashRefundToDrawer: jest.fn().mockResolvedValue('POSTED') }))
jest.mock('@/services/shared/saldoReabiertoAlReembolsar', () => ({
  ...jest.requireActual('@/services/shared/saldoReabiertoAlReembolsar'),
  fijarSaldoReabiertoEnTx: jest.fn(),
  subirVersionDeValesTrasCommit: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
import { fijarSaldoReabiertoEnTx, subirVersionDeValesTrasCommit } from '@/services/shared/saldoReabiertoAlReembolsar'
import * as refundService from '@/services/tpv/refund.tpv.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

function armar() {
  const original = {
    id: 'pay-orig',
    venueId: VENUE,
    orderId: 'order-1',
    method: 'CASH',
    fundsFlow: 'CASH_DRAWER',
    amount: 50,
    tipAmount: 0,
    status: 'COMPLETED',
    type: 'REGULAR',
    processorData: {},
    source: 'TPV',
    terminalId: null,
    merchantAccountId: null,
    tenderTypeId: null,
    processedById: 'staff-1',
  }
  ;(prismaMock as any).payment = {
    findUnique: jest.fn().mockResolvedValue(original),
    findFirst: jest.fn().mockResolvedValue(original),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'pay-refund', ...a.data })),
    update: jest.fn().mockResolvedValue(original),
    findUniqueOrThrow: jest.fn().mockResolvedValue({ ...original, id: 'pay-refund' }),
  }
  ;(prismaMock as any).order = {
    findUnique: jest.fn().mockResolvedValue({ id: 'order-1', venueId: VENUE }),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
  }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock as any).$queryRaw = jest.fn(async (sql: unknown) =>
    Array.isArray(sql) && sql.join('').includes('ancestors(id) AS') ? [{ id: original.orderId }] : [original],
  )
}

const cuerpo = {
  venueId: VENUE,
  originalPaymentId: 'pay-orig',
  amount: 5000,
  reason: 'cliente',
  staffId: 'staff-1',
  authorizationNumber: '123456',
  referenceNumber: 'ref-1',
  isPartialRefund: false,
  currency: 'MXN',
}

const reabre = (extra: object) => ({
  reabre: true,
  reopenedAmount: new Prisma.Decimal(50),
  reopenedTipAmount: new Prisma.Decimal(0),
  ...extra,
})

beforeEach(() => jest.clearAllMocks())

describe('recordRefund · la sesión de vales tomada se sube tras el commit (D649 segunda vuelta)', () => {
  it('🔴 la sesión estaba tomada por otra caja: la sube después del commit', async () => {
    armar()
    ;(fijarSaldoReabiertoEnTx as jest.Mock).mockResolvedValue(reabre({ sesionDeValesOcupada: 'ses-1' }))

    await refundService.recordRefund(VENUE, cuerpo, 'staff-1').catch(() => {})

    expect(fijarSaldoReabiertoEnTx).toHaveBeenCalled()
    expect(subirVersionDeValesTrasCommit).toHaveBeenCalledWith({ venueId: VENUE, sessionId: 'ses-1' })
  })

  it('la sesión se subió dentro de la transacción (o no hay): no la vuelve a subir', async () => {
    armar()
    ;(fijarSaldoReabiertoEnTx as jest.Mock).mockResolvedValue(reabre({ sesionDeVales: { id: 'ses-1', estadoAntes: 'MATERIALIZED' } }))

    await refundService.recordRefund(VENUE, cuerpo, 'staff-1').catch(() => {})

    expect(fijarSaldoReabiertoEnTx).toHaveBeenCalled()
    expect(subirVersionDeValesTrasCommit).not.toHaveBeenCalled()
  })
})
