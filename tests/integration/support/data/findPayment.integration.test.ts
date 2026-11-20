/**
 * C2 · «Buscar un cobro por su monto» (la B): los cobros de la sucursal cuyo importe, o importe + propina, es exactamente el monto que
 * escribió la persona, hoy o ayer, cerca de una hora si la dijo. Postgres de verdad (la base de la nube); el puente de QR de Mindform se
 * simula desde su pool, como en D15. Lo que vale para toda capacidad (venenos, logs, candados, datos ajenos) lo prueba el barrido
 * (`sweeps.integration.test.ts`). Las horas son fijas donde la respuesta depende del reloj: el jueves 12-nov-2026 a las 14:32 de la CDMX.
 */
jest.mock('@/services/legacy/legacyPool', () => require('@tests/__helpers__/puenteQrLegacy').moduloLegacyPool)

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { evaluatePermissionList } from '@/lib/permissions'
import { findPaymentsByAmount, paymentsByAmountSql } from '@/services/dashboard/paymentByAmount.dashboard.service'
import * as legacy from '@/services/legacy/qrPayments.legacy.service'
import { prepareDataAnswer, type DataOutcome } from '@/services/support/data/answer.service'
import { findPayment } from '@/services/support/data/capabilities/findPayment'
import { dataCatalog, type DataCatalog, type DataRequest, type DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'
import { fmtTime } from '@/services/support/data/format'
import { SUPPORT_DATA_REFUSALS, supportDataNoPermission } from '@/services/support/data/texts'
import { venueDayKey } from '@/utils/venueDateKeys'
import { consultasAlPuente, puenteContesta } from '@tests/__helpers__/puenteQrLegacy'
import { clearSales, earlierToday, seedDataFixture, seedPayment, type DataFixture } from '@tests/__helpers__/supportData'

const CDMX = 'America/Mexico_City'
const REQUEST: DataRequest = { capability: 'find_payment', day: 'today', amount: '935', time: null, otherVenue: false }
const MESSAGE = '¿Entró un cobro de $935 hoy?'
/** El corte de los ejemplos del plan: jueves 12-nov-2026, 14:32 en la CDMX. */
const NOW = new Date('2026-11-12T20:32:00Z')
/** Una hora del 12-nov (o del 11-nov, `day` 11) en la CDMX. */
// T-F11b: el renglón fijo del «no encontré»: que no aparezca un cobro no prueba que no se cobró (la terminal se trabó o estuvo sin red).
const NOT_FOUND_CAUTION =
  'Que no aparezca no quiere decir que no se cobró: si la terminal se trabó o estuvo sin internet, el cobro puede llegar después. Antes de cobrar otra vez, revisa la terminal.'
const at = (hhmm: string, day = 12) => new Date(`2026-11-${day}T${hhmm}:00-06:00`)

let f: DataFixture
beforeAll(async () => {
  f = await seedDataFixture('support-data-find-payment')
})
afterAll(() => f?.clean())
beforeEach(async () => {
  await f.reset()
  process.env.SUPPORT_DATA_ENABLED = 'true'
  await clearSales([f.northId, f.cancunId, f.emptyId, f.siblingId, f.foreignId])
  await f.grant({ permissions: ['payments:read'] })
  await f.unlock()
  puenteContesta()
})
afterEach(() => jest.restoreAllMocks())

/** La pregunta por el orquestador, con el reloj de verdad (el desbloqueo es de hoy), en la plática de la persona (una por teléfono). */
const ask = async (over: Partial<DataRequest> = {}, message = MESSAGE, venueId = f.northId, catalog?: DataCatalog) =>
  prepareDataAnswer(
    { conversation: { ...(await f.conversation()), venueId }, request: { ...REQUEST, ...over }, message, now: new Date() },
    catalog,
  )
const answered = (out: DataOutcome) => {
  if (out.kind !== 'answer') throw new Error(`find_payment: ${out.text}`)
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
async function answerAt(over: Partial<DataRequest>, message: string, venueId = f.northId, now = NOW): Promise<string> {
  const scope = scopeFor(venueId, now)
  const params = findPayment.params({ ...REQUEST, ...over }, message, scope)
  if (!params.ok) throw new Error(params.refusal)
  const rendered = findPayment.render(scope, params.value, await findPayment.read(scope, params.value))
  expect(checkRendered(rendered, CDMX)).toBe(true)
  return rendered.text
}
/** Un catálogo con la capacidad de verdad y su `read` espiado. */
const spiedCatalog = () => {
  const read = jest.fn(findPayment.read)
  return { read, catalog: dataCatalog({ ...findPayment, read }) }
}
const window1430 = { from: at('13:30'), to: at('14:30') }

it('a payment of $850 with a tip of $85 is found with $935 and with $850 (case 18)', async () => {
  await seedPayment(f.northId, earlierToday(CDMX), { amount: 850, tip: 85 })
  for (const [amount, message] of [
    ['935', '¿Entró un cobro de $935 hoy?'],
    ['850', '¿Entró un cobro de 850 hoy?'],
  ]) {
    const lines = answered(await ask({ amount }, message)).split('\n')
    expect(lines[0]).toMatch(new RegExp(`^Cobros de exactamente \\$${amount}\\.00 hoy en Norte \\(corte \\d{2}:\\d{2}\\): 1$`))
    expect(lines.slice(1)).toEqual([expect.stringMatching(/^\d{2}:\d{2} · \$850\.00 \+ propina \$85\.00 · Efectivo · Completado$/)])
  }
})

it('25 recent payments of $850.50 and an older one of $850.00: «$850» finds the one of $850.00 and says 1 (case 18)', async () => {
  await seedPayment(f.northId, at('13:00'), { amount: 850 })
  for (let i = 0; i < 25; i++) await seedPayment(f.northId, new Date(at('13:10').getTime() + i * 60_000), { amount: 850.5 })
  expect(await answerAt({ amount: '850' }, '¿Entró un cobro de $850 hoy?')).toBe(
    ['Cobros de exactamente $850.00 hoy en Flautas Coyoacán (corte 14:32): 1', '13:00 · $850.00 · Efectivo · Completado'].join('\n'),
  )
})

it('a row shows hour, amount, tip, brand and last 4; never a folio, a reference nor the masked card (case 20)', async () => {
  await seedPayment(f.northId, at('13:52'), {
    amount: 850,
    tip: 85,
    cardBrand: 'VISA',
    maskedPan: '411111******4242',
    referenceNumber: 'REF-1790121567183',
  })
  const text = await answerAt({ time: '14:00' }, '¿Entró un cobro de $935 hoy a las 14:00?')
  expect(text).toBe(
    [
      'Cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 1',
      '13:52 · $850.00 + propina $85.00 · Visa terminación 4242 · Completado',
    ].join('\n'),
  )
  for (const leak of ['411111', 'REF-', '1790121567183', '******']) expect(text).not.toContain(leak)
})

it('store credit says «Saldo a favor» and a custom tender «Otro», as Pagos of the panel says (C7 r1; etiquetaDeMetodo.ts)', async () => {
  await seedPayment(f.northId, at('13:52'), { amount: 935, tender: { name: 'Uber Eats' } })
  await seedPayment(f.northId, at('14:05'), { amount: 935, tender: { name: 'Saldo a favor', kind: 'STORE_CREDIT' } })
  await seedPayment(f.northId, at('13:40'), { amount: 935, tender: { name: 'Tarjeta de regalo', kind: 'GIFT_CARD' } })
  expect(await answerAt({ time: '14:00' }, '¿Entró un cobro de $935 hoy a las 14:00?')).toBe(
    [
      'Cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 3',
      '14:05 · $935.00 · Saldo a favor · Completado',
      '13:52 · $935.00 · Otro · Completado',
      '13:40 · $935.00 · Otro · Completado',
    ].join('\n'),
  )
})

it('«¿Entraron a caja 850 pesos hoy?»: the number with «pesos» after «caja» is the amount, and it answers (T-B49, Codex bloque 3 r3)', async () => {
  await seedPayment(f.northId, earlierToday(CDMX), { amount: 850 })
  const lines = answered(await ask({ amount: '850' }, '¿Entraron a caja 850 pesos hoy?')).split('\n')
  expect(lines[0]).toMatch(/^Cobros de exactamente \$850\.00 hoy en Norte \(corte \d{2}:\d{2}\): 1$/)
  expect(lines.slice(1)).toEqual([expect.stringMatching(/^\d{2}:\d{2} · \$850\.00 · Efectivo · Completado$/)])
})

it('two windows of an hour said without am/pm: «ayer entre 01:30 y 02:30 o entre 13:30 y 14:30», newest first', async () => {
  await seedPayment(f.northId, at('01:52', 11), { amount: 935 })
  await seedPayment(f.northId, at('14:05', 11), { amount: 900, tip: 35, cardBrand: 'MASTERCARD' })
  await seedPayment(f.northId, at('08:00', 11), { amount: 935 }) // fuera de las dos ventanas
  expect(await answerAt({ day: 'yesterday', time: 'a las 2' }, '¿Entró un cobro de 935 ayer a las 2?')).toBe(
    [
      'Cobros de exactamente $935.00 ayer entre 01:30 y 02:30 o entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 2',
      '14:05 · $900.00 + propina $35.00 · Mastercard · Completado',
      '01:52 · $935.00 · Efectivo · Completado',
    ].join('\n'),
  )
})

it('PENDING payments and other venues never appear; a FAILED one says «Fallido» (T-B41)', async () => {
  await seedPayment(f.northId, at('13:52'), { amount: 935, status: 'FAILED', cardBrand: 'AMERICAN_EXPRESS' })
  await seedPayment(f.northId, at('14:05'), { amount: 935, status: 'PENDING' })
  // El mismo monto, en la misma ventana: una sucursal hermana (misma organización) y una de otra organización
  await seedPayment(f.siblingId, at('13:55'), { amount: 935 })
  await seedPayment(f.foreignId, at('14:10'), { amount: 935 })
  expect(await answerAt({ time: '14:00' }, '¿Entró un cobro de $935 hoy a las 14:00?')).toBe(
    [
      'Cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 1',
      '13:52 · $935.00 · American Express · Fallido',
    ].join('\n'),
  )
  // La lectura del panel, directa: sólo lo de su sucursal…
  const input = { amount: new Prisma.Decimal('935'), windows: [window1430], take: 5 }
  const own = await findPaymentsByAmount(f.northId, input)
  expect([own.total, own.rows.map(r => [r.createdAt.toISOString(), r.status])]).toEqual([1, [[at('13:52').toISOString(), 'FAILED']]])
  // …y las otras dos sí tienen el suyo (la siembra es eficaz: no sale porque la consulta filtra por sucursal)
  for (const [venueId, hhmm] of [
    [f.siblingId, '13:55'],
    [f.foreignId, '14:10'],
  ]) {
    const other = await findPaymentsByAmount(venueId, input)
    expect([other.total, other.rows.map(r => r.createdAt.toISOString())]).toEqual([1, [at(hhmm).toISOString()]])
  }
})

it('no windows: the panel read answers zero rows and a total of 0, and does not throw (the guard lives in its query)', async () => {
  await seedPayment(f.northId, at('13:52'), { amount: 935 })
  expect(await findPaymentsByAmount(f.northId, { amount: new Prisma.Decimal('935'), windows: [], take: 5 })).toEqual({ total: 0, rows: [] })
})

it('more matches than rows: the total, the newest rows and «y 2 más» on one last line with the bridge note', async () => {
  jest.spyOn(legacy, 'sumsLegacyQrPayments').mockImplementation(venueId => venueId === f.northId)
  for (let i = 0; i < 7; i++) await seedPayment(f.northId, new Date(at('13:40').getTime() + i * 60_000), { amount: 935 })
  const lines = (await answerAt({ time: '14:00' }, '¿Entró un cobro de $935 hoy a las 14:00?')).split('\n')
  expect(lines[0]).toBe('Cobros de exactamente $935.00 hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32): 7')
  expect(lines.slice(1, 6)).toEqual(['13:46', '13:45', '13:44', '13:43', '13:42'].map(h => `${h} · $935.00 · Efectivo · Completado`))
  expect(lines[6]).toBe('y 2 más; el resto está en el panel. No incluye los cobros QR del sistema anterior.')
  expect(lines).toHaveLength(7)
})

it('a person whose Permission Set has goals:org-manage and not payments:read does not get this, as the panel route rejects her (case 49)', async () => {
  await f.grant({ permissions: ['goals:org-manage'], asPermissionSet: true })
  const { read, catalog } = spiedCatalog()
  expect(await ask({}, MESSAGE, f.northId, catalog)).toMatchObject({
    kind: 'refusal',
    capability: 'find_payment',
    text: supportDataNoPermission('los cobros'),
    log: { result: 'NO_PERMISSION' },
  })
  expect(read).not.toHaveBeenCalled()
  // Lo que decide la ruta del panel con ese mismo Conjunto (checkPermission.middleware.ts: evaluatePermissionList)
  const { permissionSetId } = await prisma.staffVenue.findUniqueOrThrow({
    where: { staffId_venueId: { staffId: f.staffId, venueId: f.northId } },
    select: { permissionSetId: true },
  })
  const set = await prisma.permissionSet.findUniqueOrThrow({ where: { id: permissionSetId! } })
  expect(evaluatePermissionList(set.permissions, 'payments:read')).toBe(false)
})

it.each<[string, Partial<DataRequest>, string, keyof typeof SUPPORT_DATA_REFUSALS]>([
  ['day «other» → PARAM_DAY', { day: 'other' }, MESSAGE, 'PARAM_DAY'],
  ['an amount that is not in the message → PARAM_AMOUNT', { amount: '935' }, '¿Entró un cobro de $900 hoy?', 'PARAM_AMOUNT'],
  ['no amount at all → PARAM_AMOUNT', { amount: null }, '¿Entró un cobro hoy?', 'PARAM_AMOUNT'],
  ['a time that is not in the message → PARAM_TIME', { time: '14:00' }, MESSAGE, 'PARAM_TIME'],
  // T-B47 (Codex bloque 3 r1): la IA tomó por monto el 3 que corrige la hora; 850 y 3 son dos montos posibles y el 3 va tras «no»
  [
    'an AI amount that is the corrected hour («cobré 850 a las 2, no, 3», amount 3) → PARAM_TIME',
    { amount: '3', time: 'a las 2' },
    'cobré 850 a las 2, no, 3',
    'PARAM_TIME',
  ],
  ['«la mesa 5» read as $5 → PARAM_AMOUNT (C7 r1)', { amount: '5' }, '¿Entró el cobro de la mesa 5?', 'PARAM_AMOUNT'],
])('%s, PARAM_INVALID, read never called (case 30)', async (_name, over, message, key) => {
  const { read, catalog } = spiedCatalog()
  expect(await ask(over, message, f.northId, catalog)).toMatchObject({
    kind: 'refusal',
    capability: 'find_payment',
    text: SUPPORT_DATA_REFUSALS[key],
    log: { result: 'PARAM_INVALID' },
  })
  expect(read).not.toHaveBeenCalled()
})

it('in the bridge venue the answer says it does not include the old QR payments, and the bridge is not read', async () => {
  const bridge = jest.spyOn(legacy, 'sumsLegacyQrPayments').mockImplementation(venueId => venueId === f.northId)
  await seedPayment(f.northId, earlierToday(CDMX), { amount: 935 })
  const found = answered(await ask()).split('\n')
  expect(found).toEqual([
    expect.stringMatching(/^Cobros de exactamente \$935\.00 hoy en Norte \(corte \d{2}:\d{2}\): 1$/),
    expect.stringMatching(/^\d{2}:\d{2} · \$935\.00 · Efectivo · Completado$/),
    'No incluye los cobros QR del sistema anterior.',
  ])
  // Sin cobros también lo dice: puede ser uno del sistema anterior
  const none = answered(await ask({ amount: '999' }, '¿Entró un cobro de $999 hoy?')).split('\n')
  expect(none).toEqual([
    expect.stringMatching(/^No encontré cobros de exactamente \$999\.00 /),
    NOT_FOUND_CAUTION,
    'No incluye los cobros QR del sistema anterior.',
  ])
  expect(bridge).toHaveBeenCalledWith(f.northId)
  expect(consultasAlPuente()).toBe(0)
})

it('zero rows: a complete sentence (Review Focus 2)', async () => {
  expect(await answerAt({ time: '14:00' }, '¿Entró un cobro de $935 hoy a las 14:00?', f.emptyId)).toBe(
    [
      'No encontré cobros de exactamente $935.00 (contando la propina) hoy entre 13:30 y 14:30 en Flautas Coyoacán (corte 14:32). Si fue con centavos u otra hora, escríbelo así.',
      NOT_FOUND_CAUTION,
    ].join('\n'),
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
    [
      `No encontré cobros de exactamente $935.00 (contando la propina) hoy en Sur (corte ${fmtTime(now, CDMX)}). Si fue con centavos u otra hora, escríbelo así.`,
      NOT_FOUND_CAUTION,
    ].join('\n'),
  )
})

it('execution plan: with 3,000 payments over 60 days and 3,000 of another venue, no Seq Scan on Payment and Payment_venueId_createdAt_idx with an Index Cond on createdAt', async () => {
  const day = 86_400_000
  for (const venueId of [f.northId, f.siblingId]) {
    const orderId = await seedPayment(venueId, at('09:00'), { amount: 1 })
    await prisma.payment.createMany({
      data: Array.from({ length: 3000 }, (_, i) => ({
        venueId,
        orderId,
        amount: 100 + (i % 900),
        tipAmount: 0,
        method: 'CASH' as const,
        status: 'COMPLETED' as const,
        type: 'REGULAR' as const,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100 + (i % 900),
        createdAt: new Date(NOW.getTime() - (i % 60) * day - (i % 600) * 60_000),
      })),
    })
  }
  await prisma.$executeRawUnsafe('ANALYZE "Payment"')
  const sql = paymentsByAmountSql(f.northId, { amount: new Prisma.Decimal('935'), windows: [window1430], take: 5 })
  const [{ 'QUERY PLAN': plan }] = await prisma.$queryRaw<{ 'QUERY PLAN': unknown }[]>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`)
  type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Index Cond'?: string; Plans?: PlanNode[] }
  const nodes: PlanNode[] = []
  const walk = (node: PlanNode) => {
    nodes.push(node)
    for (const child of node.Plans ?? []) walk(child)
  }
  // El tipo json de Postgres llega ya leído; si llegara como texto, se lee aquí
  walk((typeof plan === 'string' ? JSON.parse(plan) : (plan as { Plan: PlanNode }[]))[0].Plan)
  expect(nodes.filter(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'Payment')).toEqual([])
  // El índice de la sucursal y la fecha (el que nombra el servicio), no otro de Payment que también traiga `createdAt`. C7 r1: el tipo de
  // pago se une por su llave compuesta y puede salir con su propio índice; ése no es de Payment y no cuenta aquí
  const indexed = nodes
    .filter(n => n['Index Name']?.startsWith('Payment_'))
    .map(n => [n['Index Name'], /createdAt/.test(n['Index Cond'] ?? '')])
  expect(indexed).toContainEqual(['Payment_venueId_createdAt_idx', true])
  expect(indexed.filter(([name]) => name !== 'Payment_venueId_createdAt_idx')).toEqual([])
})
