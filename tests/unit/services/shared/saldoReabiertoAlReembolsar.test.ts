/**
 * D19 (founder 10-nov «A»; nube 12-nov): ¿cuánto de un reembolso vuelve a deberse? Lo decide UNA vez quien escribe el
 * reembolso, con la cuenta bloqueada y sus cobros de ESE momento. Regla:
 *
 *   reabre ⟺ cuenta VIVA (no cancelada) · no CERRADA (PAID/REFUNDED) · y todavía debía con los cobros de antes
 *   importe reabierto = min(importe devuelto, importe cobrado neto)
 *   propina reabierta = min(propina devuelta, propina cobrada neta)
 *
 * Una devolución de producto sobre una venta cubierta o cerrada no reabre nada (regla del 18-ago).
 */
import { Prisma } from '@prisma/client'
import {
  fijarSaldoReabiertoEnTx,
  saldoQueReabreElReembolso,
  subirVersionDeValesTrasCommit,
} from '@/services/shared/saldoReabiertoAlReembolsar'
import type { TxConReintento } from '@/utils/serializableRetry'
import { prismaMock } from '../../../__helpers__/setup'

const d = (v: string | number) => new Prisma.Decimal(v)

const cuenta = (over: Partial<{ subtotal: string; status: string; paymentStatus: string; taxAmount: string; contrato: string }> = {}) => ({
  subtotal: d(over.subtotal ?? '100.00'),
  discountAmount: d('0.00'),
  serviceChargeAmount: d('0.00'),
  contratoDePrecio: over.contrato ?? 'IVA_INCLUIDO',
  taxAmount: d(over.taxAmount ?? '0.00'),
  status: over.status ?? 'PENDING',
  paymentStatus: over.paymentStatus ?? 'PARTIAL',
})
const cobro = (amount: string, tip = '0.00') => ({
  amount: d(amount),
  tipAmount: d(tip),
  type: 'REGULAR',
  reopenedAmount: null,
  reopenedTipAmount: null,
})
const reembolso = (amount: string, tip = '0.00', reAmount: string | null = null, reTip: string | null = null) => ({
  amount: d(`-${amount}`),
  tipAmount: d(`-${tip}`),
  type: 'REFUND',
  reopenedAmount: reAmount == null ? null : d(reAmount),
  reopenedTipAmount: reTip == null ? null : d(reTip),
})
const decide = (order: ReturnType<typeof cuenta>, pagosAntes: any[], importe: string, propina = '0.00') => {
  const r = saldoQueReabreElReembolso({ order, pagosAntes, devueltoImporte: d(importe), devueltoPropina: d(propina) })
  return { importe: r.reopenedAmount.toString(), propina: r.reopenedTipAmount.toString(), reabre: r.reabre }
}

