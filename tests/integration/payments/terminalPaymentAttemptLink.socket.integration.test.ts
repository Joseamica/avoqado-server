/**
 * S1 del checkpoint 1 (webhook como primer confirmador): el vínculo intento → solicitud LLEGA POR SOCKET desde
 * la terminal (`terminal:payment_attempt_opened`, que el checkpoint 2 emitirá tras `openAttempt`) y se decide en
 * `terminalPaymentService.handleAttemptOpenedFromSocket`. Lo que Codex exigió, medido en la base:
 *
 *  · dueño INMUTABLE por intento: la solicitud, el venue y la terminal AUTENTICADA del socket; nunca se reasigna;
 *  · se distinguen tres cosas: repetición del mismo vínculo (idempotente, aunque la solicitud haya terminado),
 *    apertura de un intento NUEVO, y recuperación TARDÍA de evidencia (se guarda, pero no autoriza ejecutar el SDK);
 *  · sólo se acepta si la fila es de la terminal del JWT del socket; un `attemptId` reusado en OTRA solicitud
 *    suena 🚨 y NO se guarda; sin `ActivityLog`;
 *  · el ack sale DESPUÉS de escribir: cuando el ack se resuelve, la fila ya es legible.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { exigir } from './webhookCheckpoint.fixture'
import logger from '@/config/logger'
import { terminalPaymentService, type AttemptLinkAck } from '@/services/terminal-payment.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { terminalIdentityKey } from '@/utils/terminalSerial'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const fixture = `s1-${randomUUID()}`
const venueId = fixture
// La app manda el serial como lo lee del hardware (con prefijo, mayúsculas); la fila guarda la llave normalizada.
const serial = `AVQD-N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
const llave = terminalIdentityKey(serial)
let ranura = 0

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/)
  await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: fixture, name: fixture, slug: fixture } })
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})

afterEach(async () => {
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } }) // se lleva los vínculos (cascade)
})

afterAll(async () => {
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
})

/**
 * Una solicitud de ESTA terminal. Por defecto en vuelo (SENT). La base impone UNA solicitud en vuelo por terminal
 * (`TerminalPaymentRequest_active_slot`): cuando una prueba necesita dos solicitudes de la misma terminal, la
 * segunda nace ya cerrada (`status`), que es además el caso que interesa.
 */
async function solicitud(overrides: Record<string, unknown> = {}) {
  return prisma.terminalPaymentRequest.create({
    data: {
      requestId: randomUUID(),
      venueId,
      terminalId: llave,
      amountCents: 10000,
      status: 'SENT',
      expiresAt: new Date(Date.now() + 5 * 60_000),
      ...overrides,
    } as Prisma.TerminalPaymentRequestUncheckedCreateInput,
  })
}

const socketDeLaTerminal = (over: Partial<{ socketId: string; terminalId: string; venueId: string }> = {}) => ({
  socketId: `socket-${++ranura}`,
  terminalId: serial,
  venueId,
  ...over,
})

/** Un ack que la prueba EXIGE exitoso: su `outcome` sólo existe en esa rama del tipo (una aserción, no un `as`). */
const exitoso = (ack: AttemptLinkAck): Extract<AttemptLinkAck, { success: true }> => {
  expect(ack.success).toBe(true)
  return ack as Extract<AttemptLinkAck, { success: true }>
}
const evento = (requestId: string, attemptId: string, terminal = socketDeLaTerminal()) =>
  terminalPaymentService.handleAttemptOpenedFromSocket({ requestId, attemptId }, terminal)

const vinculos = (requestId: string) => prisma.terminalPaymentAttemptLink.findMany({ where: { requestId } })
const alarmas = () => (logger.error as jest.Mock).mock.calls.filter(([msg]) => typeof msg === 'string' && msg.includes('🚨'))

