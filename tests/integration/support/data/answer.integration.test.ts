import type { SupportConversation, SupportDataResult } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ForbiddenError } from '@/errors/AppError'
import * as mcpScope from '@/mcp/scope'
import { isSupportAccessLost, readSupportContext } from '@/services/support/context.service'
import {
  checkDataDelivery,
  dataAccessFingerprint,
  openDataEnvelope,
  prepareDataAnswer,
  sealDataEnvelope,
  type DataLog,
} from '@/services/support/data/answer.service'
import { DataReadRefusal, capabilityGates, dataCatalog, type DataCatalog, type DataRequest } from '@/services/support/data/catalog'
import { readDataValidity } from '@/services/support/data/consent.service'
import { template } from '@/services/support/data/check'
import { countDataReadsToday, paramsHmac, recordSupportDataQuery } from '@/services/support/data/log'
import {
  SUPPORT_DATA_CHECK_FAILED,
  SUPPORT_DATA_DAILY_CAP,
  SUPPORT_DATA_LINK_FIRST,
  SUPPORT_DATA_NEEDS_UNLOCK,
  SUPPORT_DATA_NOTICE,
  SUPPORT_DATA_OFF,
  SUPPORT_DATA_OTHER_VENUE,
  SUPPORT_DATA_QUERY_FAILED,
  SUPPORT_DATA_REFUSALS,
  SUPPORT_DATA_SUPERADMIN,
  supportDataNoPermission,
  supportDataOutOfCatalog,
} from '@/services/support/data/texts'
import { venueDayKey } from '@/utils/venueDateKeys'
import {
  amountLeaks,
  changeSupportDataNotice,
  fakeCapability,
  seedDataFixture,
  spyLogger,
  type DataFixture,
} from '@tests/__helpers__/supportData'

let f: DataFixture
beforeAll(async () => {
  f = await seedDataFixture('support-data-answer')
})
afterAll(() => f?.clean())

const REQUEST: DataRequest = { capability: 'fake', day: 'today', amount: '850', time: null, otherVenue: false },
  MESSAGE = '¿entró un cobro de 850?'
const fake = { ...fakeCapability, read: jest.fn(fakeCapability.read) }
/** T-B44: el catálogo de la prueba, registrado una vez (`read` sigue siendo el `jest.fn` de arriba). */
const FAKE = dataCatalog(fake)
const ask = async (over: Partial<DataRequest> = {}, conversation?: SupportConversation, now = new Date()) =>
  prepareDataAnswer(
    { conversation: conversation ?? (await f.conversation()), request: { ...REQUEST, ...over }, message: MESSAGE, now },
    FAKE,
  )
/** La misma pregunta contra otro catálogo (una capacidad apagada, una plantilla rota…). */
const askWith = async (catalog: DataCatalog, over: Partial<DataRequest> = {}) =>
  prepareDataAnswer({ conversation: await f.conversation(), request: { ...REQUEST, ...over }, message: MESSAGE, now: new Date() }, catalog)
const logged = () => prisma.supportDataQuery.findMany({ where: { staffId: f.staffId }, take: 100 })
const today = () => venueDayKey(new Date(), 'America/Mexico_City')
const row = (result: SupportDataResult): DataLog => ({
  staffId: f.staffId,
  venueId: f.northId,
  capability: 'fake',
  paramsHmac: paramsHmac(REQUEST),
  result,
  day: today(),
})
const DAY_MS = 86_400_000

beforeEach(async () => {
  await f.reset() // cada prueba parte del mismo estado: varias le quitan algo a la persona
  fake.read.mockReset()
  fake.read.mockImplementation(fakeCapability.read)
})
afterEach(() => {
  process.env.SUPPORT_DATA_ENABLED = 'true' // una prueba la apaga
  delete process.env.SUPPORT_DATA_QUERY_TIMEOUT_SECONDS
  jest.restoreAllMocks()
})

/**
 * Hace en la base el cambio que nombra el caso: quita el permiso, cambia la zona, borra el desbloqueo… Los que quitan el contexto personal:
 * 'link replaced' = borra el vínculo y crea otro de la misma persona y teléfono (otro id; la plática conserva el anterior) ·
 * 'link expired' = `expiresAt` en el pasado · 'link deleted' = sin fila ·
 * 'StaffVenue.active = false with an active MEMBER membership' = `staffVenue.updateMany({ where: { staffId, venueId: northId }, data: { active: false } })` ·
 * 'org membership deactivated' = `staffOrganization.update({ …, data: { isActive: false } })`.
 */
