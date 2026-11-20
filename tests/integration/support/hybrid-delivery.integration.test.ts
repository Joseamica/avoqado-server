import crypto from 'crypto'
import type { SupportOutcome } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { LUNA_SUPPORT_PRICING as pricing, getSupportAiConfig } from '@/config/supportWhatsapp'
import { admitSupportMessage, claimNext } from '@/services/support/store.service'
import { deliverSupportMessage } from '@/services/support/delivery.service'
import { prepareSupportAnswer } from '@/services/support/worker.service'
import { readSupportContext } from '@/services/support/context.service'
import { tryRouteSupport } from '@/services/support/router.service'
import * as knowledge from '@/services/support/knowledge.service'
import { sourceRef, type LibraryGuide, type VerifiedSection } from '@/services/support/knowledge.service'
import { composeSupportAnswer, createSupportAiClient, supportWarnings } from '@/services/support/answer.service'
import { guideIdsOf, literalSupportAnswer, renderSupportAnswer, wholeGuide, type SupportDraft } from '@/services/support/hybrid.service'
import { secondFailureText } from '@/services/support/handoff.service'
import { buildWeeklyReport } from '@/services/support/notices.service'
import {
  SUPPORT_CLARIFY,
  SUPPORT_CLARIFY_CLOSE,
  SUPPORT_ASK_VERSION,
  SUPPORT_GUIDE_TOO_LONG,
  SUPPORT_HYBRID_UNKNOWN,
  SUPPORT_LITERAL_CAP,
  SUPPORT_NO_COVERAGE,
  SUPPORT_OTHER_QUESTION,
  SUPPORT_SEND_RETRY_NOTICE as RETRY,
  supportHandoffDone,
  supportOldVersion,
} from '@/services/support/texts'

const receiverId = `support-hybrid-delivery-${Date.now()}`,
  phone = '+525500007401'
const OPEN_GUIDE = 'Abre la guía que corresponda o escríbenos a hola@avoqado.io.'
const VENUE = 'Viendo Norte. Escribe SUCURSAL para cambiar.'
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const guide = (id: string, title: string, summary: string, extra: Partial<LibraryGuide> = {}): LibraryGuide => ({
  id,
  app: 'dashboard',
  title,
  summary,
  steps: [summary],
  publicUrl: `https://avoqado.io/help/${id}`,
  requiredPermissions: [],
  keywords: [],
  body: summary,
  general: false,
  internal: false,
  hash: hash(`${id}\n${title}\n${summary}`),
  ...extra,
})
const products = guide('dashboard/menu/gestionar-productos', 'Crear productos', 'Da de alta productos y sus precios.')
const inventory = guide('dashboard/inventario/inventario-avanzado', 'Inventario avanzado', 'Controla existencias por ingrediente.')
// The overviews appear once per app in the library, identical except for `app`.
const overview = (app: LibraryGuide['app']) =>
  guide('general/overview', 'Avoqado en general', 'Qué hace cada app de Avoqado.', {
    app,
    general: true,
    publicUrl: 'https://avoqado.io/help',
  })
const library = [products, inventory, overview('dashboard'), overview('tpv')]
/** The same guide after an edit to its file or its manifest entry: same id, new hash. */
const edited = (g: LibraryGuide, change: Partial<LibraryGuide> = {}): LibraryGuide => ({
  ...g,
  summary: `${g.summary} Editada.`,
  steps: [`${g.summary} Editada.`],
  ...change,
  hash: hash(`${g.hash}:${JSON.stringify(change)}`),
})
// T-F6c: an option is its title and its link, never its description.
const clarifyText = (options: LibraryGuide[], close = SUPPORT_CLARIFY_CLOSE) =>
  [SUPPORT_CLARIFY, ...options.map(g => `• ${g.title}: ${g.publicUrl}`), close].join('\n')
const clarifyIds = ['#clarify', sourceRef(products), sourceRef(inventory)]
const section: VerifiedSection = {
  id: 'dashboard/menu/gestionar-productos',
  app: 'dashboard',
  title: 'Crear productos',
  summary: 'Resumen verificado de prueba',
  steps: ['Paso uno verificado', 'Último paso verificado'],
  publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
  keywords: [],
  requiredPermissions: [],
}

let serial = 0,
  wamids = 0
