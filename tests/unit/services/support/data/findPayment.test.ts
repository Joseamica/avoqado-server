/**
 * C2 · «Buscar un cobro por su monto»: las plantillas del plan y los textos de un cobro (`paymentText.ts`, que comparte con C7), sin
 * base. Lo que pasa con la base de verdad (la búsqueda, el aislamiento, el plan de ejecución, los candados) está en
 * `tests/integration/support/data/findPayment.integration.test.ts`.
 */
jest.mock('@/services/dashboard/paymentByAmount.dashboard.service', () => ({ findPaymentsByAmount: jest.fn() }))

import { Prisma } from '@prisma/client'
import { findPaymentsByAmount, type PaymentByAmountRow } from '@/services/dashboard/paymentByAmount.dashboard.service'
import { MINDFORM_NEW_VENUE_ID } from '@/services/legacy/qrPayments.legacy.service'
import { findPayment } from '@/services/support/data/capabilities/findPayment'
import type { DataRequest, DataScope } from '@/services/support/data/catalog'
import { checkRendered, template } from '@/services/support/data/check'
import { paymentFormLabel, paymentParams, paymentWindowsText, type PaymentParams } from '@/services/support/data/paymentText'

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
// T-F11b: el renglón fijo del «no encontré»: que no aparezca un cobro no prueba que no se cobró (la terminal se trabó o estuvo sin red).
const NOT_FOUND_CAUTION =
  'Que no aparezca no quiere decir que no se cobró: si la terminal se trabó o estuvo sin internet, el cobro puede llegar después. Antes de cobrar otra vez, revisa la terminal.'
const at = (hhmm: string, day = 12) => new Date(`2026-11-${day}T${hhmm}:00-06:00`)
const REQUEST: DataRequest = { capability: 'find_payment', day: 'today', amount: '935', time: '14:00', otherVenue: false }
const params = (over: Partial<DataRequest> = {}, message = '¿Entró un cobro de $935 hoy a las 14:00?'): PaymentParams => {
  const out = paymentParams({ ...REQUEST, ...over }, message, scope)
  if (!out.ok) throw new Error(out.refusal)
  return out.value
}
const row = (over: Partial<PaymentByAmountRow> = {}): PaymentByAmountRow => ({
  createdAt: at('13:52'),
  amount: new Prisma.Decimal('850'),
  tipAmount: new Prisma.Decimal('85'),
  method: 'CREDIT_CARD',
  cardBrand: 'VISA',
  last4: '4242',
  tenderSystemKind: null,
  status: 'COMPLETED',
  orderId: 'order',
  ...over,
})
const render = (p: PaymentParams, rows: PaymentByAmountRow[], total = rows.length, legacyQr = false) => {
  const rendered = findPayment.render(scope, p, { total, rows, legacyQr })
  expect(checkRendered(rendered, scope.timezone)).toBe(true)
  return rendered.text
}

it('the template of the plan, exactly, and it passes the check', () =>
  expect(render(params(), [row()])).toBe(
    [
      'Cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 1',
      '13:52 · $850.00 + propina $85.00 · Visa terminación 4242 · Completado',
    ].join('\n'),
  ))

it('two windows: «ayer entre 01:30 y 02:30 o entre 13:30 y 14:30»; the tip only when it is more than zero', () =>
  expect(
    render(params({ day: 'yesterday', time: 'a las 2' }, '¿Entró un cobro de 935 ayer a las 2?'), [
      row({
        createdAt: at('14:05', 11),
        amount: new Prisma.Decimal('935'),
        tipAmount: new Prisma.Decimal('0'),
        method: 'CASH',
        cardBrand: null,
        last4: null,
      }),
      row({ createdAt: at('01:52', 11), status: 'REFUNDED' }),
    ]),
  ).toBe(
    [
      'Cobros de exactamente $935.00 ayer entre 01:30 y 02:30 o entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 2',
      '14:05 · $935.00 · Efectivo · Completado',
      '01:52 · $850.00 + propina $85.00 · Visa terminación 4242 · Reembolsado',
    ].join('\n'),
  ))

