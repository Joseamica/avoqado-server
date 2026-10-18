/**
 * D2 (Codex r1 #2 y r2 #1): la evidencia de que la PRIMERA factura de una suscripción quedó pagada por el monto que el
 * cliente consintió. Se prueba con el lector REAL de cobertura (`hybridFundingGraph`), el mismo con que la regla común
 * valida el saldo a favor: sólo Stripe y prisma están simulados (formas de `hybridFundingGraph.test.ts`).
 *
 * 🔴 Nunca `amount_paid`: Stripe descuenta primero el saldo a favor, así que $10 = $4 de saldo + $6 de tarjeta es un pago
 * completo con `amount_paid: 600`.
 */
import { prismaMock } from '../../../__helpers__/setup'

let facturas: any[] = []
const pagos = new Map<string, any[]>()
const origenes = new Map<string, any>()
/** Los movimientos del saldo del cliente, del más viejo al más nuevo (Stripe los devuelve al revés). */
let movimientos: any[] = []
let pagosIncompletos = false
const mockListaDeFacturas = jest.fn(async (_p: unknown) => ({ data: facturas, has_more: false }))
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    invoices: { list: (p: unknown) => mockListaDeFacturas(p), retrieve: async (id: string) => origenes.get(id) },
    invoicePayments: { list: async ({ invoice }: any) => ({ data: pagos.get(invoice) ?? [], has_more: pagosIncompletos }) },
    creditNotes: { list: async () => ({ data: [], has_more: false }) },
    customers: { listBalanceTransactions: async () => ({ data: [...movimientos].reverse(), has_more: false }) },
  },
  STRIPE_DENTRO_DEL_CANDADO: {},
}))
import { primerCobroCubierto } from '@/services/onboarding/primerCobroPagado'

const LISTA = 115884

/** Un pago con tarjeta de una factura, con la forma que lee `invoiceFunding`. */
function pagoConTarjeta(invoiceId: string, monto: number, devuelto = 0) {
  return {
    status: 'paid',
    currency: 'mxn',
    amount_paid: monto,
    payment: {
      type: 'charge',
      charge: { id: `ch_${invoiceId}`, paid: true, currency: 'mxn', amount: monto, amount_refunded: devuelto, disputed: false },
    },
  }
}

/** Una factura de la suscripción: `tarjeta` = lo cobrado a la tarjeta, `saldo` = el saldo a favor aplicado. */
function factura(o: { id?: string; total: number; tarjeta: number; saldo?: number; status?: string; billing_reason?: string }) {
  const { id = 'in_1', total, tarjeta, saldo = 0, status = 'paid', billing_reason = 'subscription_create' } = o
  pagos.set(id, tarjeta > 0 ? [pagoConTarjeta(id, tarjeta)] : [])
  return {
    id,
    customer: 'cus',
    currency: 'mxn',
    status,
    billing_reason,
    total,
    amount_paid: tarjeta,
    starting_balance: saldo ? -saldo : 0,
    ending_balance: 0,
    post_payment_credit_notes_amount: 0,
  }
}

/** El abono de `saldo` al cliente y su uso en la factura `in_1`. `origen`: la factura de donde salió el abono. */
function saldoAplicado(saldo: number, origen?: string) {
  movimientos = [
    {
      id: 'cbtxn_abono',
      customer: 'cus',
      currency: 'mxn',
      type: origen ? 'invoice_overpaid' : 'adjustment',
      amount: -saldo,
      ending_balance: -saldo,
      invoice: origen ?? null,
    },
    { id: 'cbtxn_uso', customer: 'cus', currency: 'mxn', type: 'applied_to_invoice', amount: saldo, ending_balance: 0, invoice: 'in_1' },
  ]
}

beforeEach(() => {
  facturas = []
  pagos.clear()
  origenes.clear()
  movimientos = []
  pagosIncompletos = false
  prismaMock.hybridPurchase.findUnique.mockResolvedValue(null)
})