let staffId: string, orgId: string, northId: string, southId: string
const originalFetch = global.fetch
const input = (body: string) => ({
  receiverId,
  phone,
  wamid: `wamid.${receiverId}-${++serial}`,
  type: 'text',
  body,
  timestamp: String(Math.floor(Date.now() / 1000)),
})
async function clean() {
  const ids = (await prisma.supportConversation.findMany({ where: { receiverId }, select: { id: true }, take: 200 })).map(c => c.id)
  await prisma.supportEvent.deleteMany({ where: { conversationId: { in: ids } } })
  await prisma.supportNotice.deleteMany({ where: { conversationId: { in: ids } } })
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${receiverId}:` } } })
}
beforeAll(async () => {
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    SUPPORT_AI_ENABLED: 'true',
    SUPPORT_AI_MODEL: pricing.model,
    SUPPORT_AI_PRICING_VERSION: pricing.version,
    SUPPORT_AI_MONTHLY_USD_LIMIT: '10',
    SUPPORT_OPENAI_API_KEY: 'fixture-never-used',
    WHATSAPP_ACCESS_TOKEN: 'fixture-never-used',
  })
  orgId = (
    await prisma.organization.create({ data: { name: 'Hybrid delivery fixture', email: `${receiverId}-org@test.local`, phone: '0' } })
  ).id
  northId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Norte', slug: `${receiverId}-norte`, status: 'ACTIVE' } }))
    .id
  southId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Sur', slug: `${receiverId}-sur`, status: 'ACTIVE' } })).id
  // A registered phone with two venues: free text answers it, and a personal answer carries the venue line.
  staffId = (
    await prisma.staff.create({
      data: { email: `${receiverId}-staff@test.local`, firstName: 'Envío', lastName: 'Híbrido', emailVerified: true, phone },
    })
  ).id
  await prisma.staffOrganization.create({ data: { staffId, organizationId: orgId, role: 'MEMBER' } })
  await prisma.staffVenue.createMany({
    data: [
      { staffId, venueId: northId, role: 'VIEWER' },
      { staffId, venueId: southId, role: 'VIEWER' },
    ],
  })
})
beforeEach(async () => {
  await clean()
  process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
  process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'true'
})
afterEach(async () => {
  global.fetch = originalFetch
  jest.restoreAllMocks()
  delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
  delete process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED
  await clean()
  await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
  await prisma.staffVenue.updateMany({ where: { staffId }, data: { role: 'VIEWER' } })
})
afterAll(async () => {
  await clean()
  if (!staffId) return
  await prisma.staffVenue.deleteMany({ where: { staffId } })
  await prisma.staffOrganization.deleteMany({ where: { staffId } })
  await prisma.venue.deleteMany({ where: { id: { in: [northId, southId] } } })
  await prisma.organization.delete({ where: { id: orgId } })
  await prisma.staff.delete({ where: { id: staffId } })
})

const open = () => prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone, mode: { not: 'CLOSED' } } })
async function enqueue(body = '¿Cómo creo un producto?', app = 'dashboard') {
  const { messageId } = await admitSupportMessage(input(body))
  await prisma.supportConversation.updateMany({
    where: { receiverId, phone, mode: { not: 'CLOSED' } },
    data: { noticeAcceptedAt: new Date(), app, lastUserMessageAt: new Date(), lastActivityAt: new Date() },
  })
  return messageId
}
async function personal() {
  const link = await prisma.supportWhatsappLink.create({
    data: { staffId, phone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) },
  })
  await prisma.supportConversation.updateMany({
    where: { receiverId, phone, mode: { not: 'CLOSED' } },
    data: { mode: 'PERSONAL', staffId, linkId: link.id, orgId, venueId: northId },
  })
}
type Status = 'ANSWER_READY' | 'SENT' | 'SEND_UNKNOWN'
/** A message the worker already answered; its fingerprint is read as the worker does, with the guides as drafted. */
async function answered(
  answer: string,
  sourceIds: string[],
  drafted: LibraryGuide[],
  options: { status?: Status; personal?: boolean; body?: string; app?: string; conversation?: Record<string, unknown> } = {},
) {
  const id = await enqueue(options.body, options.app)
  if (options.personal) await personal()
  if (options.conversation)
    await prisma.supportConversation.updateMany({ where: { receiverId, phone, mode: { not: 'CLOSED' } }, data: options.conversation })
  const accessFingerprint = (await readSupportContext(await open(), drafted)).fingerprint
  await prisma.supportMessage.update({
    where: { id },
    data: { status: options.status ?? 'ANSWER_READY', answer, sourceIds, accessFingerprint },
  })
  return id
}
/** The SEND of this answer is uncertain: REINTENTAR may resend it once. */
async function uncertain(answer: string, sourceIds: string[], drafted: LibraryGuide[]) {
  const id = await answered(answer, sourceIds, drafted, { status: 'SEND_UNKNOWN' })
  await prisma.supportAttempt.create({
    data: { messageId: id, kind: 'SEND', ordinal: 1, claimToken: 'fixture', state: 'UNKNOWN', pricingVersion: 'whatsapp-service-v1' },
  })
  return id
}
const claim = () => claimNext(new Date(Date.now() + 10), receiverId)
const saved = (id: string) => prisma.supportMessage.findUniqueOrThrow({ where: { id } })
const closeConversation = () =>
  prisma.supportConversation.updateMany({ where: { receiverId, phone, mode: { not: 'CLOSED' } }, data: { mode: 'CLOSED' } })
/** Delivers the next claim through a fake Meta and returns what was posted, if anything. `null` = no injected library. */
async function deliver(lib: LibraryGuide[] | null = library, sections?: VerifiedSection[]) {
  const meta = jest.fn(
    async () => new Response(JSON.stringify({ messages: [{ id: `wamid.${receiverId}-out-${++wamids}` }] }), { status: 200 }),
  )
  global.fetch = meta as unknown as typeof fetch
  const result = await deliverSupportMessage((await claim())!, sections, lib ?? undefined)
  const call = meta.mock.calls[0] as unknown as [string, RequestInit] | undefined
  return { result, body: call ? (JSON.parse(String(call[1].body)).text.body as string) : undefined }
}
const notice = { result: 'CANCELLED', body: undefined }

describe('sending a hybrid answer', () => {
  it.each([
    ['fits', 'Respuesta redactada y revisada.', `${VENUE}\n\nRespuesta redactada y revisada.`],
    ['does not fit', 'x'.repeat(1480), 'x'.repeat(1480)],
  ])('hybrid: sends the saved answer when hashes match, with the venue notice when it %s', async (_label, answer, expected) => {
    const id = await answered(answer, [sourceRef(products)], [products], { personal: true })
    expect(await deliver()).toEqual({ result: 'SENT', body: expected })
    expect(await saved(id)).toMatchObject({ status: 'SENT', answer: expected })
  })

  it.each([
    ['without', ''],
    ['with', `${RETRY}\n\n`],
  ])(
    'personal with two venues: a saved answer %s the resend notice keeps exactly one current venue line, before the notice',
    async (_label, prefix) => {
      await answered(`${prefix}${VENUE}\n\nRespuesta redactada.`, [sourceRef(products)], [products], { personal: true })
      const sent = await deliver()
      expect(sent).toEqual({ result: 'SENT', body: `${VENUE}\n\n${prefix}Respuesta redactada.` })
      expect(sent.body!.match(/Escribe SUCURSAL/g)).toHaveLength(1)
    },
  )

  it('hybrid: a guide edited after drafting (same id, new hash) sends the literal current guide', async () => {
    await answered('Respuesta redactada con la guía anterior.', [sourceRef(products)], [products])
    const current = edited(products)
    expect(await deliver([current, inventory])).toEqual({ result: 'SENT', body: literalSupportAnswer([current], null) })
  })

  // T-F5 (todo o nada; antes salía la literal de la que quedaba, con las fuentes de las dos): una guía guardada que ya no está
  // nunca deja salir sola a la otra. La entrega guarda SUPPORT_NO_COVERAGE sin fuentes y lo manda en la siguiente vuelta.
  it.each([
    ['one of two', [inventory]],
    ['every one', []],
  ])('hybrid: a missing guide (%s) is never delivered in part: SUPPORT_NO_COVERAGE without sources (T-F5)', async (_label, lib) => {
    const id = await answered('Respuesta redactada con dos guías.', [sourceRef(products), sourceRef(inventory)], [products, inventory])
    expect(await deliver(lib)).toEqual(notice)
    expect(await saved(id)).toMatchObject({ status: 'ANSWER_READY', answer: SUPPORT_NO_COVERAGE, sourceIds: [] })
    expect(await deliver(lib)).toEqual({ result: 'SENT', body: SUPPORT_NO_COVERAGE })
    expect(await saved(id)).toMatchObject({ status: 'SENT', answer: SUPPORT_NO_COVERAGE, sourceIds: [] })
  })

  // T-F5 (Codex P1, todo o nada): la cola reconstruye con la guía de HOY. Si ahora pide una versión que no se sabe, se pregunta
  // la versión como a una pregunta nueva (sin fuentes, sin la otra guía); si ya no le toca, SUPPORT_NO_COVERAGE.
  const onAndroid = (g: LibraryGuide): LibraryGuide => {
    const id = g.id.replace(/^dashboard\//, 'android/')
    return { ...g, id, app: 'android', publicUrl: `https://avoqado.io/help/${id}` }
  }
  it.each([
    ['alone', false],
    ['next to a panel guide that still fits', true],
  ])(
    'hybrid: a guide that now needs an unknown version is never rebuilt, %s: asks the version, without sources (T-F5)',
    async (_label, withPanel) => {
      const before = onAndroid(products)
      const refs = [sourceRef(before), ...(withPanel ? [sourceRef(inventory)] : [])]
      const id = await answered('Respuesta redactada.', refs, [before, ...(withPanel ? [inventory] : [])], { app: 'android' })
      const lib = [edited(before, { versionMin: '2.25.7' }), inventory]
      expect(await deliver(lib)).toEqual(notice)
      expect(await saved(id)).toMatchObject({ status: 'ANSWER_READY', answer: SUPPORT_ASK_VERSION, sourceIds: [] })
      const conversation = await open()
      expect(conversation).toMatchObject({ pendingSelection: 'VERSION' })
      expect(conversation.selectionOptions).toEqual({ topic: '¿Cómo creo un producto?', items: [] })
      // The next round sends the question, with the usual checks.
      expect(await deliver(lib)).toEqual({ result: 'SENT', body: SUPPORT_ASK_VERSION })
    },
  )

  it('hybrid: a guide that no longer fits the known version is never rebuilt with the rest: SUPPORT_NO_COVERAGE without sources (T-F5)', async () => {
    const before = onAndroid(products)
    const id = await answered('Respuesta redactada.', [sourceRef(before), sourceRef(inventory)], [before, inventory], { app: 'android' })
    await prisma.supportConversation.updateMany({ where: { receiverId, phone, mode: { not: 'CLOSED' } }, data: { appVersion: '2.25.0' } })
    await prisma.supportMessage.update({
      where: { id },
      data: { accessFingerprint: (await readSupportContext(await open(), [before, inventory])).fingerprint },
    })
    const lib = [edited(before, { versionMax: '2.24.0' }), inventory]
    expect(await deliver(lib)).toEqual(notice)
    expect(await saved(id)).toMatchObject({ status: 'ANSWER_READY', answer: SUPPORT_NO_COVERAGE, sourceIds: [] })
    expect((await open()).pendingSelection).toBeNull()
    expect(await deliver(lib)).toEqual({ result: 'SENT', body: SUPPORT_NO_COVERAGE })
  })

  // T-F5 (Codex r2-3): las fuentes de lo que sale son exactamente las guías que muestra, también al reconstruir y sin el híbrido.
  it.each(['true', 'false'])('hybrid flag %s: a rebuilt answer shows every guide its sources name, and only those (T-F5)', async flag => {
    const id = await answered('Respuesta redactada.', [sourceRef(products), sourceRef(inventory)], [products, inventory])
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = flag
    const current = edited(products)
    const sent = await deliver([current, inventory])
    expect(sent).toEqual({ result: 'SENT', body: literalSupportAnswer([current, inventory], null) })
    expect(guideIdsOf((await saved(id)).sourceIds)).toEqual([products.id, inventory.id])
    for (const g of [current, inventory]) expect(sent.body).toContain(g.title)
  })

  it('hybrid: fingerprint change → public notice', async () => {
    const id = await answered('Respuesta redactada.', [sourceRef(products)], [products])
    await prisma.supportConversation.updateMany({ where: { receiverId, phone, mode: { not: 'CLOSED' } }, data: { appVersion: '2.25.1' } })
    expect(await deliver()).toEqual(notice)
    expect((await saved(id)).answer).toMatch(/^Tu acceso cambió/)
  })

  it("answers prepared before enabling the flag (ids without @) follow today's path", async () => {
    const spy = jest.spyOn(knowledge, 'loadSupportLibrary')
    await answered('Respuesta de antes de la flag.', [section.id], [])
    expect(await deliver(null, [section])).toEqual({ result: 'SENT', body: composeSupportAnswer([section], null) })
    expect(spy).not.toHaveBeenCalled()
  })

  it('flag off: delivery identical to today', async () => {
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'false'
    process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'false'
    await answered('Respuesta de antes de la flag.', [section.id], [])
    expect(await deliver(null, [section])).toEqual({ result: 'SENT', body: composeSupportAnswer([section], null) })
  })

  it.each([
    ['hybrid', 'SUPPORT_WHATSAPP_HYBRID_ENABLED'],
    ['free text', 'SUPPORT_WHATSAPP_FREE_TEXT_ENABLED'],
  ])('flag turned off (%s) with a hybrid answer pending: sends the literal guide, not SUPPORT_NO_COVERAGE', async (_label, flag) => {
    await answered('Respuesta redactada que ya no se envía.', [sourceRef(products)], [products])
    process.env[flag] = 'false'
    expect(await deliver()).toEqual({ result: 'SENT', body: literalSupportAnswer([products], null) })
  })

  it.each<[string, Partial<LibraryGuide>]>([
    [
      'a manifest gate change after drafting changes the fingerprint → public notice (accepted rare case)',
      { activationKey: 'enableShifts' },
    ],
    ['a content-only change with the same fingerprint → literal of the current guide', {}],
  ])('%s', async (_label, change) => {
    const id = await answered('Respuesta redactada.', [sourceRef(products)], [products], { personal: true })
    const current = edited(products, change)
    const sent = await deliver([current])
    if (change.activationKey) {
      expect(sent).toEqual(notice)
      expect((await saved(id)).answer).toMatch(/^Tu acceso cambió/)
    } else {
      const { access } = await readSupportContext(await open(), [current])
      expect(access).not.toBeNull()
      expect(sent).toEqual({ result: 'SENT', body: literalSupportAnswer([current], access, VENUE) })
    }
  })

  it('permission revoked AND guide changed before sending → public notice (revocation always detected)', async () => {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId, venueId: northId } }, data: { role: 'MANAGER' } })
    const id = await answered('Respuesta redactada.', [sourceRef(products)], [products], { personal: true })
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId, venueId: northId } }, data: { role: 'VIEWER' } })
    expect(await deliver([edited(products)])).toEqual(notice)
    expect((await saved(id)).answer).toMatch(/^Tu acceso cambió/)
  })
})

