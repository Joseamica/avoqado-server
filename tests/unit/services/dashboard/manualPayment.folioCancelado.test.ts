/**
 * S9 (P2-5): el pago manual del panel rechaza una cuenta cancelada (`manualPayment.service.ts`), salvo la de un FOLIO: ahí es dinero ya
 * capturado (una transferencia tardía, el resto de un abono sin red) y la cuenta se revive en la MISMA transacción con la regla de
 * siempre (`reabrirSiRecibeDinero`). Su precio ya es el que vio la clienta (la cortesía se escribió al anular), así que $134 la saldan.
 * La transacción es un doble que guarda lo que escribe; lo de Postgres va en `anularFolioConBeneficios.integration.test.ts`.
 */
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutHierarchy: jest.fn().mockResolvedValue(null),
  cerrarSesionDeValesAlCerrarLaVenta: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/services/shared/paymentShiftClaim', () => ({
  ...jest.requireActual('@/services/shared/paymentShiftClaim'),
  recordPendingPaymentShiftReconciliation: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    order: { findFirst: jest.fn() },
    payment: { create: jest.fn(), findMany: jest.fn(), groupBy: jest.fn(), findUnique: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    customer: { findFirst: jest.fn() },
    table: { findFirst: jest.fn() },
    venue: { findUnique: jest.fn().mockResolvedValue({ paymentShiftReconciliationEnabled: false }) },
  },
}))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue({ complete: true }) }))
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({ __esModule: true, earnPoints: jest.fn() }))
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({ __esModule: true, updateCustomerMetrics: jest.fn() }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-1', status: 'PENDING' }),
  applySalePosting: jest.fn().mockResolvedValue({ applied: true, issues: [] }),
}))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({ __esModule: true, postCashSaleToDrawer: jest.fn() }))
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  __esModule: true,
  activarSobresDeCuentaPagadaEnTx: jest.fn().mockResolvedValue({ activated: [] }),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'

const D = (v: number) => new Prisma.Decimal(v)
const VENUE = 'cvenue000000000000000001a'
const ORDER = 'corder000000000000000001a'
const STAFF = 'cstaff000000000000000001a'
const GERENTE = 'cstaffgerente0000000001aa'

/** La cuenta de un folio de $219 con $85 de beneficio ya convertido en cortesía al anularse: vale $134. */
function cuenta(status: 'CANCELLED' | 'DELETED') {
  return {
    id: ORDER,
    venueId: VENUE,
    orderNumber: 'WK7QX',
    status,
    paymentStatus: 'PENDING',
    originSystem: 'AVOQADO',
    source: 'WEB',
    contratoDePrecio: 'IVA_INCLUIDO',
    subtotal: D(219),
    discountAmount: D(85),
    serviceChargeAmount: D(0),
    taxAmount: D(0),
    tipAmount: D(0),
    total: D(134),
    paidAmount: D(0),
    thirdPartyCashDue: null,
    customerId: null,
    customer: null,
    payments: [] as unknown[],
    orderCustomers: [] as unknown[],
    items: [] as unknown[],
  }
}

function txSobre(o: { status: 'CANCELLED' | 'DELETED'; folio: boolean }) {
  const orden = cuenta(o.status)
  const llamadas: string[] = []
  const tx = {
    llamadas,
    orden,
    $queryRaw: jest.fn().mockResolvedValue([{ id: ORDER }]),
    order: {
      findFirst: jest.fn(async () => ({ ...orden })),
      update: jest.fn(async ({ data, select }: any) => {
        llamadas.push(`order.update:${JSON.stringify(Object.keys(data))}`)
        Object.assign(orden, data)
        return select
          ? {
              orderNumber: orden.orderNumber,
              contratoDePrecio: orden.contratoDePrecio,
              taxAmount: orden.taxAmount,
              onlineOrder: o.folio ? { id: 'conline00000000000000001a', status: 'EXPIRED', requiresAcceptance: false } : null,
            }
          : orden
      }),
    },
    onlineOrder: {
      // S9 v5: «¿es cuenta de folio?» y la nota (el folio vencido trae su sello `expiredAt`).
      findFirst: jest.fn(async () =>
        o.folio
          ? { id: 'conline00000000000000001a', status: 'EXPIRED', expiredAt: new Date('2026-11-01'), cancelledAt: null, rejectedAt: null }
          : null,
      ),
      findUnique: jest.fn(async () => null),
      updateMany: jest.fn(async () => {
        llamadas.push('onlineOrder.updateMany')
        return { count: 1 }
      }),
    },
    activityLog: {
      create: jest.fn(async ({ data }: any) => {
        llamadas.push(`activityLog:${data.action}`)
        return data
      }),
      count: jest.fn(async () => llamadas.filter(l => l === 'activityLog:ONLINE_ORDER_COLLECTED_AFTER_CANCEL').length),
    },
    staffVenue: {
      findMany: jest.fn(async () => [{ staffId: GERENTE }]),
      findUnique: jest.fn(async () => ({ id: 'sv-1' })),
      findFirst: jest.fn(async () => ({ id: 'sv-1' })),
    },
    notification: { createMany: jest.fn(async ({ data }: any) => ({ count: data.length })) },
    payment: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async () => {
        llamadas.push('payment.create')
        return { id: 'cpay00000000000000000001a' }
      }),
    },
    shift: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderCustomer: { create: jest.fn() },
    venueTransaction: { create: jest.fn() },
    paymentAllocation: { create: jest.fn() },
  }
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))
  return tx
}