it('zero rows: the sentence of the plan, whole (Review Focus 2)', () =>
  expect(render(params(), [])).toBe(
    [
      'No encontré cobros de exactamente $935.00 (contando la propina) hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32). Si fue con centavos u otra hora, escríbelo así.',
      NOT_FOUND_CAUTION,
    ].join('\n'),
  ))

it('without a time it says only the day; «y 2 más» and the bridge note go on one last line; 7 lines at most', () => {
  const lines = render(
    params({ time: null }, '¿Entró un cobro de $935 hoy?'),
    Array.from({ length: 5 }, () => row()),
    7,
    true,
  ).split('\n')
  expect(lines[0]).toBe('Cobros de exactamente $935.00 hoy en Flautas Coyoacán (corte 14:32): 7')
  expect(lines[6]).toBe('y 2 más; el resto está en el panel. No incluye los cobros QR del sistema anterior.')
  expect(lines).toHaveLength(7)
})

it('the bridge note also follows a zero-rows sentence, and alone when nothing is left out', () => {
  expect(render(params(), [], 0, true).split('\n').slice(1)).toEqual([NOT_FOUND_CAUTION, 'No incluye los cobros QR del sistema anterior.'])
  expect(render(params(), [row()], 1, true).split('\n')[2]).toBe('No incluye los cobros QR del sistema anterior.')
})

it.each<[string, Partial<PaymentByAmountRow>, string]>([
  ['a brand and its last 4', { cardBrand: 'MASTERCARD', last4: '5555' }, 'Mastercard terminación 5555'],
  ['a brand without a masked card', { cardBrand: 'AMERICAN_EXPRESS', last4: null }, 'American Express'],
  ['another brand', { cardBrand: 'DISCOVER', last4: '1117' }, 'Tarjeta terminación 1117'],
  ['no brand: the method', { cardBrand: null, last4: null, method: 'BANK_TRANSFER' }, 'Transferencia'],
  ['no brand, with a masked card: still the method', { cardBrand: null, last4: '4242', method: 'DEBIT_CARD' }, 'Tarjeta de débito'],
  // C7 r1: lo que dice Pagos del panel (`etiquetaDeMetodo.ts`): un tipo de pago propio es «Otro» y el saldo a favor, «Saldo a favor»
  ['a custom tender type (OTHER, no system kind): «Otro», as Pagos says', { cardBrand: null, last4: null, method: 'OTHER' }, 'Otro'],
  [
    'the gift card (system kind GIFT_CARD): «Otro», as Pagos says',
    { cardBrand: null, last4: null, method: 'OTHER', tenderSystemKind: 'GIFT_CARD' },
    'Otro',
  ],
  [
    'store credit (system kind STORE_CREDIT): «Saldo a favor»',
    { cardBrand: null, last4: null, method: 'OTHER', tenderSystemKind: 'STORE_CREDIT' },
    'Saldo a favor',
  ],
])('paymentFormLabel: %s', (_name, over, label) => expect(paymentFormLabel(template(scope.timezone), row(over))).toBe(label))

it('a row of a payment with store credit says «Saldo a favor», and one with a custom tender «Otro» (C7 r1)', () => {
  const other = { method: 'OTHER' as const, cardBrand: null, last4: null }
  expect(
    render(params(), [row({ ...other, tenderSystemKind: 'STORE_CREDIT' }), row(other)])
      .split('\n')
      .slice(1),
  ).toEqual(['13:52 · $850.00 + propina $85.00 · Saldo a favor · Completado', '13:52 · $850.00 + propina $85.00 · Otro · Completado'])
})