describe('a #clarify message', () => {
  it('is sent as saved, also with a venue notice prepended', async () => {
    const text = clarifyText([products, inventory])
    await answered(text, clarifyIds, [products, inventory], { personal: true })
    expect(await deliver()).toEqual({ result: 'SENT', body: `${VENUE}\n\n${text}` })
  })

  it('is rebuilt with the current titles if a ref changed (never an option picked); < 2 left → SUPPORT_HYBRID_UNKNOWN', async () => {
    const renamed = edited(inventory, { title: 'Inventario por insumo' })
    await answered(clarifyText([products, inventory]), clarifyIds, [products, inventory])
    expect(await deliver([products, renamed])).toEqual({ result: 'SENT', body: clarifyText([products, renamed]) })
    await answered(clarifyText([products, inventory]), clarifyIds, [products, inventory])
    expect(await deliver([products])).toEqual({ result: 'SENT', body: SUPPORT_HYBRID_UNKNOWN })
  })

  it('flag off: a pending clarification is rebuilt ending in «Abre la guía que corresponda…»', async () => {
    await answered(clarifyText([products, inventory]), clarifyIds, [products, inventory])
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'false'
    expect(await deliver()).toEqual({ result: 'SENT', body: clarifyText([products, inventory], OPEN_GUIDE) })
  })
})

describe('RECUPERAR, REINTENTAR and PERSONA', () => {
  it.each(['true', 'false'])('RECUPERAR of general/overview and of a dashboard guide asked from tpv (hybrid flag %s)', async flag => {
    const refs = [sourceRef(products), sourceRef(overview('tpv'))]
    await answered('Respuesta redactada.', refs, [products, overview('tpv')], { status: 'SENT', app: 'tpv' })
    await closeConversation()
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = flag
    const id = await enqueue('RECUPERAR', 'tpv')
    expect(await prepareSupportAnswer((await claim())!, { library })).toBe('READY')
    // Any copy of an overview resolves the id: they are identical.
    expect(await saved(id)).toMatchObject({ answer: literalSupportAnswer([products, overview('tpv')], null), sourceIds: refs })
  })

  // T-F3 (Codex P1, su repro): una plática cerrada guardó una guía de ANDROID de la 2.25.7; otra sin versión la recupera.
  const stamp: LibraryGuide = {
    ...guide('android/lealtad/sello-que-no-se-sumo', 'Un sello que no se sumó', 'Agrega el cliente a la venta y toca Cobrar.'),
    app: 'android',
    versionMin: '2.25.7',
  }
  it('RECUPERAR of a guide from 2.25.7 with the version unknown asks the version; «2.25.7» then recovers it (T-F3)', async () => {
    await answered('Respuesta redactada.', [sourceRef(stamp)], [stamp], { status: 'SENT', app: 'android' })
    await closeConversation()
    const id = await enqueue('RECUPERAR', 'android')
    expect(await prepareSupportAnswer((await claim())!, { library: [...library, stamp] })).toBe('READY')
    expect(await saved(id)).toMatchObject({ answer: SUPPORT_ASK_VERSION, sourceIds: [] })
    expect(await open()).toMatchObject({ pendingSelection: 'VERSION', selectionOptions: { topic: 'RECUPERAR', items: [] } })
    await prisma.supportMessage.update({ where: { id }, data: { status: 'SENT' } })
    expect(await tryRouteSupport(input('2.25.7'))).toBe('QUEUED')
    const again = (await claim())!
    expect(await prepareSupportAnswer(again, { library: [...library, stamp] })).toBe('READY')
    expect(await saved(again.messageId)).toMatchObject({ answer: literalSupportAnswer([stamp], null), sourceIds: [sourceRef(stamp)] })
  })

  it('RECUPERAR of a 2.25.7 guide next to a panel guide, with the version unknown: asks the version, never the panel guide alone (T-F5)', async () => {
    await answered('Respuesta redactada.', [sourceRef(stamp), sourceRef(products)], [stamp, products], { status: 'SENT', app: 'android' })
    await closeConversation()
    const id = await enqueue('RECUPERAR', 'android')
    expect(await prepareSupportAnswer((await claim())!, { library: [...library, stamp] })).toBe('READY')
    expect(await saved(id)).toMatchObject({ answer: SUPPORT_ASK_VERSION, sourceIds: [] })
    const conversation = await open()
    expect(conversation).toMatchObject({ pendingSelection: 'VERSION' })
    expect(conversation.selectionOptions).toEqual({ topic: 'RECUPERAR', items: [] })
  })

  it.each([
    ['one no longer fits the known version', '2.25.0', [...library, stamp]],
    ['one is gone from the library', '2.25.7', library],
  ])('RECUPERAR of two saved guides when %s recovers nothing, not the other alone (T-F5)', async (_label, appVersion, lib) => {
    await answered('Respuesta redactada.', [sourceRef(stamp), sourceRef(products)], [stamp, products], { status: 'SENT', app: 'android' })
    await closeConversation()
    const id = await enqueue('RECUPERAR', 'android')
    await prisma.supportConversation.updateMany({ where: { receiverId, phone, mode: { not: 'CLOSED' } }, data: { appVersion } })
    expect(await prepareSupportAnswer((await claim())!, { library: lib })).toBe('READY')
    expect(await saved(id)).toMatchObject({ sourceIds: [] })
    expect((await saved(id)).answer).toMatch(/^No encontré una guía guardada vigente para esa app\./)
  })

  it('RECUPERAR of a guide for another version that no longer fits is not recovered (T-F3)', async () => {
    await answered('Respuesta redactada.', [sourceRef(stamp)], [stamp], { status: 'SENT', app: 'android' })
    await closeConversation()
    const id = await enqueue('RECUPERAR', 'android')
    await prisma.supportConversation.updateMany({ where: { receiverId, phone, mode: { not: 'CLOSED' } }, data: { appVersion: '2.25.0' } })
    expect(await prepareSupportAnswer((await claim())!, { library: [...library, stamp] })).toBe('READY')
    expect((await saved(id)).answer).toMatch(/^No encontré una guía guardada vigente para esa app\./)
  })

  it('RECUPERAR after a clarification returns the last real answer', async () => {
    await answered('Respuesta redactada.', [sourceRef(products)], [products], { status: 'SENT' })
    await answered(clarifyText([products, inventory]), clarifyIds, [products, inventory], { status: 'SENT', body: 'inventario' })
    await closeConversation()
    const id = await enqueue('RECUPERAR')
    expect(await prepareSupportAnswer((await claim())!, { library })).toBe('READY')
    expect(await saved(id)).toMatchObject({ answer: literalSupportAnswer([products], null), sourceIds: [sourceRef(products)] })
  })

  it.each([
    ['fits', 'Respuesta redactada.', (answer: string) => `${RETRY}\n\n${answer}`],
    ['does not fit', 'x'.repeat(1450), () => literalSupportAnswer([products], null, RETRY)],
  ])('REINTENTAR with a notice that %s', async (_label, answer, expected) => {
    const first = await uncertain(answer, [sourceRef(products)], [products])
    const retry = await enqueue('REINTENTAR')
    expect(await prepareSupportAnswer((await claim())!, { library })).toBe('READY')
    expect(await saved(retry)).toMatchObject({ retryOfId: first, answer: expected(answer), sourceIds: [sourceRef(products)] })
  })

  it('REINTENTAR of an answer whose guide is gone: the resend is never partial, the delivery replaces it with SUPPORT_NO_COVERAGE (T-F5)', async () => {
    const first = await uncertain('x'.repeat(1450), [sourceRef(products), sourceRef(inventory)], [products, inventory])
    const retry = await enqueue('REINTENTAR')
    expect(await prepareSupportAnswer((await claim())!, { library: [inventory] })).toBe('READY')
    expect(await deliver([inventory])).toEqual(notice)
    expect(await saved(retry)).toMatchObject({ retryOfId: first, answer: SUPPORT_NO_COVERAGE, sourceIds: [] })
    expect(await deliver([inventory])).toEqual({ result: 'SENT', body: SUPPORT_NO_COVERAGE })
  })

  it('REINTENTAR of an uncertain clarification resends the clarification', async () => {
    const text = clarifyText([products, inventory])
    const first = await uncertain(text, clarifyIds, [products, inventory])
    const retry = await enqueue('REINTENTAR')
    expect(await prepareSupportAnswer((await claim())!, { library })).toBe('READY')
    expect(await saved(retry)).toMatchObject({ retryOfId: first, answer: `${RETRY}\n\n${text}`, sourceIds: clarifyIds })
    expect(await deliver()).toEqual({ result: 'SENT', body: `${RETRY}\n\n${text}` })
  })

  it.each(['true', 'false'])('PERSONA summary lists titles of hybrid refs (hybrid flag %s)', async flag => {
    await answered('Respuesta redactada.', [sourceRef(products)], [products], { status: 'SENT' })
    await answered(clarifyText([products, inventory]), clarifyIds, [products, inventory], { status: 'SENT', body: 'inventario' })
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = flag
    // The router reads the signed library itself: here it is the fixture's.
    jest.spyOn(knowledge, 'loadSupportLibrary').mockReturnValue(library)
    const event = input('PERSONA')
    expect(await tryRouteSupport(event)).toBe('QUEUED')
    const summary = (await prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: event.wamid } } })).answer!
    expect(summary).toContain(`Guía intentada: ${products.title}\n${products.publicUrl}\n`)
    expect(summary).toContain(`Se le ofrecieron: ${products.title}, ${inventory.title}\n`)
    expect(summary).not.toContain('Tema: por describir')
    expect(summary.length).toBeLessThanOrEqual(1500)
  })
})