const pagar = (amount: string) =>
  createManualPayment(VENUE, STAFF, { orderId: ORDER, amount, tipAmount: '0', method: 'BANK_TRANSFER', source: 'OTHER' } as any)

beforeEach(() => jest.clearAllMocks())

describe('pago manual sobre la cuenta anulada de un folio (S9, P2-5)', () => {
  it('folio CANCELLED + $134 (transferencia tardía, primer dinero): se admite, reabrirSiRecibeDinero la revive en su transacción y salda', async () => {
    const tx = txSobre({ status: 'CANCELLED', folio: true })

    await expect(pagar('134.00')).resolves.toMatchObject({ id: 'cpay00000000000000000001a' })

    // La reapertura (status → PENDING, con su bitácora) va en la MISMA transacción y antes del cobro.
    const reabre = tx.llamadas.indexOf('order.update:["status"]')
    expect(reabre).toBeGreaterThanOrEqual(0)
    expect(tx.llamadas.indexOf('activityLog:ORDER_REOPENED_BY_CAPTURED_PAYMENT')).toBeGreaterThan(reabre)
    expect(reabre).toBeLessThan(tx.llamadas.indexOf('payment.create'))
    // Se avisa al gerente en la transacción del dinero (conciliación de pedido en línea). S9 (Codex r2): el folio saldado NO se mueve
    // aquí; lo pasa a «Por entregar» `syncPaidClosedFolios`, que publica después del commit.
    expect(tx.onlineOrder.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED' }) }),
    )
    expect(tx.notification.createMany).toHaveBeenCalled()
    // Saldada con el precio que vio la clienta: $134 sin pedir nada más.
    const cierre = (tx.order.update as jest.Mock).mock.calls.map(c => c[0]).find((a: any) => a.data.paymentStatus)
    expect(cierre.data).toMatchObject({
      paymentStatus: 'PAID',
      status: 'COMPLETED',
      paidAmount: D(134),
      remainingBalance: D(0),
      total: D(134),
    })
  })

  it('folio CANCELLED + $84 que no salda: se admite, revive y queda debiendo (PARTIAL)', async () => {
    const tx = txSobre({ status: 'CANCELLED', folio: true })
    await pagar('84.00')
    const cierre = (tx.order.update as jest.Mock).mock.calls.map(c => c[0]).find((a: any) => a.data.paymentStatus)
    expect(cierre.data).toMatchObject({ paymentStatus: 'PARTIAL', paidAmount: D(84), remainingBalance: D(50) })
    expect(tx.orden.status).toBe('PENDING')
  })

  it('folio DELETED (borrado desde el panel): también es dinero ya capturado y se admite (ruling S9)', async () => {
    const tx = txSobre({ status: 'DELETED', folio: true })
    await expect(pagar('134.00')).resolves.toBeDefined()
    expect(tx.llamadas).toContain('activityLog:ORDER_REOPENED_BY_CAPTURED_PAYMENT')
  })

  it.each(['CANCELLED', 'DELETED'] as const)('otra cuenta %s ⇒ 400 como hoy, sin escribir el cobro', async status => {
    const tx = txSobre({ status, folio: false })
    await expect(pagar('100.00')).rejects.toMatchObject({
      statusCode: 400,
      message: 'No se puede registrar un pago en una orden cancelada o eliminada',
    })
    expect(tx.payment.create).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('el pago no puede exceder el precio que vio la clienta: $135 sobre un folio de $134 ⇒ 400 y nada queda (la tx se revierte)', async () => {
    const tx = txSobre({ status: 'CANCELLED', folio: true })
    await expect(pagar('135.00')).rejects.toMatchObject({ statusCode: 400 })
    expect(tx.payment.create).not.toHaveBeenCalled()
  })
})
