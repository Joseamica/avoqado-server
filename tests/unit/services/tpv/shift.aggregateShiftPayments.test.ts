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
import { aggregateShiftPayments, type ShiftPaymentForTotals } from '@/services/tpv/shift.tpv.service'

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
})
