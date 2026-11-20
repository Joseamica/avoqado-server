/**
 * `aggregateShiftPayments` — la MISMA aritmética con la que se cierra un turno, extraída del
 * cuerpo de `closeShiftUsingRequest` (tarea 9 del «turno de caja del negocio», fase 1).
 *
 * Se extrae para que el script de reatribución histórica
 * (`scripts/reatribuir-cobros-al-turno.ts`) recalcule los contadores de un turno con la regla
 * del cierre y no con una copia — «una regla copiada en N sitios» es cómo nacieron las tres
 * definiciones distintas de «efectivo esperado» que este repo ya pagó una vez.
 *
 * 🔴 La extracción NO cambia ninguna regla: mismos `if` por método, misma `totalCashTips`,
 * mismo `totalDrawerExtra`. Estas pruebas fijan el comportamiento HEREDADO, no uno nuevo — si
 * una falla tras un refactor, el refactor movió dinero.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    payment: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
    rawMaterialMovement: { findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    activityLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))
jest.mock('@/services/access/cashReconciliationAccess.service', () => ({
  isCashReconciliationEnabled: jest.fn(),
}))
jest.mock('@/services/dashboard/shift.dashboard.service', () => ({
  resolveShiftCashDrawer: jest.fn().mockResolvedValue(null),
}))

import { Decimal } from '@prisma/client/runtime/library'
import prisma from '@/utils/prismaClient'
import { isCashReconciliationEnabled } from '@/services/access/cashReconciliationAccess.service'
import { aggregateShiftPayments, closeShiftForVenueWithResult, type ShiftPaymentForTotals } from '@/services/tpv/shift.tpv.service'

const pago = (o: Partial<ShiftPaymentForTotals> = {}): ShiftPaymentForTotals => ({
  amount: new Decimal(0),
  tipAmount: new Decimal(0),
  method: 'CASH',
  fundsFlow: null,
  tenderTypeId: null,
  tenderCountsAsCash: null,
  ...o,
})

describe('aggregateShiftPayments — la misma regla que el cierre del turno', () => {
  it('suma ventas y propinas, separa efectivo/tarjeta y lleva la propina en efectivo aparte', () => {
    const r = aggregateShiftPayments([
      pago({ amount: new Decimal(100), tipAmount: new Decimal(10), method: 'CASH' }),
      pago({ amount: new Decimal(200), tipAmount: new Decimal(20), method: 'CREDIT_CARD' }),
      pago({ amount: new Decimal(50), tipAmount: new Decimal(0), method: 'DEBIT_CARD' }),
    ])
    expect(r.totalSales.toNumber()).toBe(350)
    expect(r.totalTips.toNumber()).toBe(30)
    expect(r.totalCashPayments.toNumber()).toBe(100)
    expect(r.totalCardPayments.toNumber()).toBe(250)
    expect(r.totalCashTips.toNumber()).toBe(10)
  })

  it('un reembolso (negativo) resta de las ventas', () => {
    const r = aggregateShiftPayments([
      pago({ amount: new Decimal(100), method: 'CASH' }),
      pago({ amount: new Decimal(-30), method: 'CASH' }),
    ])
    expect(r.totalSales.toNumber()).toBe(70)
    expect(r.totalCashPayments.toNumber()).toBe(70)
  })

  // ── Regresión: las ramas que el cierre YA tenía y que la extracción no puede perder ──

  it('la propina de TARJETA no entra a totalCashTips (ese dinero llega por el banco)', () => {
    const r = aggregateShiftPayments([pago({ amount: new Decimal(200), tipAmount: new Decimal(40), method: 'CREDIT_CARD' })])
    expect(r.totalTips.toNumber()).toBe(40)
    expect(r.totalCashTips.toNumber()).toBe(0)
    expect(r.totalDrawerExtra.toNumber()).toBe(0)
  })

  it('DIGITAL_WALLET va a vales; BANK_TRANSFER y OTHER van a «otros»', () => {
    const r = aggregateShiftPayments([
      pago({ amount: new Decimal(11), method: 'DIGITAL_WALLET' }),
      pago({ amount: new Decimal(22), method: 'BANK_TRANSFER' }),
      pago({ amount: new Decimal(33), method: 'OTHER' }),
    ])
    expect(r.totalVoucherPayments.toNumber()).toBe(11)
    expect(r.totalOtherPayments.toNumber()).toBe(33 + 22)
    expect(r.totalCashPayments.toNumber()).toBe(0)
    expect(r.totalCardPayments.toNumber()).toBe(0)
    expect(r.totalSales.toNumber()).toBe(66)
  })

  it('un tender personalizado que cuenta como efectivo físico entra a totalDrawerExtra, NUNCA a las ventas en efectivo', () => {
    // Vale de despensa: method=OTHER + snapshot del tender con countsAsPhysicalCash.
    // El billete SÍ está en el cajón (drawerExtra) pero no es una VENTA en efectivo.
    const r = aggregateShiftPayments([
      pago({ amount: new Decimal(80), tipAmount: new Decimal(5), method: 'OTHER', tenderCountsAsCash: true }),
    ])
    expect(r.totalDrawerExtra.toNumber()).toBe(85)
    expect(r.totalCashPayments.toNumber()).toBe(0)
    expect(r.totalCashTips.toNumber()).toBe(0)
    expect(r.totalOtherPayments.toNumber()).toBe(80)
  })

  it('fundsFlow manda sobre el snapshot del tender: AVOQADO_PROCESSED no toca el cajón', () => {
    // OXXO por liga de pago: method=CASH histórico pero lo liquida Stripe.
    const r = aggregateShiftPayments([
      pago({ amount: new Decimal(500), method: 'OTHER', tenderCountsAsCash: true, fundsFlow: 'AVOQADO_PROCESSED' }),
    ])
    expect(r.totalDrawerExtra.toNumber()).toBe(0)
    expect(r.totalOtherPayments.toNumber()).toBe(500)
  })

  it('un cobro en efectivo NO duplica su monto en totalDrawerExtra', () => {
    // La rama de drawerExtra excluye method === 'CASH' a propósito: ese dinero ya lo
    // cuenta `totalCashPayments` + `totalCashTips`. Sumarlo dos veces inventaría un sobrante.
    const r = aggregateShiftPayments([pago({ amount: new Decimal(100), tipAmount: new Decimal(10), method: 'CASH' })])
    expect(r.totalDrawerExtra.toNumber()).toBe(0)
    expect(r.totalCashPayments.toNumber()).toBe(100)
    expect(r.totalCashTips.toNumber()).toBe(10)
  })

  it('una lista vacía devuelve LOS OCHO totales en cero, no NaN ni un objeto a medias', () => {
    const r = aggregateShiftPayments([])
    // El conteo se afirma explícitamente: recorrer las llaves que existan pasaría feliz con un
    // objeto de tres campos, y el cierre escribe los ocho en la fila del turno.
    const nombres = Object.keys(r).sort() as Array<keyof typeof r>
    expect(nombres).toEqual([
      'totalCardPayments',
      'totalCashPayments',
      'totalCashTips',
      'totalDrawerExtra',
      'totalOtherPayments',
      'totalSales',
      'totalTips',
      'totalVoucherPayments',
    ])
    // Indexado por `keyof` en vez de `Object.entries`, que tipa el valor como `unknown`
    // (lo cazó el typecheck del checkpoint: jest transpila sin comprobar tipos).
    for (const nombre of nombres) {
      expect(`${nombre}=${r[nombre].toNumber()}`).toBe(`${nombre}=0`)
    }
  })

  it('tolera amount/tipAmount nulos como el cierre (|| 0), en vez de propagar NaN', () => {
    const r = aggregateShiftPayments([pago({ amount: null, tipAmount: null, method: 'CASH' })])
    expect(r.totalSales.toNumber()).toBe(0)
    expect(r.totalCashTips.toNumber()).toBe(0)
  })

  it('no pierde centavos: Decimal, no float (0.1 + 0.2)', () => {
    const r = aggregateShiftPayments([
      pago({ amount: new Decimal('0.1'), method: 'CASH' }),
      pago({ amount: new Decimal('0.2'), method: 'CASH' }),
    ])
    expect(r.totalSales.toFixed(2)).toBe('0.30')
    expect(r.totalCashPayments.toFixed(2)).toBe('0.30')
  })

  it('Rappi 2b: lo cobrado por cuenta de Rappi entra al efectivo esperado (totalDrawerExtra), NUNCA a ventas ni propinas', () => {
    const r = aggregateShiftPayments([
      pago({
        amount: new Decimal(175),
        tipAmount: new Decimal(20),
        method: 'CASH',
        fundsFlow: 'CASH_DRAWER',
        thirdPartyCashAmount: new Decimal(10),
      }),
    ])
    expect(r.totalSales.toNumber()).toBe(175)
    expect(r.totalTips.toNumber()).toBe(20)
    expect(r.totalCashPayments.toNumber()).toBe(175)
    expect(r.totalCashTips.toNumber()).toBe(20)
    expect(r.totalDrawerExtra.toNumber()).toBe(10)
  })
})

// ── Máquina de efectivo (fase 1a, A5): una venta en efectivo que NO está en el cajón ──
//
// La máquina QuickPay Mini registra `method CASH` + `fundsFlow EXTERNAL_RECORDED`: es VENTA en efectivo (reportes, MCP,
// `totalCashPayments` no cambian), pero el billete se quedó en la máquina. El esperado del cajón no puede contarlo o le firma al
// cajero un faltante del tamaño de lo que cobró la máquina. Las tres rutas del corte se prueban aquí y en
// `tests/unit/services/dashboard/shift.updateShift.cashDifference.test.ts` (la edición del corte).
describe('máquina de efectivo: ventas en efectivo 250, cajón 100', () => {
  const CAJON = pago({ amount: new Decimal(100) })
  const MAQUINA = pago({ amount: new Decimal(150), fundsFlow: 'EXTERNAL_RECORDED' })

  it('aggregateShiftPayments: la venta de la máquina sigue siendo venta en efectivo y no se cuela como drawerExtra', () => {
    const r = aggregateShiftPayments([CAJON, MAQUINA])
    expect(r.totalCashPayments.toNumber()).toBe(250)
    expect(r.totalSales.toNumber()).toBe(250)
    expect(r.totalDrawerExtra.toNumber()).toBe(0)
  })

  describe('el cierre del turno en la TPV', () => {
    const mockPrisma = prisma as any
    const VENUE_ID = 'venue-maquina'
    const SHIFT_ID = 'shift-maquina'
    let shift: any
    let tx: any
    let finalWrite: any

    const auditoria = () => tx.activityLog.create.mock.calls[0][0].data.data

    beforeEach(() => {
      jest.clearAllMocks()
      shift = {
        id: SHIFT_ID,
        venueId: VENUE_ID,
        staffId: 'staff-1',
        startTime: new Date('2026-11-20T14:00:00.000Z'),
        endTime: null,
        status: 'OPEN',
        updatedAt: new Date('2026-11-20T14:00:00.000Z'),
        startingCash: new Decimal('1000.00'),
        externalId: null,
        venue: { posType: 'NONE', posStatus: 'DISCONNECTED', name: 'Galeterie' },
      }
      finalWrite = undefined
      ;(isCashReconciliationEnabled as jest.Mock).mockResolvedValue(true)
      mockPrisma.shift.findFirst.mockResolvedValue(shift)
      mockPrisma.shift.updateMany.mockResolvedValue({ count: 1 })
      mockPrisma.shift.update.mockResolvedValue({ ...shift, endTime: new Date(), status: 'CLOSED' })
      mockPrisma.payment.findMany.mockResolvedValue([
        { ...CAJON, id: 'pago-cajon' },
        { ...MAQUINA, id: 'pago-maquina' },
      ])
      mockPrisma.orderItem.findMany.mockResolvedValue([])
      mockPrisma.rawMaterialMovement.findMany.mockResolvedValue([])
      mockPrisma.staffVenue.findFirst.mockResolvedValue(null)
      tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
        tpvShiftOperation: { findFirst: jest.fn().mockResolvedValue(null) },
        shift: {
          findFirst: jest.fn(async () => shift),
          updateMany: jest.fn(async (args: any) => {
            finalWrite = args
            return { count: 1 }
          }),
          findUnique: jest.fn(async () => ({ ...shift, ...finalWrite.data })),
        },
        activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
      }
      mockPrisma.$transaction.mockImplementation(async (callback: any) => callback(tx))
    })

    it('🔴 cierre nuevo con conteo: espera fondo + 100, no + 250 (sin faltante falso de $150)', async () => {
      const result = await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, { cashReconciliationAction: 'COUNTED', countedCash: '1100.00' })

      expect(result.reconciliation).toEqual({ outcome: 'APPLIED', countedCash: '1100.00', cashDifference: '0.00' })
      expect(auditoria()).toEqual(expect.objectContaining({ expectedCash: '1100.00', expectedSource: 'TURNO' }))
      // Las VENTAS en efectivo no cambian de semántica.
      expect(finalWrite.data.totalCashPayments.toString()).toBe('250')
      expect(finalWrite.data.totalSales.toString()).toBe('250')
    })

    it('cierre nuevo sin conteo: lo que queda en el cajón es 100', async () => {
      await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, { cashReconciliationAction: 'SKIPPED' })

      expect(finalWrite.data.endingCash.toString()).toBe('100')
    })

    it('🔴 cierre viejo sin efectivo declarado: el respaldo del cajón es 100, no las ventas (250)', async () => {
      await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, { notes: 'Cierre administrativo', cardDeclared: 25 })

      expect(finalWrite.data.endingCash.toString()).toBe('100')
      expect(finalWrite.data.totalCashPayments.toString()).toBe('250')
    })

    it('🔴 cierre viejo con $100 declarados: la discrepancia de auditoría es 0, no −150', async () => {
      await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, { cashDeclared: 100 })

      expect(finalWrite.data.endingCash.toString()).toBe('1100')
      expect(auditoria()).toEqual(expect.objectContaining({ declaredCash: '100.00', cashDiscrepancy: 0 }))
    })

    it('regresión: sin cobros de la máquina, el cierre viejo y el nuevo dan lo de siempre', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([
        { ...pago({ amount: new Decimal(250), tipAmount: new Decimal(10) }), id: 'pago-viejo' },
      ])

      await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, { cashDeclared: 240 })
      // El respaldo viejo nunca sumó la propina; la discrepancia tampoco.
      expect(auditoria()).toEqual(expect.objectContaining({ cashDiscrepancy: -10 }))
    })
  })
})
