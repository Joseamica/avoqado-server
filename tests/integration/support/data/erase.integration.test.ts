import crypto from 'crypto'
import type { SupportMessageStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { LUNA_SUPPORT_PRICING as pricing, getSupportAiConfig } from '@/config/supportWhatsapp'
import { admitSupportMessage, claimNext } from '@/services/support/store.service'
import { prepareSupportAnswer } from '@/services/support/worker.service'
import { createSupportAiClient } from '@/services/support/answer.service'
import { openDataEnvelope } from '@/services/support/data/answer.service'
import { dataCatalog } from '@/services/support/data/catalog'
import { deliverSupportMessage, recordSupportDeliveryFailure } from '@/services/support/delivery.service'
import { unlink } from '@/services/support/link.service'
import type { LibraryGuide } from '@/services/support/knowledge.service'
import { tryRouteSupport } from '@/services/support/router.service'
import { fakeCapability, seedDataFixture, type DataFixture } from '@tests/__helpers__/supportData'

/**
 * Task 11 de la B, caso 26: lo que borra una respuesta de datos ya entregada. Su cifrado se queda al mandarla (Task 10) y lo borran los
 * escritores de siempre: el cambio de plática (SUCURSAL, APP, AYUDA, PUBLICA, SALIR) y desvincular. El renglón del registro («se
 * consultó») no lo toca nadie. Vale en los tres estados en que una fila DATA conserva su cifrado tras la entrega: SENT, FAILED (el aviso
 * de falla de Meta después de mandarla) y SEND_UNKNOWN (claimNext tras un intento STARTED cuyo arriendo venció). Nada sale a un
 * proveedor ni a WhatsApp: «Entender» y Meta son `fetch` de mentira.
 */
const dataCapabilities = dataCatalog(fakeCapability)
const products: LibraryGuide = {
  id: 'dashboard/menu/gestionar-productos',
  app: 'dashboard',
  title: 'Crear productos',
  summary: 'Da de alta productos y sus precios.',
  steps: ['Da de alta productos y sus precios.'],
  publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
  requiredPermissions: [],
  keywords: [],
  body: 'Para crear un producto abre el menú del panel y toca nuevo producto. Escribe el nombre y el precio, y guarda los cambios.',
  general: false,
  internal: false,
  hash: '',
}
products.hash = crypto.createHash('sha256').update(`${products.id}\n${products.body}`).digest('hex')
const library = [products]
const asData = {
  kind: 'data',
  standalone: '',
  guideIds: [],
  data: { capability: 'fake', day: 'today', amount: '850', time: '', otherVenue: false },
}
/** «Entender» de mentira: contesta `kind: 'data'`. */
function understanding() {
  const fetcher = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: 'resp_1',
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(asData), annotations: [] }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  )
  return createSupportAiClient(getSupportAiConfig()!, fetcher as unknown as typeof fetch)
}

