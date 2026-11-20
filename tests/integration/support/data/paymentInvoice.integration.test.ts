/**
 * C7 · «Si la venta de ese cobro tiene factura» (la B): el cobro se busca como en C2 (monto, día y hora) y se dice si su venta tiene
 * factura, con la regla del listado de ventas del panel («Nueva factura»: individual, de ingreso, timbrada o en cancelación, y con una
 * sustitución manda la que no fue sustituida). Postgres de verdad (la base de la nube). Lo que vale para toda capacidad (venenos, logs,
 * candados, datos ajenos) lo prueba el barrido (`sweeps.integration.test.ts`). Las horas son fijas donde la respuesta depende del reloj:
 * el jueves 12-nov-2026 a las 14:32 de la CDMX.
 */
jest.mock('@/services/legacy/legacyPool', () => require('@tests/__helpers__/puenteQrLegacy').moduloLegacyPool)

import prisma from '@/utils/prismaClient'
import { invoiceStateOfOrders } from '@/services/dashboard/paymentByAmount.dashboard.service'
import { getOrders } from '@/services/dashboard/order.dashboard.service'
import * as legacy from '@/services/legacy/qrPayments.legacy.service'
import { prepareDataAnswer, type DataOutcome } from '@/services/support/data/answer.service'
import { paymentInvoice } from '@/services/support/data/capabilities/paymentInvoice'
import { dataCatalog, type DataCatalog, type DataRequest, type DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'
import { fmtTime } from '@/services/support/data/format'
import { SUPPORT_DATA_REFUSALS, supportDataNoPermission } from '@/services/support/data/texts'
import { tryRouteSupport } from '@/services/support/router.service'
import { SUPPORT_SENSITIVE } from '@/services/support/texts'
import { venueDayKey } from '@/utils/venueDateKeys'
import { puenteContesta } from '@tests/__helpers__/puenteQrLegacy'
import {
  clearInvoices,
  clearSales,
  earlierToday,
  seedDataFixture,
  seedGlobalInvoice,
  seedInvoice,
  seedPayment,
  spyQueries,
  type DataFixture,
} from '@tests/__helpers__/supportData'

const CDMX = 'America/Mexico_City'
const OBJECT = 'si la venta de ese cobro tiene factura'
const REQUEST: DataRequest = { capability: 'payment_invoice', day: 'today', amount: '935', time: null, otherVenue: false }
const MESSAGE = '¿Ya tiene factura la venta del cobro de $935 de hoy?'
const AT_14 = '¿Ya tiene factura la venta del cobro de 935 de hoy a las 14:00?'
/** El corte de los ejemplos del plan: jueves 12-nov-2026, 14:32 en la CDMX. */
const NOW = new Date('2026-11-12T20:32:00Z')
/** Una hora del 12-nov en la CDMX. */
const at = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00-06:00`)
const VISA = { cardBrand: 'VISA' as const, maskedPan: '411111******4242' }

let f: DataFixture
const allVenues = () => [f.northId, f.cancunId, f.emptyId, f.siblingId, f.foreignId]
beforeAll(async () => {
  f = await seedDataFixture('support-data-payment-invoice')
})
afterAll(() => f?.clean())
beforeEach(async () => {
  await f.reset()
  process.env.SUPPORT_DATA_ENABLED = 'true'
  await clearInvoices(allVenues())
  await clearSales(allVenues())
  await f.grant({ permissions: ['orders:read', 'cfdi:view'], features: ['CFDI'] })
  await f.unlock()
  puenteContesta()
})
afterEach(() => {
  delete process.env.SUPPORT_DATA_ROWS
  jest.restoreAllMocks()
})

/** La pregunta por el orquestador, con el reloj de verdad (el desbloqueo es de hoy), en la plática de la persona. */
const ask = async (over: Partial<DataRequest> = {}, message = MESSAGE, catalog?: DataCatalog, venueId = f.northId) =>
  prepareDataAnswer(
    { conversation: { ...(await f.conversation()), venueId }, request: { ...REQUEST, ...over }, message, now: new Date() },
    catalog,
  )
const answered = (out: DataOutcome) => {
  if (out.kind !== 'answer') throw new Error(`payment_invoice: ${out.text}`)
  return out.envelope.text
}
/** Un alcance armado a mano, con el reloj fijo de los ejemplos. */
const scopeFor = (venueId: string, now = NOW): DataScope => ({
  venueId,
  organizationId: f.orgId,
  venueName: 'Flautas Coyoacán',
  timezone: CDMX,
  day: venueDayKey(now, CDMX),
  kycVerified: true,
  now,
  rows: 5,
  openOrdersDays: 7,
  depositGroups: 2000,
  depositTimeoutMs: 3000,
})
/** La capacidad directa, sin los candados del orquestador: sus parámetros, su lectura y su plantilla, que tiene que pasar el cotejo. */
async function answerAt(over: Partial<DataRequest>, message: string, venueId = f.northId): Promise<string> {
  const scope = scopeFor(venueId)
  const params = paymentInvoice.params({ ...REQUEST, ...over }, message, scope)
  if (!params.ok) throw new Error(params.refusal)
  const rendered = paymentInvoice.render(scope, params.value, await paymentInvoice.read(scope, params.value))
  expect(checkRendered(rendered, CDMX)).toBe(true)
  return rendered.text
}
/** Un catálogo con la capacidad de verdad y su `read` espiado. */
const spiedCatalog = () => {
  const read = jest.fn(paymentInvoice.read)
  return { read, catalog: dataCatalog({ ...paymentInvoice, read }) }
}
/** Lo que el listado de ventas del panel («Nueva factura», `conFactura`) dice de esa venta. */
async function panelSays(venueId: string, orderId: string): Promise<'VIGENTE' | 'EN_CANCELACION' | null> {
  const { data } = await getOrders(venueId, 1, 100, undefined, { conFactura: true })
  const sale = (data as { id: string; facturada?: boolean; facturaEnCancelacion?: boolean }[]).find(o => o.id === orderId)
  if (!sale) throw new Error('the sale is not in the list of the panel')
  return sale.facturada ? 'VIGENTE' : sale.facturaEnCancelacion ? 'EN_CANCELACION' : null
}
/** Las consultas de `fn` a un modelo. */
async function queriesOf<T>(model: string, fn: () => Promise<T>): Promise<{ result: T; args: unknown[] }> {
  const spy = spyQueries()
  try {
    const result = await fn()
    return { result, args: spy.calls.filter(c => c.model === model).map(c => c.args) }
  } finally {
    spy.restore()
  }
}

const ONE = 'Cobro de exactamente $935.00 hoy a las 13:52 (Visa terminación 4242 · Completado) en Flautas Coyoacán (corte 14:32): '

describe('the state of ONE sale is the one of the sales list of the panel (case 41)', () => {
  it.each<[string, (orderId: string) => Promise<unknown>, string, 'VIGENTE' | 'EN_CANCELACION' | null]>([
    ['stamped', orderId => seedInvoice(f.northId, orderId), 'su venta ya tiene factura.', 'VIGENTE'],
    [
      'with its cancellation requested',
      orderId => seedInvoice(f.northId, orderId, { cancelStatus: 'REQUESTED' }),
      'la factura de su venta está en cancelación.',
      'EN_CANCELACION',
    ],
    [
      'CANCEL_REQUESTED',
      orderId => seedInvoice(f.northId, orderId, { status: 'CANCEL_REQUESTED', cancelStatus: 'REQUESTED' }),
      'la factura de su venta está en cancelación.',
      'EN_CANCELACION',
    ],
    ['without an invoice', async () => undefined, 'su venta no tiene factura.', null],
    [
      'replaced by another stamped one',
      async orderId => {
        const original = await seedInvoice(f.northId, orderId, { status: 'CANCEL_REQUESTED', cancelStatus: 'REQUESTED' })
        await seedInvoice(f.northId, orderId, { replacesCfdiId: original })
      },
      'su venta ya tiene factura.',
      'VIGENTE',
    ],
    [
      'cancelled (the PAC accepted it)',
      orderId => seedInvoice(f.northId, orderId, { status: 'CANCELLED', cancelStatus: 'ACCEPTED' }),
      'su venta no tiene factura.',
      null,
    ],
    [
      'only a stamped credit note (EGRESO)',
      orderId => seedInvoice(f.northId, orderId, { type: 'EGRESO' }),
      'su venta no tiene factura.',
      null,
    ],
    [
      // El panel no la marca «Ya facturada» y deja facturarla aparte (sale de la global): la B dice lo mismo. Con `orderId` puesto a
      // propósito, para que la cuente sólo el filtro de la regla y no la falta del vínculo.
      'only in a stamped GLOBAL invoice (its manifest, and even with the sale on the row)',
      async orderId => {
        await seedGlobalInvoice(f.northId, [orderId])
        await seedInvoice(f.northId, orderId, { isGlobal: true })
      },
      'su venta no tiene factura.',
      null,
    ],
    // C7 r1: estados que faltaban, cada uno contra el panel
    [
      'its only CFDI still STAMPING',
      orderId => seedInvoice(f.northId, orderId, { status: 'STAMPING' }),
      'su venta no tiene factura.',
      null,
    ],
    [
      'stamped with its cancellation REJECTED by the PAC',
      orderId => seedInvoice(f.northId, orderId, { cancelStatus: 'REJECTED' }),
      'su venta ya tiene factura.',
      'VIGENTE',
    ],
    [
      // facturaDeLaVenta.ts:50-51: la sustituta está en cancelación y su original sigue en pie → manda la original
      'a substitute in cancellation while its original still stands',
      async orderId => {
        const original = await seedInvoice(f.northId, orderId)
        await seedInvoice(f.northId, orderId, { replacesCfdiId: original, cancelStatus: 'REQUESTED' })
      },
      'su venta ya tiene factura.',
      'VIGENTE',
    ],
    [
      // …y si la original también está en cancelación, depende del PAC
      'a substitute in cancellation whose original is in cancellation too',
      async orderId => {
        const original = await seedInvoice(f.northId, orderId, { cancelStatus: 'REQUESTED' })
        await seedInvoice(f.northId, orderId, { replacesCfdiId: original, cancelStatus: 'REQUESTED' })
      },
      'la factura de su venta está en cancelación.',
      'EN_CANCELACION',
    ],
  ])('%s', async (_name, invoice, end, panel) => {
    const orderId = await seedPayment(f.northId, at('13:52'), { amount: 935, ...VISA })
    await invoice(orderId)
    expect(await answerAt({ time: '14:00' }, AT_14)).toBe(`${ONE}${end}`)
    expect(await panelSays(f.northId, orderId)).toBe(panel)
    expect((await invoiceStateOfOrders(f.northId, [orderId])).get(orderId)).toBe(panel)
  })
})

it('two equal payments of different sales: both are listed, each with its hour, its payment form and its own state (case 41)', async () => {
  const card = await seedPayment(f.northId, at('13:52'), { amount: 935, ...VISA })
  await seedInvoice(f.northId, card)
  await seedPayment(f.northId, at('14:05'), { amount: 935 })
  const credit = await seedPayment(f.northId, at('13:40'), { amount: 935, tender: { name: 'Saldo a favor', kind: 'STORE_CREDIT' } })
  await seedInvoice(f.northId, credit, { cancelStatus: 'REQUESTED' })
  await seedPayment(f.northId, at('13:35'), { amount: 935, tender: { name: 'Uber Eats' } })
  expect(await answerAt({ time: '14:00' }, AT_14)).toBe(
    [
      'Cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 4',
      '14:05 · Efectivo · Completado · sin factura',
      '13:52 · Visa terminación 4242 · Completado · ya tiene factura',
      '13:40 · Saldo a favor · Completado · factura en cancelación',
      '13:35 · Otro · Completado · sin factura',
    ].join('\n'),
  )
})

it('a declined attempt and its approved retry: two lines, each with its status; a lone declined attempt says «Fallido» (C7 r1)', async () => {
  const orderId = await seedPayment(f.northId, at('13:52'), { amount: 935, ...VISA, status: 'FAILED' })
  await seedPayment(f.northId, at('13:55'), { amount: 935, ...VISA, orderId })
  await seedInvoice(f.northId, orderId)
  expect(await answerAt({ time: '14:00' }, AT_14)).toBe(
    [
      'Cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 2',
      '13:55 · Visa terminación 4242 · Completado · ya tiene factura',
      '13:52 · Visa terminación 4242 · Fallido · ya tiene factura',
    ].join('\n'),
  )
  await clearInvoices([f.northId])
  await clearSales([f.northId])
  await seedPayment(f.northId, at('13:52'), { amount: 935, ...VISA, status: 'FAILED' })
  expect(await answerAt({ time: '14:00' }, AT_14)).toBe(
    'Cobro de exactamente $935.00 hoy a las 13:52 (Visa terminación 4242 · Fallido) en Flautas Coyoacán (corte 14:32): su venta no tiene factura.',
  )
})

it('two equal payments of the SAME sale: both are listed, each with its hour and its payment form, and both with the same state (case 41; Codex plan r2 #5)', async () => {
  // Una cuenta de $1,870.00 pagada en dos partes iguales, las dos de la misma venta
  const orderId = await seedPayment(f.northId, at('13:52'), { amount: 935, ...VISA })
  await seedPayment(f.northId, at('14:05'), { amount: 935, orderId })
  await seedInvoice(f.northId, orderId)
  const { result: text, args } = await queriesOf('Cfdi', () => answerAt({ time: '14:00' }, AT_14))
  expect(text).toBe(
    [
      'Cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 2',
      '14:05 · Efectivo · Completado · ya tiene factura',
      '13:52 · Visa terminación 4242 · Completado · ya tiene factura',
    ].join('\n'),
  )
  // La venta se pide UNA vez, con un solo id; los dos renglones de cobro salen
  expect(args).toHaveLength(1)
  expect((args[0] as { where: { orderId: { in: string[] } } }).where.orderId.in).toEqual([orderId])
  // La misma cuenta sin factura: los dos dicen «sin factura»
  await clearInvoices([f.northId])
  expect((await answerAt({ time: '14:00' }, AT_14)).split('\n').slice(1)).toEqual([
    '14:05 · Efectivo · Completado · sin factura',
    '13:52 · Visa terminación 4242 · Completado · sin factura',
  ])
})

it('with SUPPORT_DATA_ROWS=1 the two are still both listed: the 5 of this capability is not the row cap (Codex plan r1 #4)', async () => {
  process.env.SUPPORT_DATA_ROWS = '1'
  const first = earlierToday(CDMX)
  const orderId = await seedPayment(f.northId, first, { amount: 935 })
  await seedInvoice(f.northId, orderId)
  await seedPayment(f.northId, new Date(first.getTime() + 1000), { amount: 935, ...VISA })
  const lines = answered(await ask()).split('\n')
  expect(lines[0]).toMatch(/^Cobros de exactamente \$935\.00 hoy en Norte \(corte \d{2}:\d{2}\): 2$/)
  expect(lines.slice(1)).toEqual([
    expect.stringMatching(/^\d{2}:\d{2} · Visa terminación 4242 · Completado · sin factura$/),
    expect.stringMatching(/^\d{2}:\d{2} · Efectivo · Completado · ya tiene factura$/),
  ])
})

it('six equal payments: «Dime la hora más exacta…», and no invoice is read (case 41)', async () => {
  for (let i = 0; i < 6; i++) {
    const orderId = await seedPayment(f.northId, new Date(at('13:40').getTime() + i * 60_000), { amount: 935 })
    await seedInvoice(f.northId, orderId)
  }
  const { result: text, args } = await queriesOf('Cfdi', () => answerAt({ time: '14:00' }, AT_14))
  expect(text).toBe(
    'Hay 6 cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32). Dime la hora más exacta y te digo el de ese cobro.',
  )
  expect(args).toEqual([])
})

it('isolation (T-B41): an invoice of a sibling venue or of another organization never gives «ya tiene factura» to an own payment', async () => {
  const own = await seedPayment(f.northId, at('13:52'), { amount: 935, ...VISA })
  // Una factura vigente con la venta propia, pero de otra sucursal, y la venta facturada de cada otra sucursal, del mismo monto y hora
  for (const venueId of [f.siblingId, f.foreignId]) {
    await seedInvoice(venueId, own)
    await seedInvoice(venueId, await seedPayment(venueId, at('13:55'), { amount: 935, cardBrand: 'MASTERCARD', maskedPan: '****5555' }))
  }
  expect(await answerAt({ time: '14:00' }, AT_14)).toBe(`${ONE}su venta no tiene factura.`)
  expect((await invoiceStateOfOrders(f.northId, [own])).get(own)).toBeNull()
  // Control positivo: cada otra sucursal sí tiene la suya (no sale porque la lectura filtra por sucursal)
  for (const venueId of [f.siblingId, f.foreignId]) {
    expect((await invoiceStateOfOrders(venueId, [own])).get(own)).toBe('VIGENTE')
    expect(await answerAt({ time: '14:00' }, AT_14, venueId)).toBe(
      'Cobro de exactamente $935.00 hoy a las 13:55 (Mastercard terminación 5555 · Completado) en Flautas Coyoacán (corte 14:32): su venta ya tiene factura.',
    )
  }
})

it('no template of this capability has a folio hole, and no answer carries an order number, a CFDI folio or a UUID (case 42)', async () => {
  const uuid = '5FB2822E-396D-4725-8521-CDC4BDD20CCF'
  const orderId = await seedPayment(f.northId, at('13:52'), { amount: 935, ...VISA })
  await prisma.order.update({ where: { id: orderId }, data: { orderNumber: 'ORD-1790121567183' } })
  await seedInvoice(f.northId, orderId, { uuid, folio: '48213' })
  await seedPayment(f.northId, at('14:05'), { amount: 935, orderId })
  const scope = scopeFor(f.northId)
  const params = paymentInvoice.params({ ...REQUEST, time: '14:00' }, AT_14, scope)
  if (!params.ok) throw new Error(params.refusal)
  const read = await paymentInvoice.read(scope, params.value)
  // Lo leído no trae nada de la factura más que su estado: ni UUID, ni folio, ni RFC, ni ligas
  const json = JSON.stringify(read)
  for (const leak of [uuid, '48213', 'GODE561231GR8', 'storage.test.local', 'ORD-', '1790121567183']) expect(json).not.toContain(leak)
  const text = paymentInvoice.render(scope, params.value, read).text
  for (const leak of [uuid, '48213', 'A48213', 'GODE561231GR8', 'ORD-', '1790121567183', orderId]) expect(text).not.toContain(leak)
})

it('a question with ORD-1790121567183 never reaches the worker: the router answers the privacy text of phase 1 (case 42)', async () => {
  const { receiverId, phone } = await f.conversation()
  await seedInvoice(f.northId, await seedPayment(f.northId, earlierToday(CDMX), { amount: 935 }))
  const wamid = `wamid.${receiverId}-folio`
  const spy = spyQueries()
  let routed: string
  try {
    routed = await tryRouteSupport({
      receiverId,
      phone,
      wamid,
      type: 'text',
      body: '¿Ya tiene factura la venta ORD-1790121567183?',
      timestamp: String(Math.floor(Date.now() / 1000)),
    })
  } finally {
    spy.restore()
  }
  expect(routed).toBe('QUEUED')
  const message = await prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid } } })
  expect(message).toMatchObject({ answer: SUPPORT_SENSITIVE, status: 'ANSWER_READY', dataCapability: null })
  expect(message.purpose).not.toBe('DATA')
  expect(message.answer).not.toMatch(/el monto|la hora/)
  expect(await prisma.supportMessage.count({ where: { conversation: { receiverId }, purpose: 'DATA' } })).toBe(0)
  expect(await prisma.supportDataQuery.count({ where: { staffId: f.staffId } })).toBe(0)
  // Ninguna consulta a Payment ni a Cfdi, tampoco en SQL crudo
  expect(spy.calls.filter(c => ['Payment', 'Cfdi'].includes(c.model ?? ''))).toEqual([])
  expect(spy.calls.filter(c => c.model === null && /"(Payment|Cfdi)"/.test(JSON.stringify(c.args)))).toEqual([])
})

it.each<[string, string | null]>([
  ['no amount', null],
  ['«5» from «la mesa 5» (C7 r1: the number of the table is not an amount)', '5'],
])(
  '«¿Ya está facturada la venta de la mesa 5?» (no folio), %s → SUPPORT_DATA_REFUSALS.PARAM_AMOUNT, PARAM_INVALID, read never called (case 42)',
  async (_name, amount) => {
    await seedPayment(f.northId, earlierToday(CDMX), { amount: 5 }) // un cobro de $5.00 que no se debe buscar
    const { read, catalog } = spiedCatalog()
    expect(await ask({ amount }, '¿Ya está facturada la venta de la mesa 5?', catalog)).toMatchObject({
      kind: 'refusal',
      capability: 'payment_invoice',
      text: SUPPORT_DATA_REFUSALS.PARAM_AMOUNT,
      log: { result: 'PARAM_INVALID' },
    })
    expect(read).not.toHaveBeenCalled()
  },
)

it('T-B47 (Codex bloque 3 r1): «cobré 850 a las 2, no, 3» with the AI amount 3 → SUPPORT_DATA_REFUSALS.PARAM_TIME, PARAM_INVALID, read never called', async () => {
  await seedPayment(f.northId, earlierToday(CDMX), { amount: 3 }) // un cobro de $3.00 que no se debe buscar
  const { read, catalog } = spiedCatalog()
  expect(await ask({ amount: '3', time: 'a las 2' }, 'cobré 850 a las 2, no, 3', catalog)).toMatchObject({
    kind: 'refusal',
    capability: 'payment_invoice',
    text: SUPPORT_DATA_REFUSALS.PARAM_TIME,
    log: { result: 'PARAM_INVALID' },
  })
  expect(read).not.toHaveBeenCalled()
})

it('«¿Ya tiene factura lo que entró a caja 850 pesos hoy?»: the number with «pesos» after «caja» is the amount, and it answers (T-B49, Codex bloque 3 r3)', async () => {
  await seedInvoice(f.northId, await seedPayment(f.northId, earlierToday(CDMX), { amount: 850 }))
  expect(answered(await ask({ amount: '850' }, '¿Ya tiene factura lo que entró a caja 850 pesos hoy?'))).toMatch(
    /^Cobro de exactamente \$850\.00 hoy a las \d{2}:\d{2} \(Efectivo · Completado\) en Norte \(corte \d{2}:\d{2}\): su venta ya tiene factura\.$/,
  )
})

describe('the gates of the sales list with invoices (case 43)', () => {
  it.each<[string, string[]]>([
    ['without orders:read', ['cfdi:view']],
    ['without cfdi:view', ['orders:read']],
  ])('%s → supportDataNoPermission, NO_PERMISSION; read is not called', async (_name, permissions) => {
    await f.grant({ permissions, features: ['CFDI'] })
    const { read, catalog } = spiedCatalog()
    expect(await ask({}, MESSAGE, catalog)).toMatchObject({
      kind: 'refusal',
      text: supportDataNoPermission(OBJECT),
      log: { result: 'NO_PERMISSION' },
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('without CFDI → SUPPORT_DATA_REFUSALS.PLAN_INVOICES, PLAN_REQUIRED; read is not called', async () => {
    await f.grant({ permissions: ['orders:read', 'cfdi:view'] })
    const { read, catalog } = spiedCatalog()
    expect(await ask({}, MESSAGE, catalog)).toMatchObject({
      kind: 'refusal',
      text: SUPPORT_DATA_REFUSALS.PLAN_INVOICES,
      log: { result: 'PLAN_REQUIRED' },
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('a TRIAL venue passes without CFDI, as in the panel (exempt from the plan gate)', async () => {
    await prisma.venue.update({ where: { id: f.northId }, data: { status: 'TRIAL' } })
    await f.grant({ permissions: ['orders:read', 'cfdi:view'] })
    const { read, catalog } = spiedCatalog()
    expect((await ask({}, MESSAGE, catalog)).kind).toBe('answer')
    expect(read).toHaveBeenCalledTimes(1)
  })
})

it('a bill paid in two parts, asked by its total → «No encontré… dime el monto de una de ellas.» (case 43)', async () => {
  const orderId = await seedPayment(f.northId, at('13:52'), { amount: 935, ...VISA })
  await seedPayment(f.northId, at('14:05'), { amount: 935, orderId })
  await seedInvoice(f.northId, orderId)
  expect(await answerAt({ amount: '1870', time: '14:00' }, '¿Ya tiene factura la venta del cobro de $1,870 de hoy a las 14:00?')).toBe(
    'No encontré cobros de exactamente $1,870.00 (contando la propina) hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32). Si la cuenta se pagó en partes, dime el monto de una de ellas.',
  )
})

it('in the bridge venue the answer says it does not include the old QR payments', async () => {
  const bridge = jest.spyOn(legacy, 'sumsLegacyQrPayments').mockImplementation(venueId => venueId === f.northId)
  await seedInvoice(f.northId, await seedPayment(f.northId, earlierToday(CDMX), { amount: 935 }))
  expect(answered(await ask()).split('\n')).toEqual([
    expect.stringMatching(
      /^Cobro de exactamente \$935\.00 hoy a las \d{2}:\d{2} \(Efectivo · Completado\) en Norte \(corte \d{2}:\d{2}\): su venta ya tiene factura\.$/,
    ),
    'No incluye los cobros QR del sistema anterior.',
  ])
  expect(answered(await ask({ amount: '999' }, '¿Ya tiene factura la venta del cobro de $999 de hoy?')).split('\n')).toEqual([
    expect.stringMatching(/^No encontré cobros de exactamente \$999\.00 /),
    'No incluye los cobros QR del sistema anterior.',
  ])
  expect(bridge).toHaveBeenCalledWith(f.northId)
})

it('zero rows: a complete sentence (Review Focus 2)', async () => {
  expect(await answerAt({ time: '14:00' }, AT_14, f.emptyId)).toBe(
    'No encontré cobros de exactamente $935.00 (contando la propina) hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32). Si la cuenta se pagó en partes, dime el monto de una de ellas.',
  )
  // Y por el orquestador, con el reloj de verdad y sin hora
  await f.unlock(f.emptyId)
  const now = new Date()
  const out = await prepareDataAnswer({
    conversation: { ...(await f.conversation()), venueId: f.emptyId },
    request: REQUEST,
    message: MESSAGE,
    now,
  })
  expect(answered(out)).toBe(
    `No encontré cobros de exactamente $935.00 (contando la propina) hoy en Sur (corte ${fmtTime(now, CDMX)}). Si la cuenta se pagó en partes, dime el monto de una de ellas.`,
  )
})