describe('S1 · apertura de intento sobre una solicitud en vuelo', () => {
  it('la terminal dueña vincula su intento; la fila ya es legible cuando el ack se resuelve', async () => {
    const fila = await solicitud()
    const attemptId = randomUUID()

    const ack = await evento(fila.requestId, attemptId)

    expect(ack).toEqual({ success: true, outcome: 'LINKED', requestStatus: 'SENT', executionAuthorized: true })
    const [link] = await vinculos(fila.requestId)
    expect(link).toMatchObject({ attemptId, venueId, terminalId: llave })
    expect(alarmas()).toHaveLength(0)
  })

  it('el mismo vínculo repetido es idempotente (ALREADY_LINKED), también después de que la solicitud cerró', async () => {
    const fila = await solicitud()
    const attemptId = randomUUID()
    await evento(fila.requestId, attemptId)

    expect(await evento(fila.requestId, attemptId)).toMatchObject({ success: true, outcome: 'ALREADY_LINKED', requestStatus: 'SENT' })
    await prisma.terminalPaymentRequest.update({ where: { id: fila.id }, data: { status: 'COMPLETED' } })
    expect(await evento(fila.requestId, attemptId)).toMatchObject({ success: true, outcome: 'ALREADY_LINKED', requestStatus: 'COMPLETED' })
    expect(await vinculos(fila.requestId)).toHaveLength(1)
  })

  it('un reintento tras un rechazo abre OTRO intento sobre la misma solicitud', async () => {
    const fila = await solicitud()
    const [A, B] = [randomUUID(), randomUUID()]

    expect(exitoso(await evento(fila.requestId, A)).outcome).toBe('LINKED')
    expect(exitoso(await evento(fila.requestId, B)).outcome).toBe('LINKED')
    expect((await vinculos(fila.requestId)).map(l => l.attemptId).sort()).toEqual([A, B].sort())
  })

  it('sobre una solicitud UNKNOWN (ranura retenida, desenlace incierto) el intento se vincula como en vuelo', async () => {
    const fila = await solicitud({ status: 'UNKNOWN' })
    // Codex R1 (P2): la ranura sigue retenida (LINKED, evidencia), pero el permiso de EJECUTAR sólo lo da una solicitud en vuelo.
    expect(await evento(fila.requestId, randomUUID())).toEqual({
      success: true,
      outcome: 'LINKED',
      requestStatus: 'UNKNOWN',
      executionAuthorized: false,
    })
  })

  it('sobre una solicitud CANCEL_REQUESTED el intento se vincula (evidencia) pero NO se autoriza ejecutar', async () => {
    const fila = await solicitud({ status: 'CANCEL_REQUESTED' })
    expect(await evento(fila.requestId, randomUUID())).toEqual({
      success: true,
      outcome: 'LINKED',
      requestStatus: 'CANCEL_REQUESTED',
      executionAuthorized: false,
    })
  })

  it('Codex R1 (P2): una cancelación que entra ENTRE la lectura y la escritura del vínculo se contesta con el estado VIGENTE — no autoriza ejecutar', async () => {
    const { requestId } = await solicitud()
    const A = randomUUID()
    // El POS cancela justo después de que el servidor leyó la fila «en vuelo» y mientras escribe el vínculo — Codex R5-5: el
    // vínculo se escribe dentro de su transacción, así que la cancelación se inyecta ahí (tras el INSERT, antes del veredicto).
    const webhook = await import('@/services/tpv/angelpay-webhook.service')
    const real = webhook.recuperarEventosDebilesPorVinculo
    const espia = jest.spyOn(webhook, 'recuperarEventosDebilesPorVinculo').mockImplementationOnce(async (attemptId, rid, tx) => {
      await prisma.terminalPaymentRequest.updateMany({ where: { requestId, venueId }, data: { status: 'CANCEL_REQUESTED' } })
      return real(attemptId, rid, tx)
    })
    try {
      const ack = await evento(requestId, A)
      expect(ack).toMatchObject({ success: true, outcome: 'LINKED', requestStatus: 'CANCEL_REQUESTED', executionAuthorized: false })
      expect(await vinculos(requestId)).toHaveLength(1)
    } finally {
      espia.mockRestore()
    }
  })

  it('cinco entregas simultáneas del mismo vínculo dejan UNA fila, una sola LINKED y ninguna falla', async () => {
    const fila = await solicitud()
    const attemptId = randomUUID()

    const acks = await Promise.all(Array.from({ length: 5 }, () => evento(fila.requestId, attemptId)))

    expect(acks.every(a => a.success)).toBe(true)
    expect(acks.filter(a => a.success && a.outcome === 'LINKED')).toHaveLength(1)
    expect(acks.filter(a => a.success && a.outcome === 'ALREADY_LINKED')).toHaveLength(4)
    expect(await vinculos(fila.requestId)).toHaveLength(1)
  })
})