async function apply(change: string): Promise<void> {
  const { staffId, northId, cancunId, orgId } = f
  const changes: Record<string, () => Promise<unknown>> = {
    'permission removed': () => f.grant({ permissions: [], features: ['RESERVATIONS'] }),
    'plan removed': () => prisma.venueFeature.deleteMany({ where: { venueId: { in: [northId, cancunId] } } }),
    'ADMIN → MANAGER with the same permissions': () =>
      f.grant({ permissions: ['reports:read'], role: 'MANAGER', features: ['RESERVATIONS'] }),
    'became superadmin': () => prisma.staffVenue.updateMany({ where: { staffId, venueId: cancunId }, data: { role: 'SUPERADMIN' } }),
    'timezone changed to America/Cancun': () => prisma.venue.update({ where: { id: northId }, data: { timezone: 'America/Cancun' } }),
    'unlock deleted': () => prisma.supportDataUnlock.deleteMany({ where: { staffId } }),
    'notice text changed': async () => {
      changeSupportDataNotice(`${SUPPORT_DATA_NOTICE.es} Cambió.`, `${SUPPORT_DATA_NOTICE.en} Changed.`)
    },
    'kycStatus VERIFIED → IN_REVIEW': () => prisma.venue.update({ where: { id: northId }, data: { kycStatus: 'IN_REVIEW' } }),
    'link replaced': async () => {
      const { phone } = await prisma.supportWhatsappLink.findUniqueOrThrow({ where: { staffId } })
      await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
      await prisma.supportWhatsappLink.create({
        data: { staffId, phone, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 30 * DAY_MS) },
      })
    },
    'link expired': () => prisma.supportWhatsappLink.updateMany({ where: { staffId }, data: { expiresAt: new Date(Date.now() - 1000) } }),
    'link deleted': () => prisma.supportWhatsappLink.deleteMany({ where: { staffId } }),
    'StaffVenue.active = false with an active MEMBER membership': () =>
      prisma.staffVenue.updateMany({ where: { staffId, venueId: northId }, data: { active: false } }),
    'org membership deactivated': () =>
      prisma.staffOrganization.update({ where: { staffId_organizationId: { staffId, organizationId: orgId } }, data: { isActive: false } }),
    'a changed password': () => prisma.staff.update({ where: { id: staffId }, data: { lastPasswordReset: new Date() } }),
  }
  if (!changes[change]) throw new Error(`apply: unknown change ${change}`)
  await changes[change]()
}
/** El estado de partida que pide un cambio: 'ADMIN → MANAGER…' necesita a la persona como ADMIN al preparar. */
async function arrange(change: string): Promise<void> {
  if (change === 'ADMIN → MANAGER with the same permissions')
    await f.grant({ permissions: ['reports:read'], role: 'ADMIN', features: ['RESERVATIONS'] })
}

it('data off → SUPPORT_DATA_OFF, nothing read, nothing logged', async () => {
  await f.unlock()
  process.env.SUPPORT_DATA_ENABLED = 'false'
  expect(await ask()).toEqual({ kind: 'refusal', capability: null, text: SUPPORT_DATA_OFF, log: null })
  expect(fake.read).not.toHaveBeenCalled()
})

it.each<[string, Partial<SupportConversation>]>([
  ['a public conversation', { mode: 'PUBLIC' }],
  ['a personal conversation still choosing its venue', { orgId: null, venueId: null, pendingSelection: 'VENUE' }],
])('%s → SUPPORT_DATA_LINK_FIRST', async (_name, patch) => {
  expect(await ask({}, { ...(await f.conversation()), ...patch })).toEqual({
    kind: 'refusal',
    capability: null,
    text: SUPPORT_DATA_LINK_FIRST,
    log: null,
  })
  expect(fake.read).not.toHaveBeenCalled()
})

it('a superadmin → SUPPORT_DATA_SUPERADMIN, nothing read, nothing logged (case 14)', async () => {
  await f.unlock()
  await apply('became superadmin') // la sesión es la de un superadmin en OTRA sucursal: igual no consulta
  expect(await ask()).toEqual({ kind: 'refusal', capability: null, text: SUPPORT_DATA_SUPERADMIN, log: null })
  expect(fake.read).not.toHaveBeenCalled()
})