// T-F7 to T-F12 shipped a draft the judge said lacked a condition with that line of the guide in an «Importante» block. T-F13
// (PARADA): the judge's `missing` ({guideId, line}) is only a signal. A real line of the cited guide sends the literal guide (whole
// up to SUPPORT_LITERAL_CAP, else its card) as a rejection, JUDGE_LITERAL; a number that is not one says nothing, and the draft goes
// as drafted. Three model calls either way; what goes out is what is saved and recorded.
describe('T-F13: any missing signal sends the whole guide (JUDGE_LITERAL), fail-safe since T-F13b', () => {
  const recipe = guide(
    'dashboard/inventario/receta-que-no-descuenta',
    'Receta que no descuenta',
    'Revisa por qué una receta no descuenta.',
    {
      body: 'Abre la receta en Inventario y toca editar. Si el producto no rastrea inventario, la receta no descuenta sus ingredientes.',
    },
  )
  const lib = [recipe, ...library]
  const understood = { kind: 'question', standalone: '¿Por qué mi receta no descuenta?', guideIds: [recipe.id] }
  const draft: SupportDraft = {
    covered: true,
    intro: null,
    steps: [
      { text: 'Abre la receta en Inventario y toca editar.', guideId: recipe.id, quote: 'Abre la receta en Inventario y toca editar' },
    ],
  }
  // Line 2 of the recipe body: «Si el producto no rastrea inventario, la receta no descuenta sus ingredientes.»
  const missing = [{ guideId: recipe.id, line: 2 }]
  const condition = 'Si el producto no rastrea inventario, la receta no descuenta sus ingredientes.'
  function provider(replies: object[]) {
    let n = 0
    const fetcher = jest.fn(async (_url: unknown, _init?: unknown) => {
      const reply = replies[n++]
      if (!reply) throw new TypeError('fixture: no reply configured for this call')
      return new Response(
        JSON.stringify({
          id: `resp_${n}`,
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(reply), annotations: [] }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    return { fetcher, client: createSupportAiClient(getSupportAiConfig()!, fetcher as unknown as typeof fetch) }
  }
  const eventsOf = async (id: string) => {
    const m = await saved(id)
    return (
      await prisma.supportEvent.findMany({
        where: { conversationId: m.conversationId, sequence: m.sequence },
        orderBy: { createdAt: 'asc' },
        take: 10,
      })
    ).map(e => ({ kind: e.kind, guideIds: e.guideIds }))
  }
  beforeEach(() => {
    // The typing indicator never leaves the test.
    global.fetch = jest.fn(async () => new Response('{"success":true}', { status: 200 })) as unknown as typeof fetch
  })

  it('a real missing line: the whole guide, JUDGE_LITERAL, with the guide as source; sent as saved, never with «Importante»', async () => {
    const id = await enqueue('¿Por qué mi receta no descuenta?')
    const p = provider([understood, draft, { supported: true, missing }])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: lib })).toBe('READY')
    expect(p.fetcher).toHaveBeenCalledTimes(3)
    const answer = literalSupportAnswer([recipe], null)
    expect(answer).toContain(condition)
    expect(answer).not.toContain('Importante:')
    expect(await saved(id)).toMatchObject({ status: 'ANSWER_READY', outcome: 'JUDGE_LITERAL', answer, sourceIds: [sourceRef(recipe)] })
    const sent = await deliver(lib)
    expect(sent).toEqual({ result: 'SENT', body: answer })
    expect(await saved(id)).toMatchObject({ status: 'SENT', outcome: 'JUDGE_LITERAL', answer, sourceIds: [sourceRef(recipe)] })
  })

  // T-F13b (fail-safe): a number that is not a line of the cited guide still means the judge saw something missing, so the
  // whole guide goes out, never the incomplete draft.
  it('a number that is not a line of the cited guide still sends the whole guide (fail-safe), never the draft without its condition', async () => {
    const id = await enqueue('¿Por qué mi receta no descuenta?')
    const p = provider([understood, draft, { supported: true, missing: [{ guideId: recipe.id, line: 3 }] }])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: lib })).toBe('READY')
    expect(p.fetcher).toHaveBeenCalledTimes(3)
    const answer = literalSupportAnswer([recipe], null)
    expect(answer).toContain(condition)
    expect(answer).not.toBe(renderSupportAnswer(draft, [recipe], null))
    expect(await saved(id)).toMatchObject({ outcome: 'JUDGE_LITERAL', answer, sourceIds: [sourceRef(recipe)] })
    expect(await deliver(lib)).toEqual({ result: 'SENT', body: answer })
  })
})