const ENV: Record<string, string> = {
  SUPPORT_AI_ENABLED: 'true',
  SUPPORT_AI_MODEL: pricing.model,
  SUPPORT_AI_PRICING_VERSION: pricing.version,
  SUPPORT_AI_MONTHLY_USD_LIMIT: '10',
  SUPPORT_OPENAI_API_KEY: 'fixture-never-used',
  WHATSAPP_ACCESS_TOKEN: 'fixture-never-used',
}
const originalFetch = global.fetch
let f: DataFixture, receiverId: string, phone: string
let serial = 0
beforeAll(async () => {
  f = await seedDataFixture('support-data-erase')
  ;({ receiverId, phone } = await f.conversation())
  Object.assign(process.env, ENV)
})
beforeEach(async () => {
  await f.reset()
  await prisma.supportBudget.deleteMany({
    where: { OR: [{ key: { startsWith: 'AI:' } }, { key: { startsWith: `CONTROL:${receiverId}:` } }] },
  })
  // Meta: every send is accepted with a new wamid.
  global.fetch = jest.fn(
    async () => new Response(JSON.stringify({ messages: [{ id: `wamid.${receiverId}-out-${++serial}` }] }), { status: 200 }),
  ) as unknown as typeof fetch
})
afterEach(() => {
  global.fetch = originalFetch
  jest.restoreAllMocks()
})
afterAll(async () => {
  if (!f) return
  await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${receiverId}:` } } })
  await f.clean()
  for (const key of Object.keys(ENV)) delete process.env[key]
})

const input = (body: string) => ({
  receiverId,
  phone,
  wamid: `wamid.${receiverId}-${++serial}`,
  type: 'text',
  body,
  timestamp: String(Math.floor(Date.now() / 1000)),
})
const claim = () => claimNext(new Date(Date.now() + 10), receiverId)
const saved = (id: string) => prisma.supportMessage.findUniqueOrThrow({ where: { id }, include: { attempts: true } })
const logRows = () =>
  prisma.supportDataQuery.findMany({ where: { staffId: f.staffId }, select: { capability: true, result: true }, take: 10 })

/** A sealed DATA answer prepared by the worker (with its one log row), then taken to `status` by delivery's own paths. */
async function delivered(status: Extract<SupportMessageStatus, 'SENT' | 'FAILED' | 'SEND_UNKNOWN'>): Promise<string> {
  await f.unlock()
  await f.conversation()
  const { messageId: id } = await admitSupportMessage(input('¿entró un cobro de 850?'))
  await prisma.supportConversation.updateMany({
    where: { receiverId, phone, mode: { not: 'CLOSED' } },
    data: { lastUserMessageAt: new Date(), lastActivityAt: new Date() },
  })
  expect(await prepareSupportAnswer((await claim())!, { client: understanding(), library, dataCapabilities })).toBe('READY')
  expect(await saved(id)).toMatchObject({ purpose: 'DATA', status: 'ANSWER_READY', dataCapability: 'fake' })
  if (status === 'SEND_UNKNOWN') {
    // The process died after the SEND attempt was persisted as STARTED: the lease runs out and claimNext takes the row back.
    const taken = (await claim())!
    await prisma.supportAttempt.create({
      data: {
        messageId: id,
        kind: 'SEND',
        ordinal: 1,
        claimToken: taken.claimToken,
        state: 'STARTED',
        pricingVersion: 'whatsapp-service-v1',
        startedAt: new Date(),
      },
    })
    await prisma.supportMessage.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } })
    // SEND_UNKNOWN, and never claimed again: no second send of the figure.
    expect(await claim()).toBeNull()
  } else {
    const next = (await claim())!
    expect(await deliverSupportMessage(next, [], library, dataCapabilities)).toBe('SENT')
    if (status === 'FAILED') {
      const { outboundWamid } = await saved(id)
      expect(await recordSupportDeliveryFailure(outboundWamid!, receiverId)).toBe(true)
    }
  }
  const row = await saved(id)
  // Delivery is over and the cipher is still there: what the command below has to erase.
  expect(row).toMatchObject({ purpose: 'DATA', status, answer: null })
  expect(openDataEnvelope(row.answerCipher)?.text).toContain('$12,345.60')
  expect(await logRows()).toEqual([{ capability: 'fake', result: 'ANSWERED' }])
  return id
}

const COMMANDS = ['SUCURSAL', 'APP', 'AYUDA', 'PUBLICA', 'SALIR', 'unlink']
describe.each(['SENT', 'FAILED', 'SEND_UNKNOWN'] as const)('a DATA answer left %s', status => {
  it.each(COMMANDS)('%s after a delivered DATA answer leaves its cipher empty and its log row in place (case 26)', async command => {
    const id = await delivered(status)
    if (command === 'unlink') await unlink(f.staffId, { strongAuthAt: new Date(), venueId: f.northId })
    else await tryRouteSupport(input(command))
    const row = await saved(id)
    expect(row).toMatchObject({ purpose: 'DATA', answerCipher: null, answer: null, body: '' })
    // A row still pending a send is cancelled; a finished one keeps its status.
    expect(row.status).toBe(status === 'SEND_UNKNOWN' ? 'CANCELLED' : status)
    expect(await logRows()).toEqual([{ capability: 'fake', result: 'ANSWERED' }])
  })
})

// The person gets data, goes quiet past the idle window (30 minutes) and then writes a command: the router first closes the idle
// conversation (closeIdleSupport) and the command acts on a NEW one, so the old conversation's DATA cipher has to go right there.
describe.each(['SENT', 'FAILED', 'SEND_UNKNOWN'] as const)('a DATA answer left %s in a conversation that went idle', status => {
  it.each(COMMANDS.filter(command => command !== 'unlink'))(
    '%s after 30 idle minutes closes the conversation, leaves the cipher empty and the log row in place (case 26)',
    async command => {
      const id = await delivered(status)
      const { conversationId } = await saved(id)
      await prisma.supportConversation.update({
        where: { id: conversationId },
        data: { lastActivityAt: new Date(Date.now() - 31 * 60_000) },
      })
      await tryRouteSupport(input(command))
      expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({ mode: 'CLOSED' })
      // Only the cipher goes; the rows keep their status. SALIR with no open conversation also resets the last closed one
      // (decideSupportAdmission), which cancels a row still SEND_UNKNOWN.
      const row = await saved(id)
      expect(row).toMatchObject({ purpose: 'DATA', answer: null, answerCipher: null })
      expect(row.status).toBe(status === 'SEND_UNKNOWN' && command === 'SALIR' ? 'CANCELLED' : status)
      expect(await logRows()).toEqual([{ capability: 'fake', result: 'ANSWERED' }])
    },
  )
})