it('a capability outside the catalog → the list of what it can do', async () =>
  expect(await ask({ capability: 'other' })).toMatchObject({
    kind: 'refusal',
    capability: null,
    log: null,
    text: 'Todavía no consulto ese dato por WhatsApp. Por aquí puedo darte: dato de prueba.',
  }))

it('a key of Object.prototype is out of the catalog, not a capability', async () =>
  expect(await ask({ capability: 'constructor' })).toMatchObject({ kind: 'refusal', capability: null, log: null }))

it('a capability whose available() is false behaves as out of the catalog and is not in the list of what it can do', async () => {
  await f.unlock()
  const off = { ...fakeCapability, key: 'off', label: 'dato apagado', read: jest.fn(fakeCapability.read), available: async () => false }
  const catalog = dataCatalog(fake, off)
  expect(await askWith(catalog, { capability: 'off' })).toEqual({
    kind: 'refusal',
    capability: null,
    text: supportDataOutOfCatalog(['dato de prueba']),
    log: null,
  })
  expect(await askWith(catalog, { capability: 'other' })).toMatchObject({ text: supportDataOutOfCatalog(['dato de prueba']) })
  expect(off.read).not.toHaveBeenCalled()
  expect((await askWith(catalog)).kind).toBe('answer') // las demás siguen
})

it.each<[string, () => Promise<boolean>]>([
  [
    'throws',
    () => {
      throw new Error('available failed at 12345.6')
    },
  ],
  ['rejects', () => Promise.reject(new Error('available failed at 12345.6'))],
])('a capability whose available() %s is off: out of the catalog, logged by its key and the error name only', async (_how, available) => {
  await f.unlock()
  const broken = { ...fakeCapability, key: 'broken', label: 'dato roto', read: jest.fn(fakeCapability.read), available }
  const log = spyLogger()
  expect(await askWith(dataCatalog(fake, broken), { capability: 'broken' })).toEqual({
    kind: 'refusal',
    capability: null,
    text: supportDataOutOfCatalog(['dato de prueba']),
    log: null,
  })
  expect(broken.read).not.toHaveBeenCalled()
  expect(log.args()).toContainEqual({ capability: 'broken', name: 'Error', code: undefined })
  expect(amountLeaks(log.args(), [12345.6])).toEqual([]) // el mensaje del error no se registra
  log.restore()
  expect((await askWith(dataCatalog(fake, broken))).kind).toBe('answer') // las demás siguen
})

it('another venue named → the fixed «Sólo veo la sucursal que tienes elegida…», without its name, nothing read (case 12, T-B43)', async () => {
  await f.unlock()
  expect(await ask({ otherVenue: true })).toMatchObject({
    kind: 'refusal',
    capability: 'fake',
    text: SUPPORT_DATA_OTHER_VENUE,
    log: { result: 'PARAM_INVALID', capability: 'fake', venueId: f.northId },
  })
  expect(fake.read).not.toHaveBeenCalled()
})

it.each(['never accepted', 'accepted another text', 'no unlock today', 'unlock of another venue'])(
  '%s → the same fixed text, NEEDS_UNLOCK and nothing read (cases 3, 5 and 6)',
  async state => {
    const states: Record<string, () => Promise<unknown>> = {
      'never accepted': async () => undefined,
      'accepted another text': async () => {
        await f.unlock()
        await apply('notice text changed')
      },
      'no unlock today': () => f.accept(),
      'unlock of another venue': () => f.unlock(f.cancunId),
    }
    await states[state]()
    expect(await ask()).toMatchObject({
      kind: 'refusal',
      text: SUPPORT_DATA_NEEDS_UNLOCK,
      log: { result: 'NEEDS_UNLOCK', capability: 'fake' },
    })
    expect(fake.read).not.toHaveBeenCalled()
  },
)

it('without the unlock, even a capability the person cannot see gets the same unlock text (the unlock goes before the permission)', async () => {
  await f.grant({ permissions: [], features: [] })
  expect(await ask()).toMatchObject({ text: SUPPORT_DATA_NEEDS_UNLOCK, log: { result: 'NEEDS_UNLOCK' } })
})

