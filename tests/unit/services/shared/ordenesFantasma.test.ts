/**
 * Órdenes fantasma del cobro fallido a terminal (corrección de datos, sep-2026).
 *
 * Caso semilla (Testarudo, 15-sep): el POS crea la orden en el servidor al entrar a «Cobrar», el
 * cobro a la terminal falla (422 / 409 «terminal busy» / DELETE rechazado con 409) y la orden se
 * queda CONFIRMED sin un solo pago; el cajero rehace la venta como orden nueva. El dinero entró
 * una vez; la orden abandonada infla «Ventas brutas» de la app y de Reportes ($695 el 15-sep).
 *
 * Lo que estas pruebas protegen:
 *   1. 🔴 sólo es fantasma una orden SIN dinero encima: `paymentStatus` PENDING y CERO filas de
 *      Payment (de cualquier estado). Un PAID/PARTIAL jamás se cancela por aquí.
 *   2. 🔴 un cobro a terminal cuyo desenlace todavía puede mover dinero (PENDING, SENT,
 *      CANCEL_REQUESTED, UNKNOWN) bloquea: cancelar la orden debajo de él es el defecto que se
 *      está corrigiendo, no la corrección.
 *   3. una orden ligada a mesa, tocada después de crearse, en otro `status`, o demasiado
 *      reciente NO es de esta clase: puede ser una cuenta abierta legítima.
 *   4. la gemela (la venta rehecha) es INFORMATIVA: se busca por mismo subtotal dentro de la
 *      ventana y nunca sobre la misma orden; no decide nada.
 */
import { Prisma } from '@prisma/client'
import { clasificarOrdenFantasma, emparejarGemela, EDAD_MINIMA_MIN, type OrdenFoto, type PagoFoto } from '@/services/shared/ordenesFantasma'

const D = (v: string | number) => new Prisma.Decimal(v)
const AHORA = new Date('2026-09-15T20:00:00-06:00')
const HACE = (min: number) => new Date(AHORA.getTime() - min * 60_000)

/** La orden semilla: ORD-1789491958192, $380 + $38 de propina, sin pago, nunca tocada. */
const fantasma = (over: Partial<OrdenFoto> = {}): OrdenFoto => ({
  id: 'ord-fantasma',
  orderNumber: 'ORD-1789491958192',
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  subtotal: D('380.00'),
  tableId: null,
  createdAt: HACE(9 * 60),
  updatedAt: HACE(9 * 60),
  pagos: 0,
  solicitudesVivas: 0,
  ...over,
})