// T-F10c (ruling T-F10c, «lo seguro debe ser lo completo»): the literal guide goes WHOLE up to SUPPORT_LITERAL_CAP (3,500) on every
// path that sends or resends it: the worker's fallback, RECUPERAR, REINTENTAR, the queue rebuild (hybrid on and off), and the
// delivery, where the venue line goes in front only while the whole still fits and the last guard holds it to the cap. What is
// recorded is what went out. Over the cap, the card as before. Nothing ever passes 3,500, far under WhatsApp's 4,096.
describe('T-F10c: the literal guide goes whole up to 3,500 on every path', () => {
  const pasos = (n: number) => Array.from({ length: n }, (_, i) => `${i + 2}. ${'detalle de la liga de pago '.repeat(5)}`).join('\n')
  const ligaBody = (n: number) =>
    `## Pasos\n1. Abre la sección de ventas y crea la liga.\n${pasos(n)}\n\n## Problemas frecuentes\n- Si la liga no abre, no la reenvíes: créala otra vez.`
  // ~2,800 characters whole, like crear-liga-pago (2,868), the longest real guide under the cap.
  const liga = guide('dashboard/ventas/liga-larga', 'Crear una liga larga', 'Crea una liga de pago.', { body: ligaBody(19) })
  const huge = guide('dashboard/ventas/liga-enorme', 'Crear una liga enorme', 'Crea una liga de pago enorme.', { body: ligaBody(30) })
  const lib = [liga, huge, ...library]
  const understood = (g: LibraryGuide) => ({ kind: 'question', standalone: '¿Cómo creo una liga de pago?', guideIds: [g.id] })
  const draftOn = (g: LibraryGuide): SupportDraft => ({
    covered: true,
    intro: null,
    steps: [{ text: 'Abre la sección de ventas y crea la liga.', guideId: g.id, quote: 'Abre la sección de ventas y crea la liga' }],
  })
  function provider(replies: object[]) {
    let n = 0
    const fetcher = jest.fn(async (_url: unknown, _init?: unknown) => {
      const reply = replies[n++]
      if (!reply) throw new TypeError('fixture: no reply configured for this call')
      return new Response(
        JSON.stringify({
          id: `resp_${n}`,
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(reply), annotations: [] }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    return { fetcher, client: createSupportAiClient(getSupportAiConfig()!, fetcher as unknown as typeof fetch) }
  }
  const accessFor = async (g: LibraryGuide) => (await readSupportContext(await open(), [g])).access
  beforeEach(() => {
    // The typing indicator never leaves the test.
    global.fetch = jest.fn(async () => new Response('{"success":true}', { status: 200 })) as unknown as typeof fetch
  })
  // This file never resets the AI caps of its phone (10 first calls an hour): the two worker tests here would leave the tests
  // after them without one (as in «the public notice that replaces an offer…»), so the caps go back to zero when they are done.
  afterAll(() =>
    prisma.supportBudget.deleteMany({ where: { OR: [{ key: { contains: hash(phone) } }, { key: { contains: hash(staffId) } }] } }),
  )

  it('the fixtures: one guide of ~2,800 whole and one over the cap', () => {
    const whole = literalSupportAnswer([liga], null)
    expect(whole).toContain(wholeGuide(liga.body))
    expect(whole.length).toBeGreaterThan(2700)
    expect(whole.length).toBeLessThan(SUPPORT_LITERAL_CAP - 200)
    expect(literalSupportAnswer([huge], null)).not.toContain('detalle de la liga')
  })

  it('worker: a judge rejection saves the whole guide (JUDGE_LITERAL); delivery sends it with the venue line and records it', async () => {
    const id = await enqueue('¿Cómo creo una liga de pago?')
    await personal()
    const p = provider([understood(liga), draftOn(liga), { supported: false }])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: lib })).toBe('READY')
    expect(p.fetcher).toHaveBeenCalledTimes(3)
    const answer = literalSupportAnswer([liga], await accessFor(liga))
    expect(answer).toContain(wholeGuide(liga.body))
    expect(await saved(id)).toMatchObject({ outcome: 'JUDGE_LITERAL', answer, sourceIds: [sourceRef(liga)] })
    const sent = await deliver(lib)
    expect(sent).toEqual({ result: 'SENT', body: `${VENUE}\n\n${answer}` })
    expect(sent.body!.length).toBeLessThanOrEqual(SUPPORT_LITERAL_CAP)
    expect(await saved(id)).toMatchObject({ status: 'SENT', outcome: 'JUDGE_LITERAL', answer: sent.body, sourceIds: [sourceRef(liga)] })
  })

  it('worker: a guide over the cap still goes as its card', async () => {
    const id = await enqueue('¿Cómo creo una liga de pago?')
    const p = provider([understood(huge), draftOn(huge), { supported: false }])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: lib })).toBe('READY')
    const answer = (await saved(id)).answer!
    expect(answer).toBe(literalSupportAnswer([huge], null))
    expect(answer).not.toContain('detalle de la liga')
    expect(answer).toContain(huge.publicUrl)
  })

  it('RECUPERAR recovers the ~2,800 guide whole', async () => {
    await answered('Respuesta redactada.', [sourceRef(liga)], [liga], { status: 'SENT' })
    await closeConversation()
    const id = await enqueue('RECUPERAR')
    expect(await prepareSupportAnswer((await claim())!, { library: lib })).toBe('READY')
    const answer = literalSupportAnswer([liga], null)
    expect(answer).toContain(wholeGuide(liga.body))
    expect(await saved(id)).toMatchObject({ answer, sourceIds: [sourceRef(liga)] })
  })

  it('REINTENTAR resends a whole ~2,800 literal as it was, with its notice; the delivery sends exactly that', async () => {
    const literal = literalSupportAnswer([liga], null)
    expect(literal).toContain(wholeGuide(liga.body))
    const first = await uncertain(literal, [sourceRef(liga)], [liga])
    await prisma.supportMessage.update({ where: { id: first }, data: { outcome: 'JUDGE_LITERAL' } })
    const retry = await enqueue('REINTENTAR')
    expect(await prepareSupportAnswer((await claim())!, { library: lib })).toBe('READY')
    expect(await saved(retry)).toMatchObject({ retryOfId: first, answer: `${RETRY}\n\n${literal}`, outcome: 'JUDGE_LITERAL' })
    const sent = await deliver(lib)
    expect(sent).toEqual({ result: 'SENT', body: `${RETRY}\n\n${literal}` })
    expect(sent.body!.length).toBeLessThanOrEqual(SUPPORT_LITERAL_CAP)
  })

  it('the queue rebuild (the guide changed): the current guide whole, with the venue line; LITERAL and its current hash recorded', async () => {
    const id = await answered('Respuesta redactada.', [sourceRef(liga)], [liga], { personal: true })
    await prisma.supportMessage.update({ where: { id }, data: { outcome: 'ANSWERED' } })
    const current = edited(liga)
    const sent = await deliver([current, ...lib.slice(1)])
    const literal = literalSupportAnswer([current], await accessFor(current))
    expect(literal).toContain(wholeGuide(liga.body))
    expect(sent).toEqual({ result: 'SENT', body: `${VENUE}\n\n${literal}` })
    expect(await saved(id)).toMatchObject({ status: 'SENT', answer: sent.body, sourceIds: [sourceRef(current)], outcome: 'LITERAL' })
  })

  // 20 characters under the cap in a personal conversation (no gates, so no warning line there): the venue line does not fit.
  const base = guide('dashboard/ventas/liga-justa', 'Crear una liga justa', 'Crea una liga de pago justa.', { body: ligaBody(1) })
  const personalLength = (g: LibraryGuide) => literalSupportAnswer([g], null).length - supportWarnings(g, null).length - 1
  const near = { ...base, body: `${base.body} ${'x'.repeat(SUPPORT_LITERAL_CAP - 20 - personalLength(base) - 1)}` }
  it.each([
    ['as saved', false],
    ['rebuilt from the changed guide', true],
  ])(
    'a guide 20 under the cap (%s): the venue line goes only while it fits, the guide never shrinks to its card',
    async (_label, rebuild) => {
      const current = rebuild ? edited(near) : near
      const id = await answered(rebuild ? 'Respuesta redactada.' : '', [sourceRef(near)], [near], { personal: true })
      const literal = literalSupportAnswer([current], await accessFor(current))
      expect(literal.length).toBe(SUPPORT_LITERAL_CAP - 20)
      expect(literal).toContain(wholeGuide(near.body))
      if (!rebuild) await prisma.supportMessage.update({ where: { id }, data: { answer: literal } })
      const sent = await deliver([current, ...library])
      expect(sent).toEqual({ result: 'SENT', body: literal })
      expect(await saved(id)).toMatchObject({ status: 'SENT', answer: literal, sourceIds: [sourceRef(current)] })
    },
  )

  it('the queue rebuild of a guide over the cap: its card, with the venue line', async () => {
    await answered('Respuesta redactada.', [sourceRef(huge)], [huge], { personal: true })
    const current = edited(huge)
    const sent = await deliver([current, ...library])
    const card = literalSupportAnswer([current], await accessFor(current))
    expect(card).not.toContain('detalle de la liga')
    expect(sent).toEqual({ result: 'SENT', body: `${VENUE}\n\n${card}` })
  })

  it('hybrid off: a verified section with a ~2,800 whole guide goes whole, with the venue line', async () => {
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'false'
    const verified: VerifiedSection = { ...section, whole: wholeGuide(liga.body) }
    await answered('Respuesta de antes de la flag.', [verified.id], [], { personal: true })
    const sent = await deliver(null, [verified])
    const text = composeSupportAnswer([verified], (await readSupportContext(await open(), [verified])).access)
    expect(text).toContain(wholeGuide(liga.body))
    expect(sent).toEqual({ result: 'SENT', body: `${VENUE}\n\n${text}` })
    expect(sent.body!.length).toBeLessThanOrEqual(SUPPORT_LITERAL_CAP)
  })

  it('the last guard: a saved text of exactly 3,500 goes out', async () => {
    const id = await answered('x'.repeat(SUPPORT_LITERAL_CAP), [sourceRef(products)], [products])
    expect(await deliver()).toEqual({ result: 'SENT', body: 'x'.repeat(SUPPORT_LITERAL_CAP) })
    expect(await saved(id)).toMatchObject({ status: 'SENT' })
  })

  // T-F13: one over SUPPORT_LITERAL_CAP fails, whatever it says (a paragraph «Importante:» bought 2,000 in T-F8.3; it buys nothing now).
  it('over SUPPORT_LITERAL_CAP (3,500), with or without an «Importante:» paragraph, the last guard fails it and nothing is sent', async () => {
    const block = '\n\nImportante: Si no aparece, revisa que esté activo.'
    for (const answer of [`${'x'.repeat(SUPPORT_LITERAL_CAP + 1 - block.length)}${block}`, 'x'.repeat(SUPPORT_LITERAL_CAP + 1)]) {
      const id = await answered(answer, [sourceRef(products)], [products])
      expect(await deliver()).toEqual({ result: 'CANCELLED', body: undefined })
      expect(await saved(id)).toMatchObject({ status: 'FAILED' })
      await clean()
    }
  })

  // T-F12 sent, from an INFORMATIONAL guide too long to go whole, the «## » sections that held the quotes of a rejected draft (Codex
  // codex-tf12, finding 2: «Módulos principales» without «Planes»). T-F13 removed it: such a guide goes as its CARD on every literal
  // path, the worker's fallback, RECUPERAR and the queue rebuild, also when the saved text showed one of its sections whole.
  describe('T-F13: an informational guide too long to go whole goes as its card on every path, never one of its sections', () => {
    const filler = (word: string, n: number) => Array.from({ length: n }, (_, i) => `${word} número ${i + 1} del resumen.`).join(' ')
    const PLANES = 'Precios de referencia en pesos, sin IVA. Confirma siempre el precio vigente.'
    const info = guide('dashboard/configuracion/resumen-largo', 'Un resumen largo', 'Qué incluye cada plan.', {
      body: `## Qué es\nUn resumen de la plataforma, sin pasos.\n\n## Planes\n${PLANES}\n${filler('Plan', 20)}\n\n## Módulos\n${filler('Módulo', 110)}`,
    })
    const planes = wholeGuide(info.body.slice(info.body.indexOf('## Planes'), info.body.indexOf('\n\n## Módulos')))
    // What T-F12 saved for it: the title, its access warning, its «Planes» section and its link.
    const sectionText = [info.title, supportWarnings(info, null), planes, info.publicUrl].join('\n')
    const quoting: SupportDraft = {
      covered: true,
      intro: null,
      steps: [{ text: 'Confirma el precio vigente.', guideId: info.id, quote: 'Confirma siempre el precio vigente' }],
    }
    const libT = [info, ...library]
    const cardOf = async (g: LibraryGuide) => literalSupportAnswer([g], await accessFor(g))

    it('the fixture: informational, too long whole, and its literal is its card', () => {
      expect(info.body).not.toMatch(/^\s*\d+\./m)
      expect(literalSupportAnswer([info], null)).not.toContain(wholeGuide(info.body))
      expect(literalSupportAnswer([info], null)).toContain(SUPPORT_GUIDE_TOO_LONG)
      expect(literalSupportAnswer([info], null)).not.toContain(PLANES)
      expect(sectionText.length).toBeLessThan(SUPPORT_LITERAL_CAP)
    })

    it('worker: a judge rejection of a draft quoting «Planes» saves the card (JUDGE_LITERAL); delivery sends it with the venue line', async () => {
      const id = await enqueue('¿Cuánto cuesta el plan?')
      await personal()
      const p = provider([understood(info), quoting, { supported: false }])
      expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: libT })).toBe('READY')
      expect(p.fetcher).toHaveBeenCalledTimes(3)
      const card = await cardOf(info)
      expect(await saved(id)).toMatchObject({ outcome: 'JUDGE_LITERAL', answer: card, sourceIds: [sourceRef(info)] })
      expect(card).not.toContain(PLANES)
      const sent = await deliver(libT)
      expect(sent).toEqual({ result: 'SENT', body: `${VENUE}\n\n${card}` })
    })

    it('RECUPERAR of a saved text that showed «Planes» recovers the card', async () => {
      await answered(sectionText, [sourceRef(info)], [info], { status: 'SENT' })
      await closeConversation()
      const id = await enqueue('RECUPERAR')
      expect(await prepareSupportAnswer((await claim())!, { library: libT })).toBe('READY')
      const answer = (await saved(id)).answer!
      expect(answer).toBe(literalSupportAnswer([info], null))
      expect(answer).not.toContain(PLANES)
    })

    it('the queue rebuild (the guide changed) of a saved text that showed «Planes»: the card, with the venue line and its current hash', async () => {
      const id = await answered(sectionText, [sourceRef(info)], [info], { personal: true })
      await prisma.supportMessage.update({ where: { id }, data: { outcome: 'JUDGE_LITERAL' } })
      const current = edited(info)
      const sent = await deliver([current, ...library])
      const card = await cardOf(current)
      expect(card).not.toContain(PLANES)
      expect(sent).toEqual({ result: 'SENT', body: `${VENUE}\n\n${card}` })
      expect(await saved(id)).toMatchObject({
        status: 'SENT',
        answer: sent.body,
        sourceIds: [sourceRef(current)],
        outcome: 'JUDGE_LITERAL',
      })
    })
  })
})