it('a permission removed and given back: «no puedo mostrarte», then the answer, with the same unlock (case 8)', async () => {
  await f.unlock()
  await f.grant({ permissions: [], features: ['RESERVATIONS'] })
  expect(await ask()).toMatchObject({ kind: 'refusal', log: { result: 'NO_PERMISSION' } })
  expect(fake.read).not.toHaveBeenCalled()
  await f.grant({ permissions: ['reports:read'], features: ['RESERVATIONS'] })
  expect((await ask()).kind).toBe('answer')
  expect(await prisma.supportDataUnlock.count({ where: { staffId: f.staffId } })).toBe(1)
})

it('the same permission through a PermissionSet answers too', async () => {
  await f.unlock()
  await f.grant({ permissions: ['reports:read'], features: ['RESERVATIONS'], asPermissionSet: true })
  expect((await ask()).kind).toBe('answer')
  await f.grant({ permissions: ['payments:read'], features: ['RESERVATIONS'], asPermissionSet: true })
  expect(await ask()).toMatchObject({
    text: supportDataNoPermission('el dato de prueba'),
    log: { result: 'NO_PERMISSION' },
  })
})

it('without the plan → its text and PLAN_REQUIRED; notOffered → its text and NOT_OFFERED; nothing read', async () => {
  await f.unlock()
  await f.grant({ permissions: ['reports:read'] })
  expect(await ask()).toMatchObject({
    kind: 'refusal',
    text: SUPPORT_DATA_REFUSALS.PLAN_RESERVATIONS,
    log: { result: 'PLAN_REQUIRED' },
  })
  await f.reset()
  await f.unlock()
  const closed = { ...fake, notOffered: () => 'NOT_AVAILABLE' as const }
  expect(await askWith(dataCatalog(closed))).toMatchObject({
    kind: 'refusal',
    capability: 'fake',
    text: SUPPORT_DATA_REFUSALS.NOT_AVAILABLE,
    log: { result: 'NOT_OFFERED', capability: 'fake' },
  })
  // notOffered sigue en el catálogo: la persona lo ve en la lista de lo que sí puede
  expect(await askWith(dataCatalog(closed), { capability: 'other' })).toMatchObject({ text: supportDataOutOfCatalog(['dato de prueba']) })
  expect(fake.read).not.toHaveBeenCalled()
})

// El orden de los pasos 7 y 8: el texto de «no se ofrece aquí» habla de la sucursal (el puente de QR, la verificación); nunca lo ve
// quien no tiene el permiso de esa pantalla.
it('not offered here, asked by someone without its permission → NO_PERMISSION, never the not-offered text', async () => {
  await f.unlock()
  await f.grant({ permissions: [], features: ['RESERVATIONS'] })
  const closed = { ...fake, notOffered: () => 'NOT_AVAILABLE' as const }
  expect(await askWith(dataCatalog(closed))).toMatchObject({
    kind: 'refusal',
    text: supportDataNoPermission('el dato de prueba'),
    log: { result: 'NO_PERMISSION' },
  })
  expect(fake.read).not.toHaveBeenCalled()
})

it('an amount the person did not write → «No te entendí el monto…», PARAM_INVALID, nothing read (case 30)', async () => {
  await f.unlock()
  expect(await ask({ amount: '900' })).toMatchObject({
    kind: 'refusal',
    text: SUPPORT_DATA_REFUSALS.PARAM_AMOUNT,
    log: { result: 'PARAM_INVALID' },
  })
  expect(fake.read).not.toHaveBeenCalled()
})

it('countDataReadsToday counts ANSWERED, QUERY_FAILED, CHECK_FAILED and OVER_CAP only, of that person and that day', async () => {
  const results: SupportDataResult[] = [
    'ANSWERED',
    'NO_PERMISSION',
    'PLAN_REQUIRED',
    'NEEDS_UNLOCK',
    'PARAM_INVALID',
    'NOT_OFFERED',
    'OVER_CAP',
    'QUERY_FAILED',
    'CHECK_FAILED',
  ]
  for (const result of results) await recordSupportDataQuery(prisma, row(result))
  await recordSupportDataQuery(prisma, { ...row('ANSWERED'), day: '2000-01-01' })
  expect(await countDataReadsToday(f.staffId, today())).toBe(4)
  expect(await countDataReadsToday(f.staffId, '2000-01-01')).toBe(1)
})