describe('clasificarOrdenFantasma', () => {
  it('la orden semilla es fantasma', () => {
    expect(clasificarOrdenFantasma(fantasma(), AHORA)).toEqual({ fantasma: true })
  })

  it('P1: una orden con dinero encima (PAID o PARTIAL) nunca es fantasma', () => {
    for (const paymentStatus of ['PAID', 'PARTIAL']) {
      const v = clasificarOrdenFantasma(fantasma({ paymentStatus }), AHORA)
      expect(v.fantasma).toBe(false)
      expect((v as { motivo: string }).motivo).toMatch(/dinero/)
    }
  })

  it('P1: una fila de Payment de cualquier estado bloquea, aunque paymentStatus siga PENDING', () => {
    const v = clasificarOrdenFantasma(fantasma({ pagos: 1 }), AHORA)
    expect(v).toEqual({ fantasma: false, motivo: expect.stringMatching(/1 pago/) })
  })

  it('P1: un cobro a terminal sin desenlace bloquea', () => {
    const v = clasificarOrdenFantasma(fantasma({ solicitudesVivas: 1 }), AHORA)
    expect(v).toEqual({ fantasma: false, motivo: expect.stringMatching(/terminal/) })
  })

  it('sólo CONFIRMED es de esta clase', () => {
    for (const status of ['PENDING', 'IN_PROGRESS', 'READY', 'COMPLETED', 'CANCELLED']) {
      expect(clasificarOrdenFantasma(fantasma({ status }), AHORA).fantasma).toBe(false)
    }
  })

  it('una orden ligada a mesa puede ser una cuenta abierta legítima', () => {
    const v = clasificarOrdenFantasma(fantasma({ tableId: 'mesa-4' }), AHORA)
    expect(v).toEqual({ fantasma: false, motivo: expect.stringMatching(/mesa/) })
  })

  it('una orden tocada después de crearse no es de esta clase', () => {
    const v = clasificarOrdenFantasma(fantasma({ updatedAt: HACE(8 * 60) }), AHORA)
    expect(v).toEqual({ fantasma: false, motivo: expect.stringMatching(/tocada/) })
  })

  it('una orden más reciente que la edad mínima todavía puede estar en vuelo', () => {
    const reciente = fantasma({ createdAt: HACE(EDAD_MINIMA_MIN - 1), updatedAt: HACE(EDAD_MINIMA_MIN - 1) })
    expect(clasificarOrdenFantasma(reciente, AHORA).fantasma).toBe(false)
    const justa = fantasma({ createdAt: HACE(EDAD_MINIMA_MIN), updatedAt: HACE(EDAD_MINIMA_MIN) })
    expect(clasificarOrdenFantasma(justa, AHORA).fantasma).toBe(true)
  })

  it('la edad mínima se puede ampliar por parámetro, nunca por debajo de un minuto', () => {
    const o = fantasma({ createdAt: HACE(200), updatedAt: HACE(200) })
    expect(clasificarOrdenFantasma(o, AHORA, 240).fantasma).toBe(false)
    expect(() => clasificarOrdenFantasma(o, AHORA, 0)).toThrow(/edad/)
  })
})

/** Pagos del venue alrededor de la semilla: la gemela real (23 s después) y ruido. */
const pago = (over: Partial<PagoFoto> = {}): PagoFoto => ({
  id: 'pay-gemela',
  orderId: 'ord-gemela',
  orderNumber: 'ORD-1789491981442',
  orderSource: 'AVOQADO_ANDROID',
  orderSubtotal: D('380.00'),
  status: 'COMPLETED',
  type: 'REGULAR',
  method: 'CASH',
  createdAt: new Date(fantasma().createdAt.getTime() + 23_000),
  ...over,
})

describe('emparejarGemela', () => {
  it('encuentra la venta rehecha: mismo subtotal, otra orden, dentro de la ventana', () => {
    expect(emparejarGemela(fantasma(), [pago()])).toEqual({
      orderNumber: 'ORD-1789491981442',
      method: 'CASH',
      source: 'AVOQADO_ANDROID',
      segundos: 23,
    })
  })

  it('ignora otro subtotal, la misma orden, reembolsos, pagos no completados y lo que cae fuera de la ventana', () => {
    const o = fantasma()
    expect(emparejarGemela(o, [pago({ orderSubtotal: D('380.01') })])).toBeNull()
    expect(emparejarGemela(o, [pago({ orderId: o.id })])).toBeNull()
    expect(emparejarGemela(o, [pago({ type: 'REFUND' })])).toBeNull()
    expect(emparejarGemela(o, [pago({ status: 'PENDING' })])).toBeNull()
    expect(emparejarGemela(o, [pago({ createdAt: new Date(o.createdAt.getTime() + 301_000) })])).toBeNull()
    expect(emparejarGemela(o, [pago({ createdAt: new Date(o.createdAt.getTime() - 1_000) })])).toBeNull()
  })

  it('con varias candidatas se queda con la más cercana en el tiempo', () => {
    const lejana = pago({
      id: 'p2',
      orderId: 'ord-otra',
      orderNumber: 'ORD-OTRA',
      createdAt: new Date(fantasma().createdAt.getTime() + 200_000),
    })
    expect(emparejarGemela(fantasma(), [lejana, pago()])?.orderNumber).toBe('ORD-1789491981442')
  })
})