describe('the card of an internal guide offers a person with the word phase 1 already answers (T-F6c)', () => {
  it('the word the card shows is the one the router answers with the handoff summary of this chat', async () => {
    const manual = guide('android/caja/larga', 'Cerrar la caja', 'Cierra la caja.', {
      app: 'android',
      internal: true,
      publicUrl: '',
      // T-F10c: long enough to go as its card under SUPPORT_LITERAL_CAP (3,500), not only under 1,500.
      body: `## Pasos\n${Array.from({ length: 25 }, (_, i) => `${i + 1}. ${'paso largo '.repeat(14)}`).join('\n')}`,
    })
    const card = literalSupportAnswer([manual], null)
    const word = /escribe ([A-ZÁÉÍÓÚÑ]+)\./.exec(card)?.[1]
    expect(word).toBe('PERSONA')
    expect(card).not.toContain('hola@avoqado.io')
    await answered(card, [sourceRef(manual)], [manual], { status: 'SENT', app: 'android' })
    jest.spyOn(knowledge, 'loadSupportLibrary').mockReturnValue([...library, manual])
    const event = input(word!)
    expect(await tryRouteSupport(event)).toBe('QUEUED')
    const reply = (await prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: event.wamid } } })).answer!
    expect(reply).toContain('Guía intentada: Cerrar la caja\n')
  })
})