it('the daily cap counts reads only: 60 answered → SUPPORT_DATA_DAILY_CAP and no new row; 60 NO_PERMISSION rows in a row do not spend it (case 51)', async () => {
  await f.unlock()
  await Promise.all(Array.from({ length: 60 }, () => recordSupportDataQuery(prisma, row('NO_PERMISSION'))))
  expect((await ask()).kind).toBe('answer')
  await Promise.all(Array.from({ length: 60 }, () => recordSupportDataQuery(prisma, row('ANSWERED'))))
  fake.read.mockClear()
  expect(await ask()).toEqual({ kind: 'refusal', capability: 'fake', text: SUPPORT_DATA_DAILY_CAP, log: null })
  expect(fake.read).not.toHaveBeenCalled()
})

it.each(['data off', 'public conversation', 'superadmin', 'out of catalog', 'daily cap'])('%s writes no log row (case 51)', async name => {
  await f.unlock()
  const conversation = await f.conversation()
  const outcomes: Record<string, () => Promise<unknown>> = {
    'data off': async () => (process.env.SUPPORT_DATA_ENABLED = 'false'),
    'public conversation': async () => undefined,
    superadmin: () => apply('became superadmin'),
    'out of catalog': async () => undefined,
    'daily cap': () => Promise.all(Array.from({ length: 60 }, () => recordSupportDataQuery(prisma, row('ANSWERED')))),
  }
  await outcomes[name]()
  const out = await ask(
    name === 'out of catalog' ? { capability: 'other' } : {},
    name === 'public conversation' ? { ...conversation, mode: 'PUBLIC' } : conversation,
  )
  expect(out).toMatchObject({ kind: 'refusal', log: null }) // prepareDataAnswer no escribe: el renglón lo guarda el worker con `log`
})

it('a read that throws DataReadRefusal: the text of its key, OVER_CAP logged, no figure; and it counts for the daily cap', async () => {
  await f.unlock()
  fake.read.mockRejectedValueOnce(new DataReadRefusal('OVER_CAP', 'NOT_AVAILABLE'))
  const out = await ask()
  expect(out).toEqual({ kind: 'refusal', capability: 'fake', text: SUPPORT_DATA_REFUSALS.NOT_AVAILABLE, log: row('OVER_CAP') })
  expect(JSON.stringify(out)).not.toMatch(/12,?345/)
  await recordSupportDataQuery(prisma, out.log!)
  expect(await countDataReadsToday(f.staffId, today())).toBe(1)
})

it.each([
  ['a read that throws', () => fake.read.mockRejectedValueOnce(new Error('connect ECONNREFUSED total 12345.6'))],
  [
    'a read slower than the limit',
    () => {
      // El mínimo es 5 s (por encima del tope de Stripe de C5): con '1' se usaría el default y la lectura sí llegaría
      process.env.SUPPORT_DATA_QUERY_TIMEOUT_SECONDS = '5'
      fake.read.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ total: 12345.6, name: 'Mesa 12' }), 5500)))
    },
  ],
])('%s → SUPPORT_DATA_QUERY_FAILED, QUERY_FAILED, no figure (case 29)', async (_name, arrangeRead) => {
  await f.unlock()
  arrangeRead()
  const log = spyLogger()
  const out = await ask()
  expect(out).toEqual({ kind: 'refusal', capability: 'fake', text: SUPPORT_DATA_QUERY_FAILED, log: row('QUERY_FAILED') })
  expect(amountLeaks(log.args(), [12345.6])).toEqual([]) // el mensaje del error no se registra
  log.restore()
})

it.each([
  [
    'prints `${result.total}` without a hole',
    () => (scope: { timezone: string }, _p: unknown, result: { total: number }) => template(scope.timezone).done(`Total: ${result.total}`),
  ],
  [
    'throws',
    () => () => {
      throw new Error('Mesa 12 sin total 12345.6')
    },
  ],
])(
  'a broken template that %s → SUPPORT_DATA_CHECK_FAILED, CHECK_FAILED, and the figure is nowhere in the outcome (case 28)',
  async (_name, render) => {
    await f.unlock()
    const out = await askWith(dataCatalog({ ...fake, render: render() as typeof fake.render }))
    expect(out).toEqual({ kind: 'refusal', capability: 'fake', text: SUPPORT_DATA_CHECK_FAILED, log: row('CHECK_FAILED') })
    expect(JSON.stringify({ ...out, log: null })).not.toMatch(/12,?345/)
  },
)