it('an unknown status or method throws (the answer is CHECK_FAILED), never the raw key', () => {
  expect(() => findPayment.render(scope, params(), { total: 1, rows: [row({ status: 'PENDING' })], legacyQr: false })).toThrow()
  expect(() => paymentFormLabel(template(scope.timezone), row({ cardBrand: null, method: 'BARTER' as never }))).toThrow()
})

it('paymentWindowsText without a time says the day only', () =>
  expect(paymentWindowsText(template(scope.timezone), params({ day: null, time: null }, '¿Entró un cobro de $935?'))).toBe('hoy'))

it.each<[string, Partial<DataRequest>, string, string]>([
  ['day other, before anything else → PARAM_DAY', { day: 'other', amount: null }, '¿cobro?', 'PARAM_DAY'],
  ['no amount in the message → PARAM_AMOUNT', {}, '¿Entró un cobro hoy a las 14:00?', 'PARAM_AMOUNT'],
  ['a time not in the message → PARAM_TIME', {}, '¿Entró un cobro de $935 hoy?', 'PARAM_TIME'],
  // Ronda 1: el orden es día → monto → hora; con el monto Y la hora mal, gana el monto
  ['an amount and a time not in the message → PARAM_AMOUNT', { time: '15:00' }, '¿Entró un cobro de $900 hoy?', 'PARAM_AMOUNT'],
  // C7 r1: el número de la mesa no es un monto
  ['«la mesa 5» read as $5 → PARAM_AMOUNT', { amount: '5', time: null }, '¿Entró el cobro de la mesa 5?', 'PARAM_AMOUNT'],
])('paymentParams: %s', (_name, over, message, refusal) =>
  expect(paymentParams({ ...REQUEST, ...over }, message, scope)).toEqual({ ok: false, refusal }),
)

// T-B48: sin excusa del monto en la hora. Un monto chico sin «$» junto a una hora pide reformular, como antes de C2; con «$» contesta.
it.each<[string, string, string]>([
  ['a small café amount without «$» next to the time', '20', '¿entró un cobro de 20 a las 2?'],
  ['Codex bloque 3 r1: the AI amount is the corrected hour', '3', 'cobré 850 a las 2, no, 3'],
  [
    'Codex bloque 3 r2: the amount in words is not read, and the AI takes the discarded hour',
    '3',
    '¿Entró el cobro de mil? Fue tipo 3, no, a las 2.',
  ],
])('T-B48: %s → PARAM_TIME', (_name, amount, message) =>
  expect(findPayment.params({ ...REQUEST, amount, time: 'a las 2' }, message, scope)).toEqual({ ok: false, refusal: 'PARAM_TIME' }),
)

it('T-B48: with «$» the small café amount next to the time answers', () => {
  const out = findPayment.params({ ...REQUEST, amount: '20', time: 'a las 2' }, '¿entró un cobro de $20 a las 2?', scope)
  if (!out.ok) throw new Error(out.refusal)
  expect([out.value.amount.toFixed(2), out.value.windows.length]).toEqual(['20.00', 2])
  expect(render(out.value, [])).toBe(
    [
      'No encontré cobros de exactamente $20.00 (contando la propina) hoy entre 01:30 y 02:30 o entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32). Si fue con centavos u otra hora, escríbelo así.',
      NOT_FOUND_CAUTION,
    ].join('\n'),
  )
})

describe('read', () => {
  const panel = findPaymentsByAmount as jest.Mock
  beforeEach(() => panel.mockReset())

  it('asks the panel for its venue, the amount, the windows and scope.rows, and says whether the venue is the bridge', async () => {
    panel.mockResolvedValue({ total: 0, rows: [] })
    const p = params()
    expect(await findPayment.read(scope, p)).toEqual({ total: 0, rows: [], legacyQr: false })
    expect(panel).toHaveBeenCalledWith(scope.venueId, { amount: p.amount, windows: p.windows, take: 5 })
    expect((await findPayment.read({ ...scope, venueId: MINDFORM_NEW_VENUE_ID }, p)).legacyQr).toBe(true)
  })
})