describe('saldoQueReabreElReembolso — D19', () => {
  it('🔴 cuenta $100 con abono $50 que se devuelve: reabre los $50', () => {
    expect(decide(cuenta(), [cobro('50.00')], '50.00')).toEqual({ importe: '50', propina: '0', reabre: true })
  })

  it('devolución parcial del abono: reabre sólo lo devuelto', () => {
    expect(decide(cuenta(), [cobro('50.00')], '20.00')).toEqual({ importe: '20', propina: '0', reabre: true })
  })

  it('la propina devuelta del abono también reabre, topada a la propina cobrada', () => {
    expect(decide(cuenta(), [cobro('50.00', '10.00')], '50.00', '10.00')).toEqual({ importe: '50', propina: '10', reabre: true })
  })

  it('cuenta que debía $10 ($90 de $100): devolver los $90 reabre $90', () => {
    expect(decide(cuenta(), [cobro('90.00')], '90.00')).toEqual({ importe: '90', propina: '0', reabre: true })
  })

  it('un segundo reembolso tras uno ya reabierto se topa en lo que queda cobrado neto', () => {
    // Abono $50; ya se devolvieron $30 que reabrieron $30 (quedan $20 netos). Se devuelven otros $30: reabre $20.
    expect(decide(cuenta(), [cobro('50.00'), reembolso('30.00', '0.00', '30.00', '0.00')], '30.00')).toEqual({
      importe: '20',
      propina: '0',
      reabre: true,
    })
  })

  it('IVA aparte: la cuenta de $100 + $16 con $100 cobrados todavía debía; devolverlos reabre $100', () => {
    expect(decide(cuenta({ contrato: 'IVA_APARTE', taxAmount: '16.00' }), [cobro('100.00')], '100.00')).toEqual({
      importe: '100',
      propina: '0',
      reabre: true,
    })
  })

  it('🔴 Rappi 2b (Codex plan r2 #4): venta en $0 por descuento del proveedor, propina pactada a medias; devolverla SÍ reabre', () => {
    // Pedido de $100 con descuento de $100 del proveedor, propina pactada $10 y tarifa de Rappi $20. Se cobraron $25: $20 a Rappi y
    // $5 a propina. El saldo común se ve «saldado» ($5 de propina contra $5 cobrados), pero faltan $5 de propina pactada.
    const order = { ...cuenta(), discountAmount: d('100.00'), thirdPartyCashDue: d('20.00'), cashTipDue: d('10.00') }
    const pagos = [{ ...cobro('0.00', '5.00'), thirdPartyCashAmount: d('20.00') }]
    const r = saldoQueReabreElReembolso({ order, pagosAntes: pagos, devueltoImporte: d('0.00'), devueltoPropina: d('5.00') })

    expect(r.reabre).toBe(true)
    expect(r.reopenedTipAmount.toString()).toBe('5')
    expect(r.reopenedAmount.toString()).toBe('0')
  })

  it('Rappi 2b con las tres partes cubiertas: devolver no reabre (devolución sobre lo ya saldado)', () => {
    const order = { ...cuenta(), discountAmount: d('100.00'), thirdPartyCashDue: d('20.00'), cashTipDue: d('10.00') }
    const pagos = [{ ...cobro('0.00', '10.00'), thirdPartyCashAmount: d('20.00') }]
    const r = saldoQueReabreElReembolso({ order, pagosAntes: pagos, devueltoImporte: d('0.00'), devueltoPropina: d('5.00') })

    expect(r.reabre).toBe(false)
  })

  describe('NO reabre (regla del 18-ago y cuentas que no deben)', () => {
    it('REGRESIÓN 18-ago: venta cerrada (PAID) que se reembolsa sigue cerrada', () => {
      expect(decide(cuenta({ paymentStatus: 'PAID' }), [cobro('100.00')], '100.00')).toEqual({ importe: '0', propina: '0', reabre: false })
    })

    it('venta ya REFUNDED tampoco', () => {
      expect(decide(cuenta({ paymentStatus: 'REFUNDED' }), [cobro('100.00')], '40.00')).toEqual({
        importe: '0',
        propina: '0',
        reabre: false,
      })
    })

    it('cuenta cubierta aunque no esté marcada PAID (cierre automático no permitido): devolución de producto, no reabre', () => {
      expect(decide(cuenta({ paymentStatus: 'PARTIAL' }), [cobro('100.00')], '30.00')).toEqual({
        importe: '0',
        propina: '0',
        reabre: false,
      })
    })

    it('cuenta sobrepagada: no reabre', () => {
      expect(decide(cuenta(), [cobro('120.00')], '20.00')).toEqual({ importe: '0', propina: '0', reabre: false })
    })

    it('cuenta CANCELADA con abono: devolverlo no la hace deber (se fue cancelada)', () => {
      expect(decide(cuenta({ status: 'CANCELLED' }), [cobro('50.00')], '50.00')).toEqual({ importe: '0', propina: '0', reabre: false })
    })

    it('cuenta BORRADA: tampoco', () => {
      expect(decide(cuenta({ status: 'DELETED' }), [cobro('50.00')], '50.00')).toEqual({ importe: '0', propina: '0', reabre: false })
    })

    it('sin cobros previos (nada que reabrir): 0', () => {
      expect(decide(cuenta(), [], '10.00')).toEqual({ importe: '0', propina: '0', reabre: false })
    })
  })
})

/**
 * D649 (Codex apps-viejas r3): el POS (ANDROID ≥2.25.22, WINDOWS, iOS 1.15.x) descarta una respuesta de la venta de vales con la
 * MISMA versión y menos pagado, y una «sin abono» (ni PARTIALLY_PAID ni pagado > 0) sobre una copia «con abono». Al reabrir, la
 * sesión de vales viva de la cuenta sube su versión y, si seguía MATERIALIZED (el abono entró por otro canal), dice PARTIALLY_PAID.
 */