it('the answer: text, validity and preparedAt sealed; the access fingerprint carries the role; ANSWERED with an HMAC', async () => {
  await f.unlock()
  const out = await ask()
  if (out.kind !== 'answer') throw new Error(out.text)
  expect(out.envelope.text).toMatch(/^Dato de prueba en Norte \(corte \d{2}:\d{2}\): \$12,345\.60 en Mesa 12$/)
  expect(openDataEnvelope(sealDataEnvelope(out.envelope))).toEqual(out.envelope)
  expect(out.log).toMatchObject({ result: 'ANSWERED', capability: 'fake', venueId: f.northId })
  expect(out.log.paramsHmac).not.toContain('850')
  // la vigencia es la huella de readDataValidity tal cual
  const conversation = await f.conversation()
  const validity = await readDataValidity(prisma, { staffId: f.staffId, venueId: f.northId, linkId: conversation.linkId, now: new Date() })
  expect(out.envelope).toMatchObject({ v: 1, capability: 'fake', validity: validity.fingerprint })
  expect(Date.parse(out.envelope.preparedAt)).toBeGreaterThan(Date.now() - 60_000)
  // la huella de acceso lleva el puesto: la del contexto con el candado de la capacidad, más el rol
  const ctx = await readSupportContext(conversation, capabilityGates(fake))
  expect(out.accessFingerprint).toBe(dataAccessFingerprint(ctx))
  expect(dataAccessFingerprint({ ...ctx, access: { ...ctx.access!, role: 'ADMIN' } })).not.toBe(out.accessFingerprint)
})

// T-B41c: una capacidad nunca lee la configuración; sus topes le llegan en el alcance, que arma el orquestador con getSupportDataConfig().
it('the scope it hands to the read carries the limits of the configuration, also the two of the deposits (T-B41c)', async () => {
  const env = {
    SUPPORT_DATA_ROWS: '3',
    SUPPORT_DATA_OPEN_ORDERS_DAYS: '9',
    SUPPORT_DATA_DEPOSIT_GROUPS: '17',
    SUPPORT_DATA_DEPOSIT_TIMEOUT_SECONDS: '4',
  }
  Object.assign(process.env, env)
  try {
    await f.unlock()
    expect((await ask()).kind).toBe('answer')
    expect(fake.read).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: f.northId, rows: 3, openOrdersDays: 9, depositGroups: 17, depositTimeoutMs: 4_000 }),
      expect.anything(),
    )
  } finally {
    for (const key of Object.keys(env)) delete process.env[key]
  }
})

it('openDataEnvelope: null for nothing, garbage or the wrong shape', () => {
  expect(openDataEnvelope(null)).toBeNull()
  expect(openDataEnvelope('bm90IGEgY2lwaGVy')).toBeNull()
  expect(openDataEnvelope(sealDataEnvelope({ v: 2 } as never))).toBeNull()
  expect(openDataEnvelope(sealDataEnvelope({ v: 1, capability: 'fake', text: 'x', validity: 'v', preparedAt: 'ayer' }))).toBeNull()
})

it('ADMIN → MANAGER with the same permissions: the context fingerprint does not move, the data fingerprint does', async () => {
  await arrange('ADMIN → MANAGER with the same permissions')
  const conversation = await f.conversation()
  const asAdmin = await readSupportContext(conversation, capabilityGates(fake))
  await apply('ADMIN → MANAGER with the same permissions')
  const asManager = await readSupportContext(conversation, capabilityGates(fake))
  expect([asAdmin.access?.role, asManager.access?.role]).toEqual(['ADMIN', 'MANAGER'])
  expect(asManager.fingerprint).toBe(asAdmin.fingerprint)
  expect(dataAccessFingerprint(asManager)).not.toBe(dataAccessFingerprint(asAdmin))
})

