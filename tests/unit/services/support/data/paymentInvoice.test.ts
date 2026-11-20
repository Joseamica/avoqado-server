/**
 * C7 · «Si la venta de ese cobro tiene factura»: el renglón del catálogo, la lectura (con los servicios del panel de mentira) y las
 * plantillas del plan, sin base. Lo que pasa con la base de verdad (el estado igual que el panel, la factura global, el aislamiento,
 * los candados, el router con un folio) está en `tests/integration/support/data/paymentInvoice.integration.test.ts`.
 */
jest.mock('@/services/dashboard/paymentByAmount.dashboard.service', () => ({
  findPaymentsByAmount: jest.fn(),
  invoiceStateOfOrders: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import { findPaymentsByAmount, invoiceStateOfOrders, type PaymentByAmountRow } from '@/services/dashboard/paymentByAmount.dashboard.service'
import { MINDFORM_NEW_VENUE_ID } from '@/services/legacy/qrPayments.legacy.service'
// La capacidad primero, a propósito: carga sola, sin pasar por el catálogo (C6 r1, el ciclo roto)
import { paymentInvoice } from '@/services/support/data/capabilities/paymentInvoice'
import { DATA_CAPABILITIES, type DataRequest, type DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'
import { paymentParams, type PaymentParams } from '@/services/support/data/paymentText'
import { SUPPORT_DATA_OMITTED } from '@/services/support/data/texts'

const byAmount = findPaymentsByAmount as jest.Mock
const invoices = invoiceStateOfOrders as jest.Mock
const scope: DataScope = {
  venueId: 'ckq7z1x2y0000abcd1234efgh',
  organizationId: 'org',
  venueName: 'Flautas Coyoacán',
  timezone: 'America/Mexico_City',
  day: '2026-11-12',
  kycVerified: true,
  now: new Date('2026-11-12T20:32:00Z'), // jueves 12-nov, 14:32 en la CDMX
  rows: 5,
  openOrdersDays: 7,
  depositGroups: 2000,
  depositTimeoutMs: 3000,
}
const at = (hhmm: string, day = 12) => new Date(`2026-11-${day}T${hhmm}:00-06:00`)
const REQUEST: DataRequest = { capability: 'payment_invoice', day: 'today', amount: '935', time: '14:00', otherVenue: false }
const MESSAGE = '¿Ya tiene factura la venta del cobro de 935 de hoy a las 14:00?'
const params = (over: Partial<DataRequest> = {}, message = MESSAGE): PaymentParams => {
  const out = paymentInvoice.params({ ...REQUEST, ...over }, message, scope)
  if (!out.ok) throw new Error(out.refusal)
  return out.value
}
const payment = (over: Partial<PaymentByAmountRow> = {}): PaymentByAmountRow => ({
  createdAt: at('13:52'),
  amount: new Prisma.Decimal('935'),
  tipAmount: new Prisma.Decimal('0'),
  method: 'CREDIT_CARD',
  cardBrand: 'VISA',
  last4: '4242',
  tenderSystemKind: null,
  status: 'COMPLETED',
  orderId: 'order-1',
  ...over,
})
type Read = Awaited<ReturnType<typeof paymentInvoice.read>>
type Invoice = Read['rows'][number]['invoice']
const row = (invoice: Invoice, over: Partial<PaymentByAmountRow> = {}) => ({ ...payment(over), invoice })
/** El texto, con el cotejo pasado: una plantilla que no lo pasa nunca sale. */
const say = (found: Partial<Read>, p: PaymentParams = params(), s: DataScope = scope) => {
  const rows = found.rows ?? []
  const rendered = paymentInvoice.render(s, p, { total: rows.length, legacyQr: false, ...found, rows })
  expect(checkRendered(rendered, s.timezone)).toBe(true)
  return rendered.text
}

beforeEach(() => {
  byAmount.mockReset()
  invoices.mockReset()
})

it('the capability loads on its own and the catalog registers it in its place, after find_payment', () => {
  jest.isolateModules(() => {
    const alone =
      require('@/services/support/data/capabilities/paymentInvoice') as typeof import('@/services/support/data/capabilities/paymentInvoice')
    const catalog = require('@/services/support/data/catalog') as typeof import('@/services/support/data/catalog')
    expect(catalog.DATA_CAPABILITIES.payment_invoice).toBe(alone.paymentInvoice)
  })
  const keys = Object.keys(DATA_CAPABILITIES)
  expect(keys.indexOf('payment_invoice')).toBe(keys.indexOf('find_payment') + 1)
})

it('the row of the catalog: its texts, the permissions and the gate of the sales list with invoices, no role', () => {
  expect(paymentInvoice).toMatchObject({
    key: 'payment_invoice',
    label: 'si la venta de ese cobro tiene factura',
    object: 'si la venta de ese cobro tiene factura',
    aiHint: 'Si la venta de un cobro ya tiene factura. Se identifica por el monto y la hora del cobro, de hoy o de ayer; nunca por folio.',
    permissions: ['orders:read', 'cfdi:view'],
    gate: { featureCode: 'CFDI', gateKind: 'FEATURE', refusal: 'PLAN_INVOICES' },
  })
  expect(paymentInvoice.roles).toBeUndefined()
  // Los parámetros son los de «buscar un cobro» (C2), con sus negativas: el mismo módulo, no una copia
  expect(paymentInvoice.params).toBe(paymentParams)
})

it.each<[string, Partial<DataRequest>, string, string]>([
  ['day other → PARAM_DAY', { day: 'other' }, MESSAGE, 'PARAM_DAY'],
  [
    '«¿Ya está facturada la venta de la mesa 5?» (no amount) → PARAM_AMOUNT',
    { amount: null, time: null },
    '¿Ya está facturada la venta de la mesa 5?',
    'PARAM_AMOUNT',
  ],
  ['a time that is not in the message → PARAM_TIME', {}, '¿Ya tiene factura la venta del cobro de 935 de hoy?', 'PARAM_TIME'],
])('params: %s', (_name, over, message, refusal) =>
  expect(paymentInvoice.params({ ...REQUEST, ...over }, message, scope)).toEqual({ ok: false, refusal }),
)

describe('read', () => {
  it('asks the panel for its venue, the amount, the windows and 5 (the rule of this capability, not scope.rows), then the invoice state of the distinct sales', async () => {
    byAmount.mockResolvedValue({ total: 2, rows: [payment({ orderId: 'a' }), payment({ orderId: 'b', createdAt: at('14:05') })] })
    invoices.mockResolvedValue(
      new Map([
        ['a', 'VIGENTE'],
        ['b', null],
      ]),
    )
    const p = params()
    const found = await paymentInvoice.read({ ...scope, rows: 1 }, p)
    expect(byAmount.mock.calls).toEqual([[scope.venueId, { amount: p.amount, windows: p.windows, take: 5 }]])
    expect(invoices.mock.calls).toEqual([[scope.venueId, ['a', 'b']]])
    expect(found).toEqual({
      total: 2,
      rows: [
        { ...payment({ orderId: 'a' }), invoice: 'VIGENTE' },
        { ...payment({ orderId: 'b', createdAt: at('14:05') }), invoice: 'NONE' },
      ],
      legacyQr: false,
    })
  })

  it('two payments of the SAME sale: the sale is asked once, and both payments stay, in the order of the read, each with that state', async () => {
    const card = payment({ createdAt: at('13:52') })
    const cash = payment({ createdAt: at('14:05'), method: 'CASH', cardBrand: null, last4: null })
    byAmount.mockResolvedValue({ total: 2, rows: [cash, card] })
    invoices.mockResolvedValue(new Map([['order-1', 'EN_CANCELACION']]))
    const found = await paymentInvoice.read(scope, params())
    expect(invoices.mock.calls).toEqual([[scope.venueId, ['order-1']]])
    expect(found.rows).toEqual([
      { ...cash, invoice: 'EN_CANCELACION' },
      { ...card, invoice: 'EN_CANCELACION' },
    ])
  })

  it('more than five payments: no invoice is read and no payment is chosen', async () => {
    byAmount.mockResolvedValue({ total: 6, rows: Array.from({ length: 5 }, (_, i) => payment({ orderId: `o${i}` })) })
    expect(await paymentInvoice.read(scope, params())).toEqual({ total: 6, rows: [], legacyQr: false })
    expect(invoices).not.toHaveBeenCalled()
  })

  it('a payment without a sale is NO_SALE and its sale is not asked; the bridge venue says so', async () => {
    byAmount.mockResolvedValue({ total: 1, rows: [payment({ orderId: null })] })
    invoices.mockResolvedValue(new Map())
    const found = await paymentInvoice.read({ ...scope, venueId: MINDFORM_NEW_VENUE_ID }, params())
    expect(found).toEqual({ total: 1, rows: [{ ...payment({ orderId: null }), invoice: 'NO_SALE' }], legacyQr: true })
    expect(invoices.mock.calls).toEqual([[MINDFORM_NEW_VENUE_ID, []]])
  })
})

describe('render (the templates of the plan)', () => {
  const one = 'Cobro de exactamente $935.00 hoy a las 13:52 (Visa terminación 4242 · Completado) en Flautas Coyoacán (corte 14:32): '
  it.each<[Invoice, string]>([
    ['VIGENTE', 'su venta ya tiene factura.'],
    ['NONE', 'su venta no tiene factura.'],
    ['EN_CANCELACION', 'la factura de su venta está en cancelación.'],
    ['NO_SALE', 'ese cobro no está ligado a una venta.'],
  ])('one payment, %s', (invoice, end) => expect(say({ rows: [row(invoice)] })).toBe(`${one}${end}`))

  it('one payment of yesterday with cash: «ayer a las 01:52 (Efectivo · Completado)»', () =>
    expect(
      say(
        { rows: [row('NONE', { createdAt: at('01:52', 11), method: 'CASH', cardBrand: null, last4: null })] },
        params({ day: 'yesterday', time: 'a las 2' }, '¿Ya tiene factura la venta del cobro de 935 de ayer a las 2?'),
      ),
    ).toBe(
      'Cobro de exactamente $935.00 ayer a las 01:52 (Efectivo · Completado) en Flautas Coyoacán (corte 14:32): su venta no tiene factura.',
    ))

  it('two to five: the header with the count and one line per payment with its hour, its payment form and its state; none is chosen', () =>
    expect(
      say({
        rows: [
          row('NONE', { createdAt: at('14:05'), method: 'CASH', cardBrand: null, last4: null }),
          row('VIGENTE'),
          row('EN_CANCELACION', {
            createdAt: at('13:45'),
            method: 'OTHER',
            cardBrand: null,
            last4: null,
            tenderSystemKind: 'STORE_CREDIT',
          }),
          row('NO_SALE', { createdAt: at('13:31'), cardBrand: 'MASTERCARD', last4: '5555', status: 'REFUNDED' }),
        ],
      }),
    ).toBe(
      [
        'Cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 4',
        '14:05 · Efectivo · Completado · sin factura',
        '13:52 · Visa terminación 4242 · Completado · ya tiene factura',
        '13:45 · Saldo a favor · Completado · factura en cancelación',
        '13:31 · Mastercard terminación 5555 · Reembolsado · sin venta ligada',
      ].join('\n'),
    ))

  it('two payments of the same sale: both lines, with the same state (no line is merged)', () =>
    expect(say({ rows: [row('VIGENTE', { createdAt: at('14:05'), method: 'CASH', cardBrand: null, last4: null }), row('VIGENTE')] })).toBe(
      [
        'Cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 2',
        '14:05 · Efectivo · Completado · ya tiene factura',
        '13:52 · Visa terminación 4242 · Completado · ya tiene factura',
      ].join('\n'),
    ))

  // C7 r1: Pagos lista también los intentos rechazados (y los reembolsados): cada renglón dice su estado, como en C2
  it('a declined attempt and its approved retry of the same sale: two lines, each with its status (C7 r1)', () =>
    expect(say({ rows: [row('VIGENTE', { createdAt: at('13:55') }), row('VIGENTE', { status: 'FAILED' })] })).toBe(
      [
        'Cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 2',
        '13:55 · Visa terminación 4242 · Completado · ya tiene factura',
        '13:52 · Visa terminación 4242 · Fallido · ya tiene factura',
      ].join('\n'),
    ))

  it.each<[PaymentByAmountRow['status'], string]>([
    ['FAILED', 'Fallido'],
    ['PROCESSING', 'En proceso'],
    ['REFUNDED', 'Reembolsado'],
  ])('a lone %s payment says its status in its sentence (C7 r1)', (status, word) =>
    expect(say({ rows: [row('NONE', { status })] })).toBe(
      `Cobro de exactamente $935.00 hoy a las 13:52 (Visa terminación 4242 · ${word}) en Flautas Coyoacán (corte 14:32): su venta no tiene factura.`,
    ),
  )

  it('a custom tender says «Otro» and store credit «Saldo a favor», as Pagos of the panel (C7 r1)', () => {
    const other = { method: 'OTHER' as const, cardBrand: null, last4: null }
    expect(say({ rows: [row('NONE', other)] })).toBe(
      'Cobro de exactamente $935.00 hoy a las 13:52 (Otro · Completado) en Flautas Coyoacán (corte 14:32): su venta no tiene factura.',
    )
    expect(say({ rows: [row('NONE', { ...other, tenderSystemKind: 'STORE_CREDIT' })] })).toBe(
      'Cobro de exactamente $935.00 hoy a las 13:52 (Saldo a favor · Completado) en Flautas Coyoacán (corte 14:32): su venta no tiene factura.',
    )
  })

  it('a status out of the list throws (the answer is CHECK_FAILED), never the raw key', () =>
    expect(() =>
      paymentInvoice.render(scope, params(), { total: 1, rows: [row('NONE', { status: 'PENDING' })], legacyQr: false }),
    ).toThrow())

  it('five payments and the bridge note: 7 lines at most', () => {
    const lines = say({ rows: Array.from({ length: 5 }, () => row('NONE')), legacyQr: true }).split('\n')
    expect(lines).toHaveLength(7)
    expect(lines[6]).toBe('No incluye los cobros QR del sistema anterior.')
  })

  it('more than five: «Hay 6 cobros… Dime la hora más exacta y te digo el de ese cobro.»', () =>
    expect(say({ total: 6, rows: [] })).toBe(
      'Hay 6 cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32). Dime la hora más exacta y te digo el de ese cobro.',
    ))

  it('zero rows: the sentence of the plan, whole (Review Focus 2)', () =>
    expect(say({ total: 0, rows: [] })).toBe(
      'No encontré cobros de exactamente $935.00 (contando la propina) hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32). Si la cuenta se pagó en partes, dime el monto de una de ellas.',
    ))

  it('two windows say «entre 01:30 y 02:30 o entre 13:30 y 14:30»; without a time, only the day', () => {
    const twice = params({ time: 'a las 2' }, '¿Ya tiene factura la venta del cobro de 935 de hoy a las 2?')
    expect(say({ rows: [] }, twice)).toContain('hoy entre 01:30 y 02:30 o entre 13:30 y 14:30 en Flautas Coyoacán')
    expect(say({ total: 6, rows: [] }, params({ time: null }, '¿Ya tiene factura la venta del cobro de 935 de hoy?'))).toBe(
      'Hay 6 cobros de exactamente $935.00 hoy en Flautas Coyoacán (corte 14:32). Dime la hora más exacta y te digo el de ese cobro.',
    )
  })

  it.each<[string, Partial<Read>]>([
    ['zero rows', { rows: [] }],
    ['one payment', { rows: [row('VIGENTE')] }],
    ['more than five', { total: 6, rows: [] }],
  ])('the bridge venue: the last line says it does not include the old QR payments (%s)', (_name, found) =>
    expect(
      say({ ...found, legacyQr: true })
        .split('\n')
        .slice(-1),
    ).toEqual(['No incluye los cobros QR del sistema anterior.']),
  )

  it('the venue comes out through t.text: a name like a card number is omitted', () => {
    const text = say({ rows: [row('NONE')] }, params(), { ...scope, venueName: 'Sucursal 4111111111111111' })
    expect(text).toBe(
      `Cobro de exactamente $935.00 hoy a las 13:52 (Visa terminación 4242 · Completado) en ${SUPPORT_DATA_OMITTED} (corte 14:32): su venta no tiene factura.`,
    )
  })

  it('no template has a folio hole: every hole is the amount, an hour, a count, the last 4 or the venue (case 42)', () => {
    const texts = new Set(['Flautas Coyoacán'])
    const cases: Partial<Read>[] = [
      { rows: [] },
      { total: 6, rows: [] },
      { rows: [row('VIGENTE')] },
      { rows: [row('NONE', { method: 'OTHER', cardBrand: null, last4: null, tenderSystemKind: 'STORE_CREDIT' }), row('NO_SALE')] },
    ]
    for (const found of cases) {
      const rows = found.rows ?? []
      const { figures } = paymentInvoice.render(scope, params(), { total: rows.length, legacyQr: true, ...found, rows })
      for (const figure of figures) {
        expect(['money', 'time', 'count', 'last4', 'text']).toContain(figure.kind)
        if (figure.kind === 'text') expect(texts.has(figure.value as string)).toBe(true)
      }
    }
  })
})
