/**
 * Máquina de efectivo 1a (R4-7 #6, R3#6, R3#9, R5#5): las reglas puras del cierre. Qué combinación de importes es posible, qué se
 * le debe al cliente, qué hace dos cierres «el mismo», con qué semántica nace el pago y a qué turno va.
 */
import { PaymentMethod } from '@prisma/client'
import { mapFormaPago } from '@/services/fiscal/satCatalog'
import { postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'
import { paymentCountsAsDrawerCash } from '@/services/shared/tenderSemantics'
import { snapshotDeLaMaquina } from '@/services/mobile/order.mobile.service'
import {
  CASH_MACHINE_REF,
  deudaDelCierre,
  turnoDeLaMaquina,
  validarCierre,
  type CierreDeLaMaquina,
} from '@/services/cashMachine/ventaDeLaMaquina'

const cierre = (over: Partial<CierreDeLaMaquina> = {}): CierreDeLaMaquina => ({
  outcome: 'PAGADO',
  dueCents: 18750,
  saleCents: 18750,
  tipCents: 0,
  creditCents: 20000,
  changeDispensedCents: 1250,
  occurredAtKnown: true,
  occurredAt: '2026-11-20T18:00:00.000Z',
  ...over,
})

describe('CASH_MACHINE_REF', () => {
  it('AQ + 12 [0-9A-Z]', () => {
    expect(CASH_MACHINE_REF.test('AQ0123456789AB')).toBe(true)
    expect(CASH_MACHINE_REF.test('AQ0123456789Ab')).toBe(false)
    expect(CASH_MACHINE_REF.test('NDF0123456789A')).toBe(false)
    expect(CASH_MACHINE_REF.test('AQ0123456789ABC')).toBe(false)
  })
})

describe('validarCierre', () => {
  it('PAGADO con cambio completo, exacto o con cambio que la máquina no dio', () => {
    expect(validarCierre(cierre())).toBe('OK')
    expect(validarCierre(cierre({ creditCents: 18750, changeDispensedCents: 0 }))).toBe('OK')
    expect(validarCierre(cierre({ changeDispensedCents: 1000 }))).toBe('OK')
  })

  it('la propina va aparte: due = sale + tip', () => {
    expect(validarCierre(cierre({ dueCents: 11000, saleCents: 10000, tipCents: 1000, creditCents: 11000, changeDispensedCents: 0 }))).toBe(
      'OK',
    )
    expect(validarCierre(cierre({ dueCents: 11000, saleCents: 10000, tipCents: 0, creditCents: 11000, changeDispensedCents: 0 }))).toBe(
      'IMPOSIBLE',
    )
  })

  it('PAGADO: el cambio no pasa de crédito − adeudo, y el crédito cubre el adeudo', () => {
    expect(validarCierre(cierre({ changeDispensedCents: 1251 }))).toBe('IMPOSIBLE')
    expect(validarCierre(cierre({ creditCents: 18700, changeDispensedCents: 0 }))).toBe('IMPOSIBLE')
  })

  it('importes negativos o con fracción de centavo son imposibles', () => {
    expect(validarCierre(cierre({ changeDispensedCents: -1 }))).toBe('IMPOSIBLE')
    expect(validarCierre(cierre({ creditCents: 20000.5 }))).toBe('IMPOSIBLE')
    expect(validarCierre(cierre({ tipCents: Number.NaN }))).toBe('IMPOSIBLE')
  })

  it('R5#5: CANCELADO y GUARDADO exigen crédito < adeudo', () => {
    expect(validarCierre(cierre({ outcome: 'CANCELADO', cancelMode: '1', creditCents: 5000, changeDispensedCents: 5000 }))).toBe('OK')
    expect(validarCierre(cierre({ outcome: 'GUARDADO', cancelMode: '2', creditCents: 5000, changeDispensedCents: 0 }))).toBe('OK')
    expect(validarCierre(cierre({ outcome: 'CANCELADO', cancelMode: '1', creditCents: 18750, changeDispensedCents: 0 }))).toBe('IMPOSIBLE')
    expect(validarCierre(cierre({ outcome: 'GUARDADO', cancelMode: '2', creditCents: 20000, changeDispensedCents: 0 }))).toBe('IMPOSIBLE')
  })

  it('GUARDADO no devuelve nada; CANCELADO no devuelve más de lo que entró', () => {
    expect(validarCierre(cierre({ outcome: 'GUARDADO', cancelMode: '2', creditCents: 5000, changeDispensedCents: 100 }))).toBe('IMPOSIBLE')
    expect(validarCierre(cierre({ outcome: 'CANCELADO', cancelMode: '1', creditCents: 5000, changeDispensedCents: 5050 }))).toBe(
      'IMPOSIBLE',
    )
  })

  it('🔴 Codex r1 #12 (decisión h): un adeudo de $0, negativo o que no es múltiplo de $0.50 es imposible, aunque todo lo demás cuadre', () => {
    expect(validarCierre(cierre({ dueCents: 0, saleCents: 0, creditCents: 0, changeDispensedCents: 0 }))).toBe('IMPOSIBLE')
    // El caso de Codex: $187.35 «PAGADO».
    expect(validarCierre(cierre({ dueCents: 18735, saleCents: 18735, creditCents: 20000, changeDispensedCents: 1265 }))).toBe('IMPOSIBLE')
    expect(validarCierre(cierre({ dueCents: 18750, saleCents: 18750, creditCents: 20000, changeDispensedCents: 1250 }))).toBe('OK')
    expect(validarCierre(cierre({ dueCents: 50, saleCents: 50, creditCents: 100, changeDispensedCents: 50 }))).toBe('OK')
  })

  it('🔴 Codex r1 #12 (R4-7 #6): una cancelación sin el modo del cancel, o con el contrario, va a revisión', () => {
    const cancelado = { outcome: 'CANCELADO' as const, creditCents: 5000, changeDispensedCents: 5000 }
    expect(validarCierre(cierre(cancelado))).toBe('IMPOSIBLE')
    expect(validarCierre(cierre({ ...cancelado, cancelMode: null }))).toBe('IMPOSIBLE')
    expect(validarCierre(cierre({ ...cancelado, cancelMode: '2' }))).toBe('IMPOSIBLE')
    const guardado = { outcome: 'GUARDADO' as const, creditCents: 5000, changeDispensedCents: 0 }
    expect(validarCierre(cierre(guardado))).toBe('IMPOSIBLE')
    expect(validarCierre(cierre({ ...guardado, cancelMode: '1' }))).toBe('IMPOSIBLE')
  })
})

describe('deudaDelCierre', () => {
  it('PAGADO con cambio que faltó → CAMBIO', () => {
    expect(deudaDelCierre(cierre({ changeDispensedCents: 1000 }), 0)).toEqual({ owedCents: 250, owedKind: 'CAMBIO' })
  })

  it('PAGADO completo → nada', () => {
    expect(deudaDelCierre(cierre(), 0)).toEqual({ owedCents: 0, owedKind: null })
  })

  it('PAGADO con precio menor → EXCEDENTE (también suma el cambio que faltó)', () => {
    expect(deudaDelCierre(cierre({ creditCents: 18750, changeDispensedCents: 0 }), 130)).toEqual({ owedCents: 130, owedKind: 'EXCEDENTE' })
    expect(deudaDelCierre(cierre({ changeDispensedCents: 1000 }), 130)).toEqual({ owedCents: 380, owedKind: 'EXCEDENTE' })
  })

  it('GUARDADO → lo que entró; CANCELADO → lo que no regresó', () => {
    expect(deudaDelCierre(cierre({ outcome: 'GUARDADO', creditCents: 5000, changeDispensedCents: 0 }), 0)).toEqual({
      owedCents: 5000,
      owedKind: 'GUARDADO',
    })
    expect(deudaDelCierre(cierre({ outcome: 'CANCELADO', creditCents: 5000, changeDispensedCents: 4500 }), 0)).toEqual({
      owedCents: 500,
      owedKind: 'NO_DEVUELTO',
    })
    expect(deudaDelCierre(cierre({ outcome: 'CANCELADO', creditCents: 5000, changeDispensedCents: 5000 }), 0)).toEqual({
      owedCents: 0,
      owedKind: null,
    })
  })
})

// La huella de la operación (antes `huellaDelCierre`) es ahora la de la observación: `decisionDelFolio.test.ts` (r6-3).

describe('snapshotDeLaMaquina', () => {
  const pago = { ...snapshotDeLaMaquina('AQ0123456789AB'), tenderTypeId: null }

  it('efectivo para ventas y factura (01) que NO está en el cajón', () => {
    expect(pago).toMatchObject({
      method: 'CASH',
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderLabel: 'Efectivo · máquina',
      tenderSatFormaPago: '01',
      tenderCountsAsCash: false,
      cashMachineRef: 'AQ0123456789AB',
    })
    expect(paymentCountsAsDrawerCash(pago)).toBe(false)
    expect(mapFormaPago(PaymentMethod.CASH, pago.tenderSatFormaPago)).toBe('01')
  })

  it('el cajón no la recibe: NOT_DRAWER_CASH', async () => {
    await expect(
      postCashSaleToDrawer({
        venueId: 'venue-1',
        paymentId: 'payment-1',
        status: 'COMPLETED',
        type: 'REGULAR',
        method: pago.method,
        fundsFlow: pago.fundsFlow,
        tenderCountsAsCash: pago.tenderCountsAsCash,
        tenderTypeId: null,
        amount: 187.5,
        tipAmount: 0,
        orderNumber: 'ORD-1',
        staffId: null,
        orderId: 'order-1',
      }),
    ).resolves.toBe('NOT_DRAWER_CASH')
  })
})

describe('turnoDeLaMaquina', () => {
  const INICIO = new Date('2026-11-20T14:00:00.000Z')
  const A_ABIERTO = { id: 'shift-A', status: 'OPEN', startTime: INICIO, endTime: null }
  const A_CERRADO = { id: 'shift-A', status: 'CLOSED', startTime: INICIO, endTime: new Date('2026-11-20T19:00:00.000Z') }

  it('🔴 Codex r1 #11: el dinero entró ANTES de que A empezara (09:59 contra un turno de las 10:00) → por conciliar, nunca A', () => {
    const B = { id: 'shift-B', status: 'OPEN', startTime: new Date('2026-11-20T16:00:00.000Z'), endTime: null }
    expect(turnoDeLaMaquina(cierre({ saleShiftId: 'shift-B', occurredAt: '2026-11-20T15:59:00.000Z' }), B)).toEqual({
      expectedShiftId: null,
      porConciliar: true,
      shiftStatus: 'POR_CONCILIAR',
    })
    // El mismo segundo del inicio sí es del turno.
    expect(turnoDeLaMaquina(cierre({ saleShiftId: 'shift-B', occurredAt: '2026-11-20T16:00:00.000Z' }), B)).toMatchObject({
      expectedShiftId: 'shift-B',
      shiftStatus: 'EN_TURNO',
    })
  })

  it('A abierto → A', () => {
    expect(turnoDeLaMaquina(cierre({ saleShiftId: 'shift-A' }), A_ABIERTO)).toEqual({
      expectedShiftId: 'shift-A',
      porConciliar: false,
      shiftStatus: 'EN_TURNO',
    })
  })

  it('A cerrado y el dinero entró durante A → turno cerrado, sin el vivo', () => {
    expect(turnoDeLaMaquina(cierre({ saleShiftId: 'shift-A' }), A_CERRADO)).toEqual({
      expectedShiftId: 'shift-A',
      porConciliar: false,
      shiftStatus: 'TURNO_CERRADO',
    })
  })

  it('el dinero entró DESPUÉS de que A terminó → por conciliar', () => {
    expect(turnoDeLaMaquina(cierre({ saleShiftId: 'shift-A', occurredAt: '2026-11-20T19:00:01.000Z' }), A_CERRADO)).toEqual({
      expectedShiftId: null,
      porConciliar: true,
      shiftStatus: 'POR_CONCILIAR',
    })
  })

  it('sin hora, sin turno o con un turno que no es del negocio → por conciliar', () => {
    const porConciliar = { expectedShiftId: null, porConciliar: true, shiftStatus: 'POR_CONCILIAR' }
    expect(turnoDeLaMaquina(cierre({ saleShiftId: 'shift-A', occurredAtKnown: false, occurredAt: null }), A_ABIERTO)).toEqual(porConciliar)
    expect(turnoDeLaMaquina(cierre({ saleShiftId: null }), A_ABIERTO)).toEqual(porConciliar)
    expect(turnoDeLaMaquina(cierre({ saleShiftId: 'shift-X' }), null)).toEqual(porConciliar)
  })
})