it('a venue named like a card number is omitted in the answer, and no refusal names the venue (Review Focus 3, T-B43)', async () => {
  await prisma.venue.update({ where: { id: f.northId }, data: { name: 'Sucursal 4111 1111 1111 1111' } })
  await f.unlock()
  const out = await ask()
  if (out.kind !== 'answer') throw new Error(out.text)
  expect(out.envelope.text).toMatch(/^Dato de prueba en \[dato omitido\] \(corte \d{2}:\d{2}\): \$12,345\.60 en Mesa 12$/)
  const other = await ask({ otherVenue: true })
  expect(other).toMatchObject({ text: SUPPORT_DATA_OTHER_VENUE })
  await f.grant({ permissions: [], features: ['RESERVATIONS'] })
  const denied = await ask()
  expect(denied).toMatchObject({ text: supportDataNoPermission('el dato de prueba') })
  for (const text of [out.envelope.text, JSON.stringify(other), JSON.stringify(denied)]) expect(text).not.toContain('4111')
})

it('a changed password: ForbiddenError, never an answer (case 15)', async () => {
  await f.unlock()
  await apply('a changed password')
  await expect(ask()).rejects.toBeInstanceOf(ForbiddenError)
  expect(fake.read).not.toHaveBeenCalled()
})

it('a venue the person no longer has: the plain error of getUserAccess passes through, never QUERY_FAILED and never a log row (Codex plan r2 #2)', async () => {
  await f.unlock()
  await apply('StaffVenue.active = false with an active MEMBER membership')
  const err = await ask().catch(e => e)
  expect(err).toBeInstanceOf(Error)
  expect(isSupportAccessLost(err)).toBe(true)
  expect(fake.read).not.toHaveBeenCalled()
  expect(await logged()).toEqual([])
})

it('a negative total reaches the person as «−$12,345.60»: ANSWERED, never CHECK_FAILED (Codex plan r1 #1)', async () => {
  await f.unlock()
  fake.read.mockResolvedValueOnce({ total: -12345.6, name: 'Mesa 12' })
  const out = await ask()
  if (out.kind !== 'answer') throw new Error(out.text)
  expect(out.envelope.text).toContain('−$12,345.60 en Mesa 12')
  expect(out.log.result).toBe('ANSWERED')
})

it('amountLeaks catches a read that logs its total as a number (Codex plan r1 #2)', async () => {
  await f.unlock()
  const log = spyLogger()
  fake.read.mockImplementationOnce(async () => {
    logger.info('fake read', { total: 12345.6, rows: 3 })
    return { total: 12345.6, name: 'Mesa 12' }
  })
  await ask()
  expect(amountLeaks(log.args(), [12345.6])).toEqual(['12345.6'])
  log.restore()
})

it('the orchestrator itself logs no amount of an answer', async () => {
  await f.unlock()
  const log = spyLogger()
  expect((await ask()).kind).toBe('answer')
  expect(amountLeaks(log.args(), [12345.6])).toEqual([])
  log.restore()
})