describe('fijarSaldoReabiertoEnTx — la sesión de vales viva se entera (D649)', () => {
  const txFalso = (sesiones: Array<{ id: string; status: string }>, order = cuenta()) => ({
    order: {
      findFirst: jest.fn().mockResolvedValue({ ...order, thirdPartyCashDue: null, cashTipDue: null, payments: [cobro('50.00')] }),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: { update: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue(sesiones),
    areaTicketCheckoutSession: { update: jest.fn().mockResolvedValue({}) },
  })
  const fijar = (tx: ReturnType<typeof txFalso>) =>
    fijarSaldoReabiertoEnTx(tx as unknown as TxConReintento, {
      venueId: 'venue-1',
      orderId: 'order-1',
      refundPaymentId: 'refund-1',
      devueltoImporte: d('50.00'),
      devueltoPropina: d('0.00'),
    })

  it('🔴 sesión MATERIALIZED (abono por otro canal): sube la versión y pasa a PARTIALLY_PAID, en la misma transacción', async () => {
    const tx = txFalso([{ id: 'ses-1', status: 'MATERIALIZED' }])

    const r = await fijar(tx)

    expect(tx.areaTicketCheckoutSession.update).toHaveBeenCalledWith({
      where: { id: 'ses-1' },
      data: { version: { increment: 1 }, status: 'PARTIALLY_PAID' },
    })
    expect(r.sesionDeVales).toEqual({ id: 'ses-1', estadoAntes: 'MATERIALIZED' })
    // Se toma sin esperar (la cuenta ya está bloqueada; la jerarquía es sesión → vales → cuenta) y sólo la de ESTA cuenta.
    const [sql, ...valores] = tx.$queryRaw.mock.calls[0]
    expect((sql as string[]).join('?')).toMatch(/FOR UPDATE SKIP LOCKED/)
    expect(valores).toEqual(expect.arrayContaining(['order-1', 'venue-1']))
  })

  it('sesión PARTIALLY_PAID (abono por la sesión): sólo sube la versión', async () => {
    const tx = txFalso([{ id: 'ses-1', status: 'PARTIALLY_PAID' }])

    await fijar(tx)

    expect(tx.areaTicketCheckoutSession.update).toHaveBeenCalledWith({ where: { id: 'ses-1' }, data: { version: { increment: 1 } } })
  })

  it('cuenta sin sesión de vales viva: no escribe ninguna sesión ni pide subirla después', async () => {
    const tx = txFalso([])

    const r = await fijar(tx)

    expect(r.reabre).toBe(true)
    expect(tx.areaTicketCheckoutSession.update).not.toHaveBeenCalled()
    expect(r.sesionDeVales).toBeUndefined()
    expect(r.sesionDeValesOcupada).toBeUndefined()
  })

  it('🔴 segunda vuelta: la sesión viva está TOMADA por otra caja: no la espera ni la escribe, y le dice a quien llama cuál subir tras el commit', async () => {
    const tx = txFalso([])
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'ses-1' }])

    const r = await fijar(tx)

    expect(r.reabre).toBe(true)
    expect(tx.areaTicketCheckoutSession.update).not.toHaveBeenCalled()
    expect(r.sesionDeVales).toBeUndefined()
    expect(r.sesionDeValesOcupada).toBe('ses-1')
    // La segunda lectura sólo pregunta si existe: sin candado (esperarlo cruzaría sesión → vales → cuenta).
    const [sql, ...valores] = tx.$queryRaw.mock.calls[1]
    expect((sql as string[]).join('?')).not.toMatch(/FOR (NO KEY )?UPDATE|FOR SHARE/)
    expect(valores).toEqual(expect.arrayContaining(['order-1', 'venue-1']))
  })

  it('si no reabre (venta cerrada), ni busca la sesión', async () => {
    const tx = txFalso([{ id: 'ses-1', status: 'MATERIALIZED' }], cuenta({ paymentStatus: 'PAID' }))

    const r = await fijar(tx)

    expect(r.reabre).toBe(false)
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.areaTicketCheckoutSession.update).not.toHaveBeenCalled()
  })
})

/**
 * D649 segunda vuelta (Codex apps-viejas r4): la sesión que estaba tomada se sube DESPUÉS del commit del reembolso, ya sin la cuenta,
 * esperando su candado como cualquiera. Una sola subida por llamada (la MATERIALIZED dice PARTIALLY_PAID) y nunca lanza: el
 * reembolso ya está hecho.
 */
describe('subirVersionDeValesTrasCommit', () => {
  const sesion = prismaMock.areaTicketCheckoutSession

  beforeEach(() => {
    sesion.updateMany.mockReset()
    sesion.updateMany.mockResolvedValue({ count: 0 })
  })

  it('🔴 sube la versión de la sesión viva de ESTE negocio; si seguía MATERIALIZED, además dice PARTIALLY_PAID', async () => {
    await subirVersionDeValesTrasCommit({ venueId: 'venue-1', sessionId: 'ses-1' })

    expect(sesion.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: 'ses-1', venueId: 'venue-1', status: { in: ['PARTIALLY_PAID', 'PAYMENT_PENDING', 'RECONCILIATION_REQUIRED'] } },
          data: { version: { increment: 1 } },
        },
      ],
      [
        {
          where: { id: 'ses-1', venueId: 'venue-1', status: 'MATERIALIZED' },
          data: { version: { increment: 1 }, status: 'PARTIALLY_PAID' },
        },
      ],
    ])
  })

  it('si la primera ya la subió, la segunda no la encuentra (el orden evita subirla dos veces)', async () => {
    sesion.updateMany.mockResolvedValueOnce({ count: 1 })

    await subirVersionDeValesTrasCommit({ venueId: 'venue-1', sessionId: 'ses-1' })

    expect(sesion.updateMany).toHaveBeenCalledTimes(1)
  })

  it('nunca lanza: el reembolso ya se confirmó', async () => {
    sesion.updateMany.mockRejectedValueOnce(new Error('la base se cayó'))

    await expect(subirVersionDeValesTrasCommit({ venueId: 'venue-1', sessionId: 'ses-1' })).resolves.toBeUndefined()
  })
})
