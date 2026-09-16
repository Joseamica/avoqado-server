/**
 * Checkpoint 1 del webhook como primer confirmador — paso S-LEGACY (orden obligatorio de Codex, 13-sep-2026).
 *
 * Dos bloques, con dos colores distintos A PROPÓSITO:
 *
 *  A) CARACTERIZACIÓN de los APK que hoy están en la calle — VERDE hoy y tiene que SEGUIR verde cuando
 *     aterricen S9/S1/S0/S3/S2/S7/S4/S6/S5. Sin el evento nuevo de vínculo (`attemptId → requestId`) el
 *     servidor no puede saber a qué solicitud pertenece un webhook, así que: ningún Payment nace por
 *     webhook; el REST de orden y de venta rápida siguen creando y deduplicando igual (con llave y sin
 *     llave); la conciliación actual (webhook antes que el registro ⇒ PENDING/AWAITING_PAYMENT y backfill
 *     al registrar) no cambia; un `declined` no libera nada; y un cobro sin solicitud no toca ninguna fila.
 *     Las reglas LEGACY de no-reentrega (`replayPendingForTerminal` sólo DURABLE) y de sonda por capacidad
 *     (`NOT_FOUND` sólo con procedencia `[]`) YA están fijadas en `terminalPaymentRecovery.integration.test.ts`
 *     y `terminalPaymentProbe*.integration.test.ts`: no se duplican aquí, se corren juntas en la verificación.
 *
 *  B) ADVERSARIALES de la invariante nueva que Codex volvió obligatoria — ROJAS hoy, verdes tras S0/S3:
 *     «una solicitud tiene UN único ganador financiero canónico, decidido dentro de la misma transacción,
 *     también con `orderId` nulo; un segundo intento acreditado es una POSIBLE SEGUNDA CAPTURA: evidencia
 *     durable + conciliación, nunca un "duplicado resuelto" ni una fusión silenciosa». Hoy el índice sólo
 *     protege `(venueId, idempotencyKey)`: dos intentos A y B de la MISMA solicitud, ambos aprobados, dan
 *     dos Payments COMPLETED y `closeRowFromPaymentTx` vuelve «ya COMPLETED» DESPUÉS de crear el segundo.
 *
 * Sólo corre contra una base local DESECHABLE elegida por quien la lanza (`TEST_DATABASE_URL`).
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { exigir } from './webhookCheckpoint.fixture'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { recordFastPayment, recordOrderPayment } from '@/services/tpv/payment.tpv.service'
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

const fixture = `wh1-${randomUUID()}`
const venueId = fixture
// Forma de PRODUCCIÓN: `Terminal.serialNumber` con prefijo, `TerminalPaymentRequest.terminalId` con la llave
// normalizada, y `deviceSerialNumber` (el serial del JWT) tal como lo manda la app.
const serialCrudo = `N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
const serial = `AVQD-${serialCrudo}`
const llaveTerminal = terminalIdentityKey(serial)
let staffId: string
let merchantId: string
let merchantExternalId: string
let angelpayLoginId: string
let eventos = 0

/** Marcador que S0 estampa en la evidencia de una posible segunda captura (ver bloque B). */
const MARCA_SEGUNDA_CAPTURA = 'POSSIBLE_SECOND_CAPTURE'

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/)

  await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({
    data: { id: venueId, organizationId: fixture, name: fixture, slug: fixture, timezone: 'America/Mexico_City', currency: 'MXN' },
  })
  await prisma.terminal.create({ data: { venueId, name: 'N86 de prueba', serialNumber: serial, type: 'TPV_ANDROID' } })
  const staff = await prisma.staff.create({
    data: {
      email: `${fixture}-cajero@example.test`,
      firstName: 'Cajero',
      lastName: 'Webhook',
      phone: '5550000001',
      organizations: { create: { organizationId: fixture, role: 'MEMBER', isPrimary: true, isActive: true } },
      venues: { create: { venueId, role: 'CASHIER', active: true } },
    },
  })
  staffId = staff.id
  // El proveedor es semilla compartida con otras suites: se asegura, nunca se borra.
  const provider = await prisma.paymentProvider.upsert({
    where: { code: 'ANGELPAY' },
    update: {},
    create: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
  })
  // El venue del webhook se resuelve por el login de AngelPay dueño del merchant del secreto.
  const login = await prisma.angelPayUserAccount.create({
    data: { venueId, email: `${fixture}@angelpay.test`, environment: 'QA', status: 'ACTIVE' },
  })
  angelpayLoginId = login.id
  merchantExternalId = `wh1-${randomUUID().slice(0, 8)}`
  const merchant = await prisma.merchantAccount.create({
    data: {
      providerId: provider.id,
      externalMerchantId: merchantExternalId,
      alias: 'AngelPay de prueba',
      credentialsEncrypted: {},
      angelpayUserAccountId: login.id,
    },
  })
  merchantId = merchant.id
})