describe('checkDataDelivery', () => {
  const prepared = async () => {
    await f.unlock()
    const out = await ask()
    if (out.kind !== 'answer') throw new Error(out.text)
    return out
  }
  const check = async (out: Awaited<ReturnType<typeof prepared>>, now = new Date()) =>
    checkDataDelivery(await f.conversation(), out.accessFingerprint, out.envelope, now, FAKE)

  it('OK right after preparing; a second tap of the button keeps it OK', async () => {
    const out = await prepared()
    expect(await check(out)).toBe('OK')
    await f.unlock()
    expect(await check(out)).toBe('OK')
  })
  it('OFF with the switch off (case 33)', async () => {
    const out = await prepared()
    process.env.SUPPORT_DATA_ENABLED = 'false'
    expect(await check(out)).toBe('OFF')
  })
  it('STALE without an envelope, or when its capability left the catalog', async () => {
    const out = await prepared()
    expect(await checkDataDelivery(await f.conversation(), out.accessFingerprint, null, new Date(), FAKE)).toBe('STALE')
    expect(await checkDataDelivery(await f.conversation(), out.accessFingerprint, out.envelope, new Date(), dataCatalog())).toBe('STALE')
    const off = { ...fake, available: async () => false }
    expect(await checkDataDelivery(await f.conversation(), out.accessFingerprint, out.envelope, new Date(), dataCatalog(off))).toBe('STALE')
  })
  it.each(['permission removed', 'plan removed', 'ADMIN → MANAGER with the same permissions', 'became superadmin'])(
    'ACCESS: %s (case 8)',
    async change => {
      await arrange(change)
      const out = await prepared()
      await apply(change)
      expect(await check(out)).toBe('ACCESS')
    },
  )
  // El cotejo de superadmin por sí solo: el stub no cambia ninguna fila, así que la huella de acceso es la misma de la preparación.
  it('ACCESS for a superadmin even when the access fingerprint did not move', async () => {
    const out = await prepared()
    jest.spyOn(mcpScope, 'isActiveSuperAdmin').mockResolvedValue(true)
    expect(dataAccessFingerprint(await readSupportContext(await f.conversation(), capabilityGates(fake)))).toBe(out.accessFingerprint)
    expect(await check(out)).toBe('ACCESS')
  })
  // El orden de los pasos 4 y 5: cambió el acceso Y la vigencia → ACCESS (cancela en silencio y la plática sigue personal).
  it('ACCESS, not STALE, when a permission was removed AND the unlock deleted', async () => {
    const out = await prepared()
    await apply('permission removed')
    await apply('unlock deleted')
    expect(await check(out)).toBe('ACCESS')
  })
  it.each<[string, () => Promise<boolean>]>([
    [
      'throws',
      () => {
        throw new Error('available failed')
      },
    ],
    ['rejects', () => Promise.reject(new Error('available failed'))],
  ])('an available() that %s: STALE, and GONE still comes first', async (_how, available) => {
    const out = await prepared()
    const broken: DataCatalog = dataCatalog({ ...fake, available })
    expect(await checkDataDelivery(await f.conversation(), out.accessFingerprint, out.envelope, new Date(), broken)).toBe('STALE')
    await apply('link deleted')
    expect(await checkDataDelivery(await f.conversation(), out.accessFingerprint, out.envelope, new Date(), broken)).toBe('GONE')
  })
  it.each(['timezone changed to America/Cancun', 'unlock deleted', 'notice text changed', 'kycStatus VERIFIED → IN_REVIEW'])(
    'STALE: %s (cases 9, 16 and 40)',
    async change => {
      const out = await prepared()
      await apply(change)
      expect(await check(out)).toBe('STALE')
    },
  )
  // El contexto personal ya no existe: nunca STALE (seguiría personal) ni un error que dependa de su clase (Codex plan r2 #2 y #3)
  it.each([
    'link replaced',
    'link expired',
    'link deleted',
    'StaffVenue.active = false with an active MEMBER membership',
    'org membership deactivated',
  ])('GONE: %s (cases 15 and 50)', async change => {
    const out = await prepared()
    await apply(change)
    expect(await check(out)).toBe('GONE')
  })
  it('GONE wins over OFF and over a missing envelope', async () => {
    const out = await prepared()
    await apply('StaffVenue.active = false with an active MEMBER membership')
    process.env.SUPPORT_DATA_ENABLED = 'false'
    expect(await check(out)).toBe('GONE')
    expect(await checkDataDelivery(await f.conversation(), out.accessFingerprint, null, new Date(), FAKE)).toBe('GONE')
  })
  it('another error of the context read is not swallowed as GONE', async () => {
    const out = await prepared()
    jest.spyOn(prisma.supportWhatsappLink, 'findUnique').mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    await expect(check(out)).rejects.toThrow('ECONNREFUSED')
  })
  it('STALE 11 minutes after preparing (case 10)', async () => {
    const out = await prepared()
    expect(await check(out, new Date(Date.now() + 11 * 60_000))).toBe('STALE')
  })
  it.each([
    ['Norte', 'America/Mexico_City', '2026-11-13T05:59:58Z', '2026-11-13T06:00:03Z'],
    ['Cancún', 'America/Cancun', '2026-11-13T04:59:58Z', '2026-11-13T05:00:03Z'],
  ])(
    "STALE across midnight in %s: prepared at 23:59:58 with that day's unlock, checked at 00:00:03 (case 7)",
    async (_name, tz, before, after) => {
      const venueId = tz === 'America/Cancun' ? f.cancunId : f.northId
      await f.unlock(venueId)
      await prisma.supportDataUnlock.updateMany({
        where: { staffId: f.staffId, venueId },
        data: { day: venueDayKey(new Date(before), tz) },
      })
      const out = await ask({}, await f.conversation(venueId), new Date(before))
      if (out.kind !== 'answer') throw new Error(out.text)
      const at = async (iso: string) =>
        checkDataDelivery(await f.conversation(venueId), out.accessFingerprint, out.envelope, new Date(iso), FAKE)
      expect([await at(before), await at(after)]).toEqual(['OK', 'STALE'])
    },
  )
})