describe('primerCobroCubierto (lector REAL de cobertura)', () => {
  it('P1: tarjeta de $10 sobre un total de $10 ⇒ cubierto', async () => {
    facturas = [factura({ total: 1000, tarjeta: 1000 })]
    await expect(primerCobroCubierto('venue-1', 'sub_3ds', 1000)).resolves.toBe(true)
  })

  it('🔴 P2: $4 de saldo a favor válido + $6 de tarjeta sobre $10 (amount_paid: 600) ⇒ cubierto', async () => {
    facturas = [factura({ total: 1000, tarjeta: 600, saldo: 400 })]
    saldoAplicado(400)
    await expect(primerCobroCubierto('venue-1', 'sub_3ds', 1000)).resolves.toBe(true)
  })

  it('🔴 P3: total de $0 cuando se prometieron $10 ⇒ NO cubierto', async () => {
    facturas = [factura({ total: 0, tarjeta: 0 })]
    await expect(primerCobroCubierto('venue-1', 'sub_3ds', 1000)).resolves.toBe(false)
  })

  it('P4: la primera factura sigue ABIERTA ⇒ NO cubierto', async () => {
    facturas = [factura({ total: 1000, tarjeta: 0, status: 'open' })]
    await expect(primerCobroCubierto('venue-1', 'sub_3ds', 1000)).resolves.toBe(false)
  })

  it('P5: se cobró el precio de lista ($1,158.84: el cupón no se aplicó) ⇒ NO cubierto', async () => {
    facturas = [factura({ total: LISTA, tarjeta: LISTA })]
    await expect(primerCobroCubierto('venue-1', 'sub_3ds', 1000)).resolves.toBe(false)
  })

  it('🔴 P6: el saldo aplicado sale de una factura que se reembolsó ⇒ NO cubierto', async () => {
    facturas = [factura({ total: 1000, tarjeta: 600, saldo: 400 })]
    origenes.set('in_origen', factura({ id: 'in_origen', total: 400, tarjeta: 400, billing_reason: 'manual' }))
    pagos.set('in_origen', [pagoConTarjeta('in_origen', 400, 400)])
    saldoAplicado(400, 'in_origen')
    await expect(primerCobroCubierto('venue-1', 'sub_3ds', 1000)).resolves.toBe(false)
  })

  it('P7: el lector no puede verificar (pagos de la factura truncados) ⇒ lanza HYBRID_FUNDING_UNVERIFIED', async () => {
    facturas = [factura({ total: 1000, tarjeta: 1000 })]
    pagosIncompletos = true
    await expect(primerCobroCubierto('venue-1', 'sub_3ds', 1000)).rejects.toMatchObject({ code: 'HYBRID_FUNDING_UNVERIFIED' })
  })

  // Ruling 6a: la regla hermana de la entrega híbrida (`hybridPeriodInvalid`) da por inválido un periodo devuelto.
  it.each([
    ['en parte ($3 de $10)', 300],
    ['completo', 1000],
  ])('🔴 P9: el primer cobro se devolvió %s ⇒ NO cubierto', async (_caso, devuelto) => {
    facturas = [factura({ total: 1000, tarjeta: 1000 })]
    pagos.set('in_1', [pagoConTarjeta('in_1', 1000, devuelto)])
    await expect(primerCobroCubierto('venue-1', 'sub_3ds', 1000)).resolves.toBe(false)
  })

  it('P8: toma la factura subscription_create aunque la primera de la lista sea una renovación; sin ella, lanza', async () => {
    const renovacion = factura({ id: 'in_2', total: LISTA, tarjeta: LISTA, billing_reason: 'subscription_cycle' })
    facturas = [renovacion, factura({ total: 1000, tarjeta: 1000 })]
    await expect(primerCobroCubierto('venue-1', 'sub_3ds', 1000)).resolves.toBe(true)
    expect(mockListaDeFacturas).toHaveBeenCalledWith({ subscription: 'sub_3ds', limit: 100 })

    facturas = [renovacion]
    await expect(primerCobroCubierto('venue-1', 'sub_3ds', 1000)).rejects.toThrow('no se pudo verificar')
  })
})