beforeEach(() => {
  jest.clearAllMocks()
  const socket = { emit: jest.fn(), timeout: () => ({ emit: jest.fn() }) }
  ;(socketManager.getServer as jest.Mock).mockReturnValue({
    sockets: { sockets: new Map([['fixture-socket', socket]]) },
    to: () => ({ emit: jest.fn() }),
  })
  ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
    terminalId,
    venueId,
    socketId: 'fixture-socket',
    terminalPaymentAckVersion: 1,
  }))
})

afterEach(async () => {
  await prisma.providerEventLog.deleteMany({ where: { eventId: { startsWith: `angelpay-${fixture}` } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
})

afterAll(async () => {
  await prisma.merchantAccount.deleteMany({ where: { id: merchantId } })
  await prisma.angelPayUserAccount.deleteMany({ where: { id: angelpayLoginId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: fixture } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
})

// ───────────────────────────── fixtures ─────────────────────────────

async function nuevaVenta(total = 100) {
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: `${fixture}-${randomUUID().slice(0, 8)}`,
      type: 'TAKEOUT',
      source: 'TPV',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      subtotal: new Prisma.Decimal(total),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(total),
      createdById: staffId,
    },
  })
}

/** Solicitud POS → terminal en vuelo (SENT), con o sin orden, con el contrato de dinero del POS. */
async function solicitud(overrides: Record<string, unknown> = {}) {
  return prisma.terminalPaymentRequest.create({
    data: {
      requestId: randomUUID(),
      venueId,
      terminalId: llaveTerminal,
      orderId: null,
      amountCents: 10000,
      tipCents: 0,
      status: 'SENT',
      expiresAt: new Date(Date.now() + 5 * 60_000),
      ...overrides,
    } as Prisma.TerminalPaymentRequestUncheckedCreateInput,
  })
}

/** Payload REST exacto de la terminal (`/tpv/orders/:id/payments` y `/tpv/fast`), importes en centavos. */
function registroDeLaTerminal(intento: {
  attemptId: string
  requestId?: string | null
  auth?: string
  ref?: string
  sinLlave?: boolean
  sinMerchant?: boolean
}) {
  return {
    venueId,
    amount: 10000,
    tip: 0,
    status: 'COMPLETED',
    method: 'CREDIT_CARD',
    source: 'TPV',
    splitType: 'FULLPAYMENT',
    staffId,
    authorizationNumber: intento.auth ?? `AUTH-${intento.attemptId.slice(0, 6)}`,
    referenceNumber: intento.ref ?? `REF-${intento.attemptId.slice(0, 12)}`,
    ...(intento.sinLlave ? {} : { idempotencyKey: intento.attemptId }),
    ...(intento.sinMerchant ? {} : { merchantAccountId: merchantId }),
    paidProductsId: [],
    currency: 'MXN',
    isInternational: false,
    deviceSerialNumber: serial,
    // Lo que pone el controlador desde el JWT (S0, P1-2): las pruebas llaman al servicio directo.
    authenticatedTerminalSerial: serial,
    ...(intento.requestId ? { terminalPaymentRequestId: intento.requestId } : {}),
  } as any
}

function eventoAngelPay(attemptId: string | undefined, over: Record<string, unknown> = {}) {
  return {
    event_type: 'send_transaction',
    payload: {
      amount: '000000010000', // 10000 centavos = $100.00, cadena rellena de ceros como la manda AngelPay
      description: 'APROBADA',
      status: 'approved',
      ...(attemptId ? { integratorReference: attemptId } : {}),
      transactionId: `${Date.now()}${eventos}`,
      terminalSerial: serialCrudo,
      timestamp: new Date().toISOString(),
      ...over,
    },
  }
}

async function webhook(payload: unknown, eventId = `${fixture}-ev-${++eventos}`) {
  return processAngelPayWebhook({
    payload,
    eventId,
    merchantAccount: { id: merchantId, externalMerchantId: merchantExternalId },
    retryDelaysMs: [0], // sin las esperas de 2 s + 3 s del matcher: aquí se prueba el desenlace, no la paciencia
  })
}

const eventoGuardado = (eventId: string) =>
  exigir(prisma.providerEventLog.findFirst({ where: { provider: 'PAYMENT_PROCESSOR', eventId: `angelpay-${eventId}` } }))

async function esperarA<T>(consulta: () => Promise<T | null | undefined>, ms = 5000): Promise<T> {
  const limite = Date.now() + ms
  for (;;) {
    const valor = await consulta()
    if (valor) return valor
    if (Date.now() > limite) throw new Error('no ocurrió a tiempo')
    await new Promise(r => setTimeout(r, 100))
  }
}

const pagosDelVenue = () => prisma.payment.count({ where: { venueId } })

// ═══════════════════════ A · CARACTERIZACIÓN (verde hoy, verde después) ═══════════════════════

describe('A · Sin el evento de vínculo, los APK de hoy siguen exactamente igual', () => {
  it('un webhook approved sin Payment que case NO crea dinero: queda PENDING/AWAITING_PAYMENT y la solicitud sigue en vuelo', async () => {
    const fila = await solicitud({ orderId: (await nuevaVenta()).id })
    const attemptId = randomUUID()
    const eventId = `${fixture}-ev-${++eventos}`

    const resultado = await webhook(eventoAngelPay(attemptId), eventId)

    expect(resultado).toMatchObject({ action: 'ORPHANED', errorReason: 'AWAITING_PAYMENT' })
    const evento = await eventoGuardado(eventId)
    expect(evento).toMatchObject({ status: 'PENDING', errorReason: 'AWAITING_PAYMENT', paymentId: null, venueId })
    expect(await pagosDelVenue()).toBe(0)
    const despues = await exigir(prisma.terminalPaymentRequest.findUnique({ where: { id: fila.id } }))
    expect(despues).toMatchObject({ status: 'SENT', paymentId: null })
  })

  it('la MISMA entrega repetida (mismo eventId) es DUPLICATE: un solo evento, cero Payments', async () => {
    const attemptId = randomUUID()
    const eventId = `${fixture}-ev-${++eventos}`
    await webhook(eventoAngelPay(attemptId), eventId)

    const repetida = await webhook(eventoAngelPay(attemptId), eventId)

    expect(repetida.action).toBe('DUPLICATE')
    expect(await prisma.providerEventLog.count({ where: { eventId: `angelpay-${eventId}` } })).toBe(1)
    expect(await pagosDelVenue()).toBe(0)
  })

  it('un webhook SIN `status` se tolera para conciliar (comportamiento actual), pero tampoco crea dinero', async () => {
    const eventId = `${fixture}-ev-${++eventos}`
    const resultado = await webhook(eventoAngelPay(randomUUID(), { status: undefined }), eventId)

    expect(resultado.action).toBe('ORPHANED')
    expect((await eventoGuardado(eventId)).status).toBe('PENDING')
    expect(await pagosDelVenue()).toBe(0)
  })

  it('un webhook declined es evidencia (ERROR/NOT_APPROVED) y NO libera la solicitud ni toca la orden', async () => {
    const venta = await nuevaVenta()
    const fila = await solicitud({ orderId: venta.id })
    const eventId = `${fixture}-ev-${++eventos}`

    const resultado = await webhook(eventoAngelPay(randomUUID(), { status: 'declined', description: 'DECLINADA' }), eventId)

    expect(resultado).toMatchObject({ action: 'NOT_APPROVED', errorReason: 'NOT_APPROVED' })
    expect(await eventoGuardado(eventId)).toMatchObject({ status: 'ERROR', errorReason: 'NOT_APPROVED', paymentId: null })
    expect(await pagosDelVenue()).toBe(0)
    expect(await exigir(prisma.terminalPaymentRequest.findUnique({ where: { id: fila.id } }))).toMatchObject({
      status: 'SENT',
      paymentId: null,
    })
    expect((await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).paymentStatus).toBe('PENDING')
  })

  it('webhook ANTES del registro: el REST de orden crea el único Payment, cierra la solicitud y el backfill concilia el evento PENDING', async () => {
    const venta = await nuevaVenta()
    const fila = await solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const eventId = `${fixture}-ev-${++eventos}`
    expect((await webhook(eventoAngelPay(attemptId), eventId)).action).toBe('ORPHANED')

    const registrado = await recordOrderPayment(venueId, venta.id, registroDeLaTerminal({ attemptId, requestId: fila.requestId }), staffId)

    expect(await pagosDelVenue()).toBe(1)
    const despues = await exigir(prisma.terminalPaymentRequest.findUnique({ where: { id: fila.id } }))
    expect(despues).toMatchObject({ status: 'COMPLETED', paymentId: registrado.id })
    const pago = await exigir(prisma.payment.findUnique({ where: { id: registrado.id } }))
    expect(pago.idempotencyKey).toBe(attemptId)
    expect(pago.merchantAccountId).toBe(merchantId)
    expect((pago.processorData as Record<string, unknown>).terminalPaymentRequestId).toBe(fila.requestId)
    // La conciliación de hoy es fire-and-forget DESPUÉS del commit: se espera, no se asume.
    const conciliado = await esperarA(async () => {
      const e = await eventoGuardado(eventId)
      return e.status === 'PROCESSED' ? e : null
    })
    expect(conciliado.paymentId).toBe(registrado.id)
    const enriquecido = await exigir(prisma.payment.findUnique({ where: { id: registrado.id } }))
    expect((enriquecido.processorData as any).angelpayWebhook?.integratorReference).toBe(attemptId)
    expect((await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).paymentStatus).toBe('PAID')
  })

  it('webhook DESPUÉS del registro: MATCHED contra el Payment existente, sin segundo Payment', async () => {
    const venta = await nuevaVenta()
    const fila = await solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const registrado = await recordOrderPayment(venueId, venta.id, registroDeLaTerminal({ attemptId, requestId: fila.requestId }), staffId)
    const eventId = `${fixture}-ev-${++eventos}`

    const resultado = await webhook(eventoAngelPay(attemptId), eventId)

    expect(resultado).toMatchObject({ action: 'MATCHED', paymentId: registrado.id })
    expect(await eventoGuardado(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: registrado.id })
    expect(await pagosDelVenue()).toBe(1)
  })

  it('un importe distinto al registrado es DISCREPANCY: el Payment no se toca en dinero y no nace otro', async () => {
    const venta = await nuevaVenta()
    const fila = await solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const registrado = await recordOrderPayment(venueId, venta.id, registroDeLaTerminal({ attemptId, requestId: fila.requestId }), staffId)
    const eventId = `${fixture}-ev-${++eventos}`

    const resultado = await webhook(eventoAngelPay(attemptId, { amount: '000000010500' }), eventId)

    expect(resultado).toMatchObject({ action: 'DISCREPANCY', errorReason: 'AMOUNT_MISMATCH', paymentId: registrado.id })
    expect(await eventoGuardado(eventId)).toMatchObject({ status: 'ERROR', errorReason: 'AMOUNT_MISMATCH' })
    const pago = await exigir(prisma.payment.findUnique({ where: { id: registrado.id } }))
    expect(Number(pago.amount)).toBe(100)
    expect(Number(pago.tipAmount)).toBe(0)
    expect(await pagosDelVenue()).toBe(1)
  })

  it('el reintento REST con la MISMA llave devuelve el mismo Payment en la ruta de orden', async () => {
    const venta = await nuevaVenta()
    const fila = await solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const datos = registroDeLaTerminal({ attemptId, requestId: fila.requestId })

    const primero = await recordOrderPayment(venueId, venta.id, datos, staffId)
    const reintento = await recordOrderPayment(venueId, venta.id, datos, staffId)

    expect(reintento.id).toBe(primero.id)
    expect(await pagosDelVenue()).toBe(1)
    expect((await exigir(prisma.terminalPaymentRequest.findUnique({ where: { id: fila.id } }))).paymentId).toBe(primero.id)
  })

  it('el reintento REST con la MISMA llave devuelve el mismo Payment en la venta rápida (solicitud sin orden)', async () => {
    const fila = await solicitud({ orderId: null })
    const attemptId = randomUUID()
    const datos = registroDeLaTerminal({ attemptId, requestId: fila.requestId })

    const primero = await recordFastPayment(venueId, datos, staffId)
    const reintento = await recordFastPayment(venueId, datos, staffId)

    expect(reintento.id).toBe(primero.id)
    expect(await pagosDelVenue()).toBe(1)
    expect(await exigir(prisma.terminalPaymentRequest.findUnique({ where: { id: fila.id } }))).toMatchObject({
      status: 'COMPLETED',
      paymentId: primero.id,
    })
  })

  it('un reintento LEGACY sin llave pero con la misma referencia sigue deduplicándose contra el existente', async () => {
    const venta = await nuevaVenta()
    const fila = await solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const primero = await recordOrderPayment(
      venueId,
      venta.id,
      registroDeLaTerminal({ attemptId, requestId: fila.requestId, ref: `REF-LEGACY-${eventos}` }),
      staffId,
    )

    // Codex R4: un reintento REAL trae la MISMA autorización del banco; con otra autorización sería otro cargo (colisión).
    const reintento = await recordOrderPayment(
      venueId,
      venta.id,
      registroDeLaTerminal({
        attemptId: randomUUID(),
        requestId: fila.requestId,
        ref: `REF-LEGACY-${eventos}`,
        sinLlave: true,
        auth: primero.authorizationNumber ?? undefined,
      }),
      staffId,
    )

    expect(reintento.id).toBe(primero.id)
    expect(await pagosDelVenue()).toBe(1)
  })

  it('un cobro LOCAL de la terminal (sin solicitud, sin merchant de AngelPay) no toca ninguna solicitud ni ningún evento', async () => {
    const venta = await nuevaVenta()
    const enVuelo = await solicitud({ orderId: (await nuevaVenta()).id })
    const eventosAntes = await prisma.providerEventLog.count({ where: { eventId: { startsWith: `angelpay-${fixture}` } } })

    const local = await recordOrderPayment(venueId, venta.id, registroDeLaTerminal({ attemptId: randomUUID(), sinMerchant: true }), staffId)

    expect(local.status).toBe('COMPLETED')
    expect(await exigir(prisma.terminalPaymentRequest.findUnique({ where: { id: enVuelo.id } }))).toMatchObject({
      status: 'SENT',
      paymentId: null,
    })
    expect(await prisma.providerEventLog.count({ where: { eventId: { startsWith: `angelpay-${fixture}` } } })).toBe(eventosAntes)
  })
})

// ═══════════════════ B · ADVERSARIALES: UN ganador financiero por solicitud (rojo hoy) ═══════════════════

/**
 * Lo que S0 tiene que garantizar, medido en la base y no en el valor de retorno:
 *  1. la solicitud queda COMPLETED con UN `paymentId`: el ganador;
 *  2. de los intentos acreditados, EXACTAMENTE uno es un Payment COMPLETED normal (el ganador);
 *  3. el otro intento NO desaparece: queda durable, ligado a la solicitud y al ganador,
 *     marcado como posible segunda captura para conciliación — nunca como un segundo cobro normal
 *     ni fusionado en silencio con el primero.
 */
async function comprobarUnSoloGanador(requestId: string, intentos: string[]) {
  const fila = await exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
  expect(fila.status).toBe('COMPLETED')
  expect(fila.paymentId).not.toBeNull()

  const pagos = await prisma.payment.findMany({ where: { venueId, idempotencyKey: { in: intentos } } })
  expect(pagos.map(p => p.idempotencyKey).sort()).toEqual([...intentos].sort()) // ninguna captura desaparece

  const completados = pagos.filter(p => p.status === 'COMPLETED')
  expect(completados.map(p => p.id)).toEqual([fila.paymentId]) // UN ganador, y es el de la fila

  for (const segunda of pagos.filter(p => p.id !== fila.paymentId)) {
    expect(segunda.status).not.toBe('COMPLETED')
    const meta = (segunda.processorData ?? {}) as Record<string, any>
    expect(meta.reconciliation).toMatchObject({ kind: MARCA_SEGUNDA_CAPTURA, requestId, winnerPaymentId: fila.paymentId })
  }
  return fila
}

describe('B · Dos intentos aprobados de la MISMA solicitud producen UN ganador y una segunda captura para conciliar', () => {
  it('secuencial, con orden (ruta de orden): B llega después de que A ya cerró la solicitud', async () => {
    const venta = await nuevaVenta()
    const fila = await solicitud({ orderId: venta.id })
    const [A, B] = [randomUUID(), randomUUID()]

    await recordOrderPayment(venueId, venta.id, registroDeLaTerminal({ attemptId: A, requestId: fila.requestId }), staffId)
    await recordOrderPayment(venueId, venta.id, registroDeLaTerminal({ attemptId: B, requestId: fila.requestId }), staffId)

    await comprobarUnSoloGanador(fila.requestId, [A, B])
    // La venta se saldó UNA vez: la segunda captura no la sobrepaga en silencio.
    expect(await prisma.payment.count({ where: { orderId: venta.id, status: 'COMPLETED' } })).toBe(1)
    expect((await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).paymentStatus).toBe('PAID')
  })

  it('secuencial, SIN orden (venta rápida): el `orderId` nulo no exime a la solicitud de tener un solo ganador', async () => {
    const fila = await solicitud({ orderId: null })
    const [A, B] = [randomUUID(), randomUUID()]

    await recordFastPayment(venueId, registroDeLaTerminal({ attemptId: A, requestId: fila.requestId }), staffId)
    await recordFastPayment(venueId, registroDeLaTerminal({ attemptId: B, requestId: fila.requestId }), staffId)

    await comprobarUnSoloGanador(fila.requestId, [A, B])
  })

  it('concurrente, con orden: A y B se registran a la vez', async () => {
    const venta = await nuevaVenta()
    const fila = await solicitud({ orderId: venta.id })
    const [A, B] = [randomUUID(), randomUUID()]

    const desenlaces = await Promise.allSettled([
      recordOrderPayment(venueId, venta.id, registroDeLaTerminal({ attemptId: A, requestId: fila.requestId }), staffId),
      recordOrderPayment(venueId, venta.id, registroDeLaTerminal({ attemptId: B, requestId: fila.requestId }), staffId),
    ])
    // Ningún intento acreditado puede perderse por un rechazo: los dos tienen que quedar registrados.
    expect(desenlaces.map(d => d.status)).toEqual(['fulfilled', 'fulfilled'])

    await comprobarUnSoloGanador(fila.requestId, [A, B])
    expect(await prisma.payment.count({ where: { orderId: venta.id, status: 'COMPLETED' } })).toBe(1)
  })

  it('concurrente, SIN orden: A y B se registran a la vez como venta rápida', async () => {
    const fila = await solicitud({ orderId: null })
    const [A, B] = [randomUUID(), randomUUID()]

    const desenlaces = await Promise.allSettled([
      recordFastPayment(venueId, registroDeLaTerminal({ attemptId: A, requestId: fila.requestId }), staffId),
      recordFastPayment(venueId, registroDeLaTerminal({ attemptId: B, requestId: fila.requestId }), staffId),
    ])
    expect(desenlaces.map(d => d.status)).toEqual(['fulfilled', 'fulfilled'])

    await comprobarUnSoloGanador(fila.requestId, [A, B])
  })
})