describe('S1 · dueño inmutable e identidad', () => {
  it('un attemptId que ya pertenece a OTRA solicitud no se guarda y suena la alarma', async () => {
    const cerrada = await solicitud({ status: 'COMPLETED' })
    const enVuelo = await solicitud()
    const attemptId = randomUUID()
    await evento(cerrada.requestId, attemptId)

    const ack = await evento(enVuelo.requestId, attemptId)

    expect(ack).toEqual({ success: false, reason: 'ATTEMPT_OWNED_BY_OTHER_REQUEST' })
    expect(await vinculos(enVuelo.requestId)).toHaveLength(0)
    expect((await exigir(prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId } }))).requestId).toBe(cerrada.requestId)
    expect(alarmas()).toHaveLength(1)
  })

  it('otra terminal, u otro venue, no puede vincular una solicitud ajena', async () => {
    const fila = await solicitud()

    expect(await evento(fila.requestId, randomUUID(), socketDeLaTerminal({ terminalId: 'AVQD-N86OTRA' }))).toEqual({
      success: false,
      reason: 'NOT_OWNER',
    })
    expect(await evento(fila.requestId, randomUUID(), socketDeLaTerminal({ venueId: `${venueId}-otro` }))).toEqual({
      success: false,
      reason: 'NOT_OWNER',
    })
    expect(await vinculos(fila.requestId)).toHaveLength(0)
  })

  it('la terminal puede mandar su serial con o sin prefijo: la llave guardada es siempre la normalizada', async () => {
    const fila = await solicitud()
    const ack = await evento(fila.requestId, randomUUID(), socketDeLaTerminal({ terminalId: llave.toUpperCase() }))
    expect(exitoso(ack).outcome).toBe('LINKED')
    expect((await vinculos(fila.requestId))[0].terminalId).toBe(llave)
  })

  it('un payload inválido no escribe nada', async () => {
    const fila = await solicitud()
    expect(await evento(fila.requestId, '')).toEqual({ success: false, reason: 'INVALID' })
    expect(await evento('', randomUUID())).toEqual({ success: false, reason: 'INVALID' })
    expect(await evento(fila.requestId, 'x'.repeat(65))).toEqual({ success: false, reason: 'INVALID' })
    expect(await evento(randomUUID(), randomUUID())).toEqual({ success: false, reason: 'NOT_OWNER' })
    expect(await vinculos(fila.requestId)).toHaveLength(0)
  })
})

describe('S1 · evidencia tardía sobre una solicitud ya cerrada', () => {
  it.each(['COMPLETED', 'CANCELLED', 'TIMED_OUT', 'FAILED'] as const)(
    'un intento NUEVO sobre una solicitud %s se guarda como evidencia y NO autoriza ejecutar',
    async status => {
      const fila = await solicitud({ status })
      const attemptId = randomUUID()

      const ack = await evento(fila.requestId, attemptId)

      expect(ack).toEqual({ success: true, outcome: 'LATE_EVIDENCE', requestStatus: status, executionAuthorized: false })
      expect((await vinculos(fila.requestId)).map(l => l.attemptId)).toEqual([attemptId])
    },
  )
})

describe('S1 · consulta del dueño (la usan S2 y S6)', () => {
  it('findAttemptLink devuelve solicitud, venue y terminal; nada para un intento desconocido', async () => {
    const fila = await solicitud()
    const attemptId = randomUUID()
    await evento(fila.requestId, attemptId)

    expect(await terminalPaymentService.findAttemptLink(attemptId)).toMatchObject({ requestId: fila.requestId, venueId, terminalId: llave })
    expect(await terminalPaymentService.findAttemptLink(randomUUID())).toBeNull()
  })
})

describe('Codex R4-5 / R5-5 · el vínculo y la reapertura de los eventos débiles del intento son UNA transacción', () => {
  afterEach(() => jest.restoreAllMocks())

  it('un vínculo NUEVO reabre dentro de SU transacción; si la reapertura falla, el vínculo NO se escribe y el handler falla (la terminal reintenta el anuncio); al reintentar con la reapertura sana: LINKED', async () => {
    const webhook = await import('@/services/tpv/angelpay-webhook.service')
    const espia = jest.spyOn(webhook, 'recuperarEventosDebilesPorVinculo').mockRejectedValueOnce(new Error('recuperación caída'))
    const requestId = randomUUID()
    await solicitud({ requestId })
    const attemptId = randomUUID()

    await expect(evento(requestId, attemptId)).rejects.toThrow('recuperación caída')
    expect(espia).toHaveBeenCalledWith(attemptId, requestId, expect.anything())
    expect(await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId } })).toBeNull()

    espia.mockClear()
    const primero = await evento(requestId, attemptId)
    expect(primero).toMatchObject({ success: true, outcome: 'LINKED' })
    expect(espia).toHaveBeenCalledWith(attemptId, requestId, expect.anything())
    expect(await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId } })).toMatchObject({ requestId })
  })

  it('un vínculo REPETIDO (ALREADY_LINKED) también vuelve a mirar los eventos débiles (idempotente), fuera de la transacción: si falla, el ACK sigue siendo ALREADY_LINKED', async () => {
    const webhook = await import('@/services/tpv/angelpay-webhook.service')
    const requestId = randomUUID()
    await solicitud({ requestId })
    const attemptId = randomUUID()
    expect(await evento(requestId, attemptId)).toMatchObject({ success: true, outcome: 'LINKED' })

    const espia = jest.spyOn(webhook, 'recuperarEventosDebilesPorVinculo').mockRejectedValueOnce(new Error('recuperación caída'))
    const repetido = await evento(requestId, attemptId)
    expect(repetido).toMatchObject({ success: true, outcome: 'ALREADY_LINKED' })
    expect(espia).toHaveBeenCalledWith(attemptId, requestId)
  })
})