describe('a saved handoff offer or old-version notice goes out as saved (R2-02, R3-05, T2-c2)', () => {
  const billing = guide('dashboard/facturacion/emitir-factura', 'Emitir factura', 'Emite una factura CFDI a tu cliente.', {
    featureCode: 'CFDI',
    gateKind: 'FEATURE',
    body: 'Para emitir una factura abre la venta en el panel y toca facturar. Revisa los datos fiscales del cliente y confirma.',
  })
  const billingLibrary = [billing, ...library]
  const understood = { kind: 'question', standalone: '¿Cómo emito una factura?', guideIds: [billing.id] }
  const draft: SupportDraft = {
    covered: true,
    intro: null,
    steps: [
      { text: 'Abre la venta y toca facturar.', guideId: billing.id, quote: 'abre la venta en el panel y toca facturar' },
      { text: 'Revisa los datos fiscales y confirma.', guideId: billing.id, quote: 'Revisa los datos fiscales del cliente y confirma' },
    ],
  }
  const rejected = { supported: false }
  const DONE = supportHandoffDone('+52 56 4007 0001')
  const OFFER = secondFailureText(billing)
  /** Fake provider: one reply per model call, in order; a missing reply means no call was expected. */
  function provider(replies: object[]) {
    let n = 0
    const fetcher = jest.fn(async (_url: unknown, _init?: unknown) => {
      const reply = replies[n++]
      if (!reply) throw new TypeError('fixture: no reply configured for this call')
      return new Response(
        JSON.stringify({
          id: `resp_${n}`,
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(reply), annotations: [] }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    return { fetcher, client: createSupportAiClient(getSupportAiConfig()!, fetcher as unknown as typeof fetch) }
  }
  async function prepared(replies: object[], body = '¿Cómo emito una factura?', lib = billingLibrary) {
    const id = await enqueue(body)
    const p = provider(replies)
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: lib })).toBe('READY')
    return { id, p, message: await saved(id) }
  }
  /** A personal conversation, two judge rejections in a row: the second one saves the offer. */
  async function offer() {
    const first = await enqueue('¿Cómo emito una factura?')
    await personal()
    const p = provider([understood, draft, rejected])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: billingLibrary })).toBe('READY')
    expect(await saved(first)).toMatchObject({ outcome: 'JUDGE_LITERAL', handoffOffered: false })
    expect((await deliver(billingLibrary)).result).toBe('SENT')
    const second = await prepared([understood, draft, rejected])
    expect(second.message).toMatchObject({ answer: OFFER, outcome: 'JUDGE_LITERAL', handoffOffered: true, sourceIds: [sourceRef(billing)] })
    return second
  }
  const notices = async () => prisma.supportNotice.findMany({ where: { conversationId: (await open()).id }, take: 5 })
  beforeEach(() => {
    process.env.SUPPORT_HANDOFF_EMAIL_TO = 'soporte@test.local'
    // The typing indicator never leaves the test.
    global.fetch = jest.fn(async () => new Response('{"success":true}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => {
    delete process.env.SUPPORT_HANDOFF_EMAIL_TO
  })

  it('personal conversation, two judge rejections on a guide with featureCode, no access change: prepare → deliver sends the offer exactly as saved → «sí» hands off', async () => {
    await offer()
    expect(await deliver(billingLibrary)).toEqual({ result: 'SENT', body: `${VENUE}\n\n${OFFER}` })
    const yes = await prepared([], 'sí')
    expect(yes.p.fetcher).not.toHaveBeenCalled()
    expect(yes.message).toMatchObject({ answer: DONE, outcome: 'HANDOFF' })
    expect(await notices()).toEqual([expect.objectContaining({ reason: 'TWO_FAILURES', status: 'PENDING', staffId, venueId: northId })])
  })

  it("the same with the guide's hash changed before delivery: the saved offer still goes out", async () => {
    await offer()
    expect(await deliver([edited(billing), ...library])).toEqual({ result: 'SENT', body: `${VENUE}\n\n${OFFER}` })
  })

  it("access changed before delivery: today's public notice", async () => {
    const second = await offer()
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId, venueId: northId } }, data: { role: 'MANAGER' } })
    expect(await deliver(billingLibrary)).toEqual(notice)
    expect((await saved(second.id)).answer).toMatch(/^Tu acceso cambió/)
  })

  it('the public notice that replaces an offer carries no offer (handoffOffered false, outcome FIXED): a «sí» to it hands nobody off', async () => {
    // This file never resets the AI caps of its phone (10 first calls an hour): start from zero, so that the three calls of
    // this test never leave the tests after it without one.
    await prisma.supportBudget.deleteMany({ where: { OR: [{ key: { contains: hash(phone) } }, { key: { contains: hash(staffId) } }] } })
    const second = await offer()
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId, venueId: northId } }, data: { role: 'MANAGER' } })
    expect(await deliver(billingLibrary)).toEqual(notice)
    expect(await saved(second.id)).toMatchObject({
      answer: expect.stringMatching(/^Tu acceso cambió/),
      handoffOffered: false,
      outcome: 'FIXED',
    })
    expect((await deliver(billingLibrary)).result).toBe('SENT')
    const yes = await prepared([{ kind: 'unknown', standalone: '', guideIds: [] }], 'sí')
    expect(yes.message.outcome).not.toBe('HANDOFF')
    expect(yes.message.answer).not.toBe(DONE)
    expect(await notices()).toEqual([])
  })

  it('offer → uncertain send (SEND_UNKNOWN) → REINTENTAR → delivery → «sí»: the resend keeps handoffOffered and outcome, one notice, zero new model calls', async () => {
    const second = await offer()
    await prisma.supportMessage.update({ where: { id: second.id }, data: { status: 'SEND_UNKNOWN' } })
    await prisma.supportAttempt.create({
      data: {
        messageId: second.id,
        kind: 'SEND',
        ordinal: 1,
        claimToken: 'fixture',
        state: 'UNKNOWN',
        pricingVersion: 'whatsapp-service-v1',
      },
    })
    const retry = await prepared([], 'REINTENTAR')
    expect(retry.message).toMatchObject({
      retryOfId: second.id,
      answer: `${RETRY}\n\n${OFFER}`,
      handoffOffered: true,
      outcome: 'JUDGE_LITERAL',
      sourceIds: [sourceRef(billing)],
    })
    expect(await deliver(billingLibrary)).toEqual({ result: 'SENT', body: `${VENUE}\n\n${RETRY}\n\n${OFFER}` })
    const yes = await prepared([], 'sí')
    expect([retry.p.fetcher, yes.p.fetcher].map(f => f.mock.calls.length)).toEqual([0, 0])
    expect(yes.message).toMatchObject({ answer: DONE, outcome: 'HANDOFF' })
    expect(await notices()).toEqual([expect.objectContaining({ reason: 'TWO_FAILURES' })])
    // The resend repeats an answer: only the two failures and the handoff are counted.
    const counted = await prisma.supportEvent.findMany({ where: { conversationId: (await open()).id }, take: 10 })
    expect(counted.map(e => e.kind).sort()).toEqual(['HANDOFF', 'JUDGE_LITERAL', 'JUDGE_LITERAL'])
  })

  const tip: LibraryGuide = {
    ...guide('tpv/propina/agregar-propina', 'Agregar propina', 'Toca Propina antes de cobrar y elige el porcentaje.'),
    app: 'tpv',
    versionMin: '2.19.0',
    task: 'agregar-propina',
  }
  /** An OLD_VERSION reply without the offer (the handoff email unset), for a 2.18.0 PAX terminal. */
  async function oldVersion() {
    delete process.env.SUPPORT_HANDOFF_EMAIL_TO
    const id = await enqueue('¿Cómo agrego propina?', 'tpv')
    await prisma.supportConversation.updateMany({
      where: { receiverId, phone, mode: { not: 'CLOSED' } },
      data: { appVersion: '2.18.0', deviceFamily: 'PAX' },
    })
    const p = provider([{ kind: 'question', standalone: '¿Cómo agrego propina?', guideIds: [tip.id] }])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: [...library, tip] })).toBe('READY')
    const text = literalSupportAnswer([tip], null, supportOldVersion('2.19.0'))
    expect(await saved(id)).toMatchObject({ answer: text, outcome: 'OLD_VERSION', handoffOffered: false })
    return text
  }

  it("an OLD_VERSION reply without the offer whose guide's hash changed before delivery goes out exactly as saved", async () => {
    const text = await oldVersion()
    expect(await deliver([...library, edited(tip)])).toEqual({ result: 'SENT', body: text })
  })

  it('an OLD_VERSION reply prepared with the flag on and delivered with the flag off keeps its text (T2-c2)', async () => {
    const text = await oldVersion()
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'false'
    expect(await deliver([...library, tip])).toEqual({ result: 'SENT', body: text })
  })
})

