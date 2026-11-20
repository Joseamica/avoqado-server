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
  huellaDelCierre,
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
    expect(validarCierre(cierre({ outcome: 'CANCELADO', creditCents: 5000, changeDispensedCents: 5000 }))).toBe('OK')
    expect(validarCierre(cierre({ outcome: 'GUARDADO', creditCents: 5000, changeDispensedCents: 0 }))).toBe('OK')
    expect(validarCierre(cierre({ outcome: 'CANCELADO', creditCents: 18750, changeDispensedCents: 0 }))).toBe('IMPOSIBLE')
    expect(validarCierre(cierre({ outcome: 'GUARDADO', creditCents: 20000, changeDispensedCents: 0 }))).toBe('IMPOSIBLE')
  })

  it('GUARDADO no devuelve nada; CANCELADO no devuelve más de lo que entró', () => {
    expect(validarCierre(cierre({ outcome: 'GUARDADO', creditCents: 5000, changeDispensedCents: 100 }))).toBe('IMPOSIBLE')
    expect(validarCierre(cierre({ outcome: 'CANCELADO', creditCents: 5000, changeDispensedCents: 5050 }))).toBe('IMPOSIBLE')
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

describe('huellaDelCierre', () => {
  const huella = (over: Partial<CierreDeLaMaquina> = {}, venueId = 'venue-1', ref = 'AQ0123456789AB') =>
    huellaDelCierre(venueId, ref, cierre(over), 'MAQUINA')

  it('la misma operación da la misma huella, sin importar la hora ni el turno que se reenvíen', () => {
    expect(huella()).toBe(huella({ occurredAt: '2026-11-20T18:00:01.000Z', saleShiftId: 'shift-B' }))
  })

  it('otro crédito, otro desenlace, otro folio u otra sucursal: otra huella', () => {
    expect(huella()).not.toBe(huella({ creditCents: 20050 }))
    expect(huella()).not.toBe(huella({}, 'venue-2'))
    expect(huella()).not.toBe(huella({}, 'venue-1', 'AQ0123456789AC'))
    const iguales = { creditCents: 5000, changeDispensedCents: 0 }
    expect(huella({ outcome: 'GUARDADO', ...iguales })).not.toBe(huella({ outcome: 'CANCELADO', ...iguales }))
  })
})

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
  const A_ABIERTO = { id: 'shift-A', status: 'OPEN', endTime: null }
  const A_CERRADO = { id: 'shift-A', status: 'CLOSED', endTime: new Date('2026-11-20T19:00:00.000Z') }

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