// T-F6: la lista completa de la pasada exhaustiva de Codex (codex-tf-exhaustiva.md), H4 y H6, con almacenamiento real.
describe('T-F6: every delivery checks its guides against today and records what it shows (Codex H4, H6)', () => {
  type Options = Parameters<typeof answered>[3] & { offered?: boolean }
  /** An answer as the worker leaves it: its outcome and the SupportEvent counted when it was prepared. */
  async function marked(answer: string, sourceIds: string[], drafted: LibraryGuide[], outcome: SupportOutcome, options: Options = {}) {
    const id = await answered(answer, sourceIds, drafted, options)
    const m = await prisma.supportMessage.update({ where: { id }, data: { outcome, handoffOffered: !!options.offered } })
    await prisma.supportEvent.create({
      data: {
        kind: outcome,
        app: options.app ?? 'dashboard',
        guideIds: guideIdsOf(sourceIds),
        conversationId: m.conversationId,
        generation: m.generation,
        sequence: m.sequence,
        day: '2026-11-17',
      },
    })
    return id
  }
  /** The events of a message, oldest first: the one counted when it was prepared stays as it was. */
  const events = async (id: string) => {
    const m = await saved(id)
    return (
      await prisma.supportEvent.findMany({
        where: { conversationId: m.conversationId, sequence: m.sequence },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 10,
      })
    ).map(e => ({ kind: e.kind, guideIds: e.guideIds }))
  }
  const tip: LibraryGuide = {
    ...guide('tpv/propina/agregar-propina', 'Agregar propina', 'Toca Propina antes de cobrar y elige el porcentaje.'),
    app: 'tpv',
    versionMin: '2.19.0',
    task: 'agregar-propina',
  }

  // H4, Codex repro 1: an OLD_VERSION reply was sent as saved (savedAsIs), even with its guide gone from the library.
  it('H4: an OLD_VERSION reply whose guide was retired is never sent: SUPPORT_NO_COVERAGE, outcome UNKNOWN, a correcting event', async () => {
    const text = literalSupportAnswer([tip], null, supportOldVersion('2.19.0'))
    const id = await marked(text, [sourceRef(tip)], [tip], 'OLD_VERSION', {
      app: 'tpv',
      conversation: { appVersion: '2.18.0', deviceFamily: 'PAX' },
    })
    expect(await deliver(library)).toEqual(notice)
    expect(await saved(id)).toMatchObject({
      status: 'ANSWER_READY',
      answer: SUPPORT_NO_COVERAGE,
      sourceIds: [],
      outcome: 'UNKNOWN',
      handoffOffered: false,
    })
    expect(await events(id)).toEqual([
      { kind: 'OLD_VERSION', guideIds: [tip.id] },
      { kind: 'UNKNOWN', guideIds: [tip.id] },
    ])
    expect(await deliver(library)).toEqual({ result: 'SENT', body: SUPPORT_NO_COVERAGE })
  })
  it('H4: an OLD_VERSION reply whose guide is still there and still newer than the version goes out as saved', async () => {
    const text = literalSupportAnswer([tip], null, supportOldVersion('2.19.0'))
    const id = await marked(text, [sourceRef(tip)], [tip], 'OLD_VERSION', {
      app: 'tpv',
      conversation: { appVersion: '2.18.0', deviceFamily: 'PAX' },
    })
    expect(await deliver([...library, tip])).toEqual({ result: 'SENT', body: text })
    expect(await saved(id)).toMatchObject({ outcome: 'OLD_VERSION', sourceIds: [sourceRef(tip)] })
    expect(await events(id)).toEqual([{ kind: 'OLD_VERSION', guideIds: [tip.id] }])
  })

  // H4, Codex repro 2: the terminal was deduced from the venue's devices (PAX) when preparing; they are Nexgo by delivery. The
  // fingerprint does not see the deduced context; the check at delivery reads it again.
  const pax: LibraryGuide = {
    ...guide('tpv/cobro/cobrar-con-pax', 'Cobrar con la PAX', 'Toca Cobrar y acerca la tarjeta a la PAX.'),
    app: 'tpv',
    deviceFamily: 'PAX',
  }
  it.each([
    ['PAX', { result: 'SENT', body: `${VENUE}\n\nRespuesta redactada para la PAX.` }, 'ANSWERED'],
    ['NEXGO', notice, 'UNKNOWN'],
  ] as const)(
    'H4: a same-hash answer for a PAX deduced from the devices, when the devices now say %s',
    async (brand, expected, outcome) => {
      const terminal = await prisma.terminal.create({
        data: {
          venueId: northId,
          name: `${receiverId} PAX`,
          type: 'TPV_ANDROID',
          brand: 'PAX',
          version: '2.20.0',
          lastHeartbeat: new Date(),
        },
      })
      try {
        const id = await marked('Respuesta redactada para la PAX.', [sourceRef(pax)], [pax], 'ANSWERED', { app: 'tpv', personal: true })
        expect(await open()).toMatchObject({ deviceFamily: null, appVersion: null })
        await prisma.terminal.update({ where: { id: terminal.id }, data: { brand } })
        expect(await deliver([...library, pax])).toEqual(expected)
        expect(await saved(id)).toMatchObject(
          brand === 'PAX' ? { status: 'SENT', outcome } : { answer: SUPPORT_NO_COVERAGE, sourceIds: [], outcome },
        )
        expect((await events(id)).map(e => e.kind)).toEqual(brand === 'PAX' ? ['ANSWERED'] : ['ANSWERED', 'UNKNOWN'])
      } finally {
        await prisma.terminal.delete({ where: { id: terminal.id } })
      }
    },
  )

  // H4 on a handoff offer: «Lo más cercano» names a guide; if it no longer fits, the offer goes without it, never with it.
  it('H4: a second-failure offer whose nearest guide is gone keeps the offer without that guide', async () => {
    const id = await marked(secondFailureText(inventory), [sourceRef(inventory)], [inventory], 'JUDGE_LITERAL', { offered: true })
    expect(await deliver([products])).toEqual({ result: 'SENT', body: secondFailureText(null) })
    expect(await saved(id)).toMatchObject({ sourceIds: [], handoffOffered: true, outcome: 'JUDGE_LITERAL' })
    expect(await events(id)).toEqual([{ kind: 'JUDGE_LITERAL', guideIds: [inventory.id] }])
  })

  // H6, Codex case 1: the rebuilt literal showed the current guide but kept the old id@hash and the ANSWERED of the draft.
  it.each(['true', 'false'])(
    'H6 (hybrid flag %s): a rebuilt literal saves the current hash of what it shows, outcome LITERAL, and a correcting event',
    async flag => {
      const id = await marked('Respuesta redactada con la guía anterior.', [sourceRef(products)], [products], 'ANSWERED')
      process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = flag
      const current = edited(products)
      expect(await deliver([current, inventory])).toEqual({ result: 'SENT', body: literalSupportAnswer([current], null) })
      expect(await saved(id)).toMatchObject({ status: 'SENT', sourceIds: [sourceRef(current)], outcome: 'LITERAL' })
      expect(sourceRef(current)).not.toBe(sourceRef(products))
      expect(await events(id)).toEqual([
        { kind: 'ANSWERED', guideIds: [products.id] },
        { kind: 'LITERAL', guideIds: [products.id] },
      ])
    },
  )

  // H6, Codex case 2: a clarification of three options that lost one sent two and kept the three references.
  const reports = guide('dashboard/reportes/ver-ventas', 'Ver ventas', 'Consulta las ventas del día.')
  it('H6: a rebuilt clarification keeps only its current options', async () => {
    const refs = ['#clarify', sourceRef(products), sourceRef(inventory), sourceRef(reports)]
    const id = await marked(clarifyText([products, inventory, reports]), refs, [products, inventory, reports], 'CLARIFIED')
    expect(await deliver(library)).toEqual({ result: 'SENT', body: clarifyText([products, inventory]) })
    expect(await saved(id)).toMatchObject({ sourceIds: ['#clarify', sourceRef(products), sourceRef(inventory)], outcome: 'CLARIFIED' })
    expect(await events(id)).toEqual([{ kind: 'CLARIFIED', guideIds: [products.id, inventory.id, reports.id] }])
  })
  it('H6: a clarification left with one option is «no sé»: no sources, outcome UNKNOWN, and the weekly list counts it once', async () => {
    const from = new Date(Date.now() - 1000)
    const id = await marked(clarifyText([products, inventory]), clarifyIds, [products, inventory], 'CLARIFIED')
    expect(await deliver([products])).toEqual({ result: 'SENT', body: SUPPORT_HYBRID_UNKNOWN })
    expect(await saved(id)).toMatchObject({ sourceIds: [], outcome: 'UNKNOWN' })
    expect((await events(id)).map(e => e.kind)).toEqual(['CLARIFIED', 'UNKNOWN'])
    const report = await buildWeeklyReport(from, new Date(Date.now() + 1000))
    expect(report.failures).toEqual([{ app: 'dashboard', kind: 'UNKNOWN', count: 1 }])
  })

  // H6, Codex case 3: an ANSWERED that lost its guide went as SUPPORT_NO_COVERAGE and still said ANSWERED.
  it('H6: an ANSWERED that loses its guide is SUPPORT_NO_COVERAGE with outcome UNKNOWN; the old event stays, a new one corrects it', async () => {
    const id = await marked('Respuesta redactada.', [sourceRef(products)], [products], 'ANSWERED')
    const before = await prisma.supportEvent.findFirstOrThrow({ where: { conversationId: (await saved(id)).conversationId } })
    expect(await deliver([inventory])).toEqual(notice)
    expect(await saved(id)).toMatchObject({ answer: SUPPORT_NO_COVERAGE, sourceIds: [], outcome: 'UNKNOWN' })
    expect(await prisma.supportEvent.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before)
    expect(await events(id)).toEqual([
      { kind: 'ANSWERED', guideIds: [products.id] },
      { kind: 'UNKNOWN', guideIds: [products.id] },
    ])
  })
  it('H6: an answer that now needs the version is ASKED, with a correcting event and no sources', async () => {
    const onAndroid = {
      ...products,
      id: 'android/menu/gestionar-productos',
      app: 'android' as const,
      publicUrl: 'https://avoqado.io/help/android/menu/gestionar-productos',
    }
    const id = await marked('Respuesta redactada.', [sourceRef(onAndroid)], [onAndroid], 'ANSWERED', { app: 'android' })
    expect(await deliver([edited(onAndroid, { versionMin: '2.25.7' }), inventory])).toEqual(notice)
    expect(await saved(id)).toMatchObject({ answer: SUPPORT_ASK_VERSION, sourceIds: [], outcome: 'ASKED' })
    expect(await events(id)).toEqual([
      { kind: 'ANSWERED', guideIds: [onAndroid.id] },
      { kind: 'ASKED', guideIds: [] },
    ])
  })

  // H6 on REINTENTAR: a resend over 1,500 is the literal guide, so it is no longer the drafted answer.
  it('H6: REINTENTAR of a drafted answer that no longer fits with the notice is the literal: outcome LITERAL, no new event', async () => {
    const first = await uncertain('x'.repeat(1450), [sourceRef(products)], [products])
    await prisma.supportMessage.update({ where: { id: first }, data: { outcome: 'ANSWERED' } })
    const retry = await enqueue('REINTENTAR')
    expect(await prepareSupportAnswer((await claim())!, { library })).toBe('READY')
    expect(await saved(retry)).toMatchObject({
      answer: literalSupportAnswer([products], null, RETRY),
      sourceIds: [sourceRef(products)],
      outcome: 'LITERAL',
    })
    expect(await events(retry)).toEqual([])
  })
})

// T-F14 (H-T15-1): an answer saved with the other-question line keeps it when it goes out as saved, when the delivery rebuilds the
// literal guide (the guide changed) and when REINTENTAR resends the literal guide.
describe('T-F14: the other-question line on the way out', () => {
  const also = (text: string) => `${text}\n\n${SUPPORT_OTHER_QUESTION}`
  it('as saved: the venue line in front, the other-question line at the end', async () => {
    const answer = also('Respuesta redactada y revisada.')
    await answered(answer, [sourceRef(products)], [products], { personal: true })
    expect(await deliver()).toEqual({ result: 'SENT', body: `${VENUE}\n\n${answer}` })
  })
  it('a guide edited after drafting: the literal current guide, with the line', async () => {
    await answered(also('Respuesta redactada con la guía anterior.'), [sourceRef(products)], [products])
    const current = edited(products)
    expect(await deliver([current, inventory])).toEqual({ result: 'SENT', body: also(literalSupportAnswer([current], null)) })
  })
  it('REINTENTAR that no longer fits with its notice resends the literal guide, with the line', async () => {
    const first = await uncertain(also('x'.repeat(1400)), [sourceRef(products)], [products])
    const retry = await enqueue('REINTENTAR')
    expect(await prepareSupportAnswer((await claim())!, { library })).toBe('READY')
    expect(await saved(retry)).toMatchObject({ retryOfId: first, answer: also(literalSupportAnswer([products], null, RETRY)) })
  })
})
