/*
  tests/integration/payments/noInstrumentSinSolicitud.integration.test.ts

  «Ninguna terminal muerta» (22-sep-2026), pieza B: la declaración del cajero «el cliente no presentó tarjeta»
  sobre un intento SIN solicitud del POS — un **Pago rápido**, cobro iniciado EN la terminal.

  Hasta hoy `resolveNoInstrument` exigía `requestId`, bloqueaba la fila de la solicitud con FOR UPDATE y despertaba
  al POS. Un cobro local no tiene nada de eso, así que el cajero se quedaba sin salida y la terminal muerta.

  🔴 Lo que estas pruebas fijan y NO puede debilitarse: sin solicitud los vetos de dinero que quedan son el
  `Payment` con la llave del intento y la evidencia del procesador — y son toda la evidencia que el servidor tiene
  de un cobro local. Si alguno existe, la declaración se RECHAZA.
*/
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { crearFixture, exigirBaseDesechable, type Fixture } from './webhookCheckpoint.fixture'
import { resolveNoInstrument, NO_INSTRUMENT_PERMISSION } from '@/services/tpv/no-instrument-resolution.service'

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn(() => null), emitDurableTerminalPaymentResult: jest.fn() },
}))

let f: Fixture
beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('nosolic')
})
// 🔴 Lo que ESTA suite crea y la fixture no conoce se limpia aquí: `VenueRolePermission` tiene FK a `Staff`, así que
// dejarla viva hace fallar el `destruir()` de la fixture al borrar el staff (no es un defecto del código, es basura mía).
afterEach(async () => {
  await prisma.terminalAttemptResolution.deleteMany({ where: { venueId: f.venueId } })
  await prisma.venueRolePermission.deleteMany({ where: { venueId: f.venueId } })
  // El venue hermano y las supervisoras que crean las pruebas de los P1 de Codex: la fixture no los conoce, y sus
  // FKs (Payment → Order → Venue, VenueRolePermission → Staff) hacen fallar su `destruir()` si se quedan vivos.
  const hermano = `${f.fixture}-hermano`
  await prisma.providerEventLog.deleteMany({ where: { venueId: hermano } })
  await prisma.payment.deleteMany({ where: { venueId: hermano } })
  await prisma.order.deleteMany({ where: { venueId: hermano } })
  await prisma.venue.deleteMany({ where: { id: hermano } })
  await prisma.staffVenue.deleteMany({ where: { venueId: f.venueId, staff: { email: { contains: '-sup-' } } } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: f.fixture, staff: { email: { contains: '-sup-' } } } })
  await prisma.staff.deleteMany({ where: { email: { contains: `${f.fixture}-sup-` } } })
  await f.limpiar()
})
afterAll(() => f.destruir())

/**
 * El cajero de la fixture, con el permiso de declarar. El servicio lo evalúa por ROL (`hasPermission` sobre
 * `VenueRolePermission`), NO por `StaffVenue.permissions` — escribir ahí no concede nada.
 */
async function cajeroConPermiso() {
  const sv = await prisma.staffVenue.findFirst({ where: { venueId: f.venueId, staffId: f.staffId } })
  await prisma.venueRolePermission.upsert({
    where: { venueId_role: { venueId: f.venueId, role: sv!.role } },
    create: { venueId: f.venueId, role: sv!.role, permissions: [NO_INSTRUMENT_PERMISSION], deniedPermissions: [], modifiedBy: f.staffId },
    update: { permissions: [NO_INSTRUMENT_PERMISSION], deniedPermissions: [] },
  })
  return f.staffId
}

/** Lo contrario, explícito: el rol tiene el permiso NEGADO. */
async function cajeroSinPermiso() {
  const sv = await prisma.staffVenue.findFirst({ where: { venueId: f.venueId, staffId: f.staffId } })
  await prisma.venueRolePermission.upsert({
    where: { venueId_role: { venueId: f.venueId, role: sv!.role } },
    create: { venueId: f.venueId, role: sv!.role, permissions: [], deniedPermissions: [NO_INSTRUMENT_PERMISSION], modifiedBy: f.staffId },
    update: { permissions: [], deniedPermissions: [NO_INSTRUMENT_PERMISSION] },
  })
}

const declarar = (attemptId: string, over: Record<string, unknown> = {}) =>
  resolveNoInstrument(
    { venueId: f.venueId, terminalSerial: f.serial, attemptId, actorStaffId: f.staffId },
    { resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1, ...over },
  )

/**
 * Un `Payment` con la MISMA llave de intento pero en OTRO negocio. Codex (P1-1): el filtro por venue lo ocultaba,
 * y el camino con solicitud sí lo ve porque busca la llave globalmente. Se limpia en el `afterEach`.
 */
async function venueHermano(): Promise<string> {
  const hermano = `${f.fixture}-hermano`
  await prisma.venue.upsert({
    where: { id: hermano },
    create: { id: hermano, organizationId: f.fixture, name: hermano, slug: hermano, timezone: 'America/Mexico_City', currency: 'MXN' },
    update: {},
  })
  return hermano
}

async function pagoEnOtroVenue(attemptId: string) {
  const hermano = await venueHermano()
  const orden = await prisma.order.create({
    data: {
      venueId: hermano, orderNumber: `h-${randomUUID().slice(0, 8)}`, type: 'TAKEOUT', source: 'TPV',
      status: 'PENDING', paymentStatus: 'PENDING', subtotal: 100, taxAmount: 0, total: 100, createdById: f.staffId,
    },
  })
  return prisma.payment.create({
    data: {
      venueId: hermano, orderId: orden.id, amount: 100, method: 'CREDIT_CARD', status: 'COMPLETED',
      feePercentage: 0, feeAmount: 0, netAmount: 100, idempotencyKey: attemptId,
    },
  })
}

/** Otra persona del MISMO venue, con PIN y con el permiso: es quien puede ELEVAR a un cajero que no lo tiene. */
async function supervisorConPin() {
  const pin = '4821'
  const staff = await prisma.staff.create({
    data: {
      firstName: 'Supervisora', lastName: 'Test', email: `${f.fixture}-sup-${randomUUID().slice(0, 6)}@example.test`, active: true,
      organizations: { create: { organizationId: f.fixture, role: 'MEMBER', isPrimary: true, isActive: true } },
    },
  })
  await prisma.staffVenue.create({ data: { venueId: f.venueId, staffId: staff.id, role: 'MANAGER', pin, active: true } })
  await prisma.venueRolePermission.upsert({
    where: { venueId_role: { venueId: f.venueId, role: 'MANAGER' } },
    create: { venueId: f.venueId, role: 'MANAGER', permissions: [NO_INSTRUMENT_PERMISSION], deniedPermissions: [], modifiedBy: f.staffId },
    update: { permissions: [NO_INSTRUMENT_PERMISSION], deniedPermissions: [] },
  })
  return { staffId: staff.id, pin }
}

const consultar = (attemptId: string, serial = f.serial) =>
  terminalPaymentService.consultarIntentoDeTerminal({ attemptId, venueId: f.venueId, terminalSerial: serial })

describe('Pieza B · declarar «no se presentó tarjeta» SIN solicitud del POS', () => {
  it('sin evidencia: la declaración se acepta, queda durable y S6 la publica en `attempt.resolution`', async () => {
    await cajeroConPermiso()
    const A = randomUUID()

    const r = await declarar(A)
    // MISMA forma que el camino con solicitud: proyección de S6 + `resolution` (id/acceptedAt/by, el contrato que leen
    // las apps publicadas — no se toca). El `kind` se comprueba abajo, en la fila durable y en lo que publica S6.
    const eco = (r as { resolution?: { id?: string; by?: string } }).resolution
    expect(eco?.id).toEqual(expect.any(String))
    expect(eco?.by).toBe('SESSION')

    // Durable, y UNA sola vez: el `attemptId` es único.
    const fila = await prisma.terminalAttemptResolution.findUnique({ where: { attemptId: A } })
    expect(fila).not.toBeNull()
    expect(fila!.venueId).toBe(f.venueId)

    // 🔑 Lo que destraba a la terminal: S6 lo publica en el intento, no dentro de `request` (que aquí es null).
    const visto = await consultar(A)
    expect(visto).not.toBeNull()
    expect(visto!.request).toBeNull()
    expect((visto!.attempt as { resolution?: unknown }).resolution).toMatchObject({ kind: 'NO_INSTRUMENT_PRESENTED' })
  })

  it('VETO · con un Payment de ese intento, NO se puede declarar', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A }), f.staffId)

    await expect(declarar(A)).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect(await prisma.terminalAttemptResolution.findUnique({ where: { attemptId: A } })).toBeNull()
  })

  it('VETO · con un APROBADO del banco (aunque no haya Payment), NO se puede declarar', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await processAngelPayWebhook({
      payload: f.eventoAngelPay(A),
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })

    await expect(declarar(A)).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
  })

  it('replay idempotente: la MISMA declaración dos veces no reescribe ni falla', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    const cuerpo = { resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED' as const, statementVersion: 1 as const }
    const uno = await resolveNoInstrument({ venueId: f.venueId, terminalSerial: f.serial, attemptId: A, actorStaffId: f.staffId }, cuerpo)
    const dos = await resolveNoInstrument({ venueId: f.venueId, terminalSerial: f.serial, attemptId: A, actorStaffId: f.staffId }, cuerpo)
    const rUno = (uno as { resolution: { id: string; acceptedAt: string } }).resolution
    const rDos = (dos as { resolution: { id: string; acceptedAt: string } }).resolution
    expect(rDos.id).toBe(rUno.id)
    expect(rDos.acceptedAt).toBe(rUno.acceptedAt)
    expect(await prisma.terminalAttemptResolution.count({ where: { attemptId: A } })).toBe(1)
  })

  it('OTRA declaración sobre el mismo intento es un CONFLICTO, no un segundo testimonio', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await declarar(A)
    await expect(declarar(A)).rejects.toMatchObject({ code: 'RESOLUTION_CONFLICT' })
  })

  it('🔴 una aprobación TARDÍA no borra la declaración: se conserva y el dinero se publica igual', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await declarar(A)
    // El banco aprueba DESPUÉS de que el cajero declaró.
    await processAngelPayWebhook({
      payload: f.eventoAngelPay(A),
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })
    expect(await prisma.terminalAttemptResolution.findUnique({ where: { attemptId: A } })).not.toBeNull()
    const visto = await consultar(A)
    expect(visto!.attempt.processorEvidence).toBe('APPROVED')
    expect((visto!.attempt as { resolution?: unknown }).resolution).toMatchObject({ kind: 'NO_INSTRUMENT_PRESENTED' })
  })

  it('AISLAMIENTO · la declaración de esta terminal no la ve OTRA terminal del mismo venue', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await declarar(A)
    const otroSerial = `AVQD-N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
    await prisma.terminal.create({ data: { venueId: f.venueId, name: 'otra', serialNumber: otroSerial, type: 'TPV_ANDROID' } })
    const visto = await consultar(A, otroSerial)
    expect((visto?.attempt as { resolution?: unknown } | undefined)?.resolution ?? null).toBeNull()
  })

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Codex (22-sep) RECHAZÓ la pieza B con 4 P1. Todos nacen de lo mismo: al abrir el camino local, las
  // guardas que protegen el dinero pasaron a depender de lo que MANDA EL CLIENTE en vez de lo que
  // CONSTA en la base. Estas pruebas fijan la corrección.
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('🔴 P1-4 · un intento CON vínculo NO entra al camino local aunque el cuerpo omita `requestId`', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    // Una solicitud cuyo sobre AFIRMA cobro: el camino con solicitud la veta con `senalPositiva`.
    const req = await f.solicitud({ resultJson: { claimedSuccess: { authorizationCode: 'AUTH-123' } } })
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
    })

    // 🔴 El CAMINO lo decide la BASE: existe vínculo ⇒ se aplican las guardas de su solicitud, mande o no `requestId`.
    await expect(declarar(A)).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect(await prisma.terminalAttemptResolution.findUnique({ where: { attemptId: A } })).toBeNull()
  })

  it('🔴 P1-4b · nunca DOS testimonios del mismo intento, uno por tabla', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    const req = await f.solicitud()
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
    })

    // Con vínculo, la declaración (con o sin `requestId` en el cuerpo) va SIEMPRE al vínculo: la tabla local queda vacía.
    await declarar(A)
    expect(await prisma.terminalAttemptResolution.findUnique({ where: { attemptId: A } })).toBeNull()
    const link = await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId: A } })
    expect(link!.operatorResolution).not.toBeNull()
  })

  it('🔴 r4-1 · un vínculo que aparece DESPUÉS de la declaración local no produce un segundo testimonio', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await declarar(A)   // declaración LOCAL: no había vínculo

    // Ahora llega la solicitud del POS y se vincula ese mismo intento.
    const req = await f.solicitud()
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
    })

    // Declarar otra vez ya NO es un camino nuevo: el testimonio local existe y manda.
    await expect(declarar(A)).rejects.toMatchObject({ code: 'RESOLUTION_CONFLICT' })
    const link = await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId: A } })
    expect(link!.operatorResolution).toBeNull()   // ni un segundo testimonio en la otra tabla
    expect(await prisma.terminalAttemptResolution.count({ where: { attemptId: A } })).toBe(1)
  })

  it('🔴 P1-1 · un Payment con la llave SIN RECORTAR veta igual — los espacios no son una llave distinta', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await recordFastPayment(f.venueId, { ...f.registroDeLaTerminal({ attemptId: A }), idempotencyKey: `  ${A}  ` }, f.staffId)

    await expect(declarar(A)).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect(await prisma.terminalAttemptResolution.findUnique({ where: { attemptId: A } })).toBeNull()
  })

  it('🔴 r4-2 · la llave con TABULADOR o SALTO DE LÍNEA veta igual — `btrim` no es `trim()`', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    // `llaveDeIntento` usa `String.trim()`, que quita tabuladores, saltos, NBSP y los separadores Unicode; `btrim` de
    // Postgres sólo quita el espacio ASCII. Un Payment guardado con `\tA\n` se escapaba de las DOS capas del veto.
    // El repo ya tenía la regla correcta escrita (`PATRON_SQL_TRIM_COMO_JS`), usada por el serial de la terminal.
    await recordFastPayment(f.venueId, { ...f.registroDeLaTerminal({ attemptId: A }), idempotencyKey: `\t${A}\n` }, f.staffId)

    await expect(declarar(A)).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect(await prisma.terminalAttemptResolution.findUnique({ where: { attemptId: A } })).toBeNull()
  })

  it('🔴 P1-1b · un Payment de OTRO venue con esa llave es una CONTRADICCIÓN, no un intento libre', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await pagoEnOtroVenue(A)

    // El camino CON solicitud lo veta con su búsqueda GLOBAL por llave; el local no puede ser más débil.
    await expect(declarar(A)).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect(await prisma.terminalAttemptResolution.findUnique({ where: { attemptId: A } })).toBeNull()
  })

  it('🔴 P2-5 · el replay NO devuelve la declaración de OTRA terminal', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    const cuerpo = { resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED' as const, statementVersion: 1 as const }
    await resolveNoInstrument({ venueId: f.venueId, terminalSerial: f.serial, attemptId: A, actorStaffId: f.staffId }, cuerpo)

    const otroSerial = `AVQD-N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
    await prisma.terminal.create({ data: { venueId: f.venueId, name: 'otra', serialNumber: otroSerial, type: 'TPV_ANDROID' } })

    // B conoce el attemptId, el resolutionId y el cuerpo — y aun así no se lleva el testimonio de A.
    await expect(
      resolveNoInstrument({ venueId: f.venueId, terminalSerial: otroSerial, attemptId: A, actorStaffId: f.staffId }, cuerpo),
    ).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' })
  })

  it('🔴 P2-6 · con PIN de supervisor, la bitácora conserva TAMBIÉN al cajero que operó', async () => {
    await cajeroSinPermiso()
    const supervisor = await supervisorConPin()
    const A = randomUUID()

    await declarar(A, { supervisorPin: supervisor.pin })

    const asiento = await prisma.activityLog.findFirst({
      where: { action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED', entityId: A },
    })
    expect(asiento).not.toBeNull()
    // El autorizante es el supervisor; el que operó la terminal es el cajero de la sesión. Los dos, o no hay rastro.
    expect(asiento!.staffId).toBe(supervisor.staffId)
    expect((asiento!.data as { sessionStaffId?: string }).sessionStaffId).toBe(f.staffId)
  })

  it('🔴 r4-3 · un pago TARDÍO que el POST vetaría, S6 lo publica como CONTRADICCIÓN (no como declaración limpia)', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await declarar(A)
    // El dinero aparece DESPUÉS de la declaración, con la llave sucia. El POST lo vetaría; S6 buscaba por venue propio
    // y llave EXACTA, así que publicaba la declaración como si nada la contradijera — y el cliente la usa para liberar.
    await recordFastPayment(f.venueId, { ...f.registroDeLaTerminal({ attemptId: A }), idempotencyKey: `  ${A}  ` }, f.staffId)

    const visto = await consultar(A)
    expect(visto!.attempt.paymentContradiction).toBe(true)
  })

  it('🔴 r4-3b · lo mismo con un pago de OTRO venue: contradicción, sin filtrar nada de ese pago', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await declarar(A)
    await pagoEnOtroVenue(A)

    const visto = await consultar(A)
    expect(visto!.attempt.paymentContradiction).toBe(true)
    expect(visto!.attempt.paymentId).toBeNull() // nada del pago ajeno se publica
  })

  it('🔴 P1-3 · una aprobación tardía SIN serial no puede pasar por «se puede volver a cobrar»', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await declarar(A)

    // El banco aprueba DESPUÉS, y su evento llega sin número de serie: la regla de pertenencia (pieza A) lo excluye
    // de la evidencia —correctamente, no es de nadie— pero entonces S6 publicaba la declaración como si nada la
    // contradijera, y la terminal la habría usado para soltar la venta.
    await processAngelPayWebhook({
      payload: f.eventoAngelPay(A, { terminalSerial: '' }),
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })

    const visto = await consultar(A)
    // El testimonio se conserva —es de una persona y no se borra— pero viaja acompañado del aviso de que hay
    // evidencia que impide usarlo para liberar.
    expect((visto!.attempt as { resolution?: unknown }).resolution).toMatchObject({ kind: 'NO_INSTRUMENT_PRESENTED' })
    expect((visto!.attempt as { unattributedEvidence?: boolean }).unattributedEvidence).toBe(true)
  })

  it('🔴 r4-4 · un RECHAZO huérfano no bloquea: sólo veta la evidencia que de verdad podría ser dinero', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    // Un evento sin serial y sin vínculo, pero DECLINADO: no puede ser dinero de nadie, y el propio POST lo deja
    // declarar. Contarlo dejaba `unattributedEvidence` encendido para siempre y la terminal sin poder soltar la venta.
    await processAngelPayWebhook({
      payload: f.eventoAngelPay(A, { terminalSerial: '', status: 'declined', description: 'DECLINADA' }),
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })

    await declarar(A) // el POST lo acepta…
    const visto = await consultar(A)
    expect((visto!.attempt as { unattributedEvidence?: boolean }).unattributedEvidence).toBe(false) // …y se puede usar
  })

  it('CONTROL · sin ese evento huérfano, la declaración se publica limpia', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await declarar(A)

    const visto = await consultar(A)
    expect((visto!.attempt as { unattributedEvidence?: boolean }).unattributedEvidence).toBe(false)
  })

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // 5ª pasada de Codex: los cuatro P1 son la MISMA familia — hay DOS definiciones de «¿existe dinero
  // de este intento?», la del POST y la de S6, y no se comparten. Estas pruebas fijan la regla ÚNICA.
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('🔴 r5-1 · el camino CON SOLICITUD también veta una llave sucia (no sólo el local)', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    const req = await f.solicitud()
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
    })
    // Un pago de ESE intento, con la llave guardada sin recortar y SIN puntero a la solicitud: la búsqueda
    // inicial del camino con solicitud comparaba la llave EXACTA y no lo veía.
    await recordFastPayment(f.venueId, { ...f.registroDeLaTerminal({ attemptId: A }), idempotencyKey: `\t${A}\n` }, f.staffId)

    await expect(declarar(A, { requestId: req.requestId })).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    const link = await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId: A } })
    expect(link!.operatorResolution).toBeNull()
  })

  it('🔴 r5-2 · evidencia del banco recibida por OTRO negocio también contradice', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await declarar(A)
    // El `approved` llega por el merchant de otro venue y sin Payment. El POST lo trata como veto de
    // procedencia; S6 lo eliminaba con su filtro de venue ANTES de calcular cualquier aviso.
    await prisma.providerEventLog.create({
      data: {
        // El prefijo `angelpay-` es lo que el receptor real escribe; sin él S6 ni lo mira.
        provider: 'PAYMENT_PROCESSOR', eventId: `angelpay-ajeno-${randomUUID()}`, attemptId: A,
        venueId: await venueHermano(), payload: { payload: { status: 'approved', terminalSerial: f.serialCrudo } },
        status: 'PROCESSED',
      },
    })

    const visto = await consultar(A)
    const att = visto!.attempt as { unattributedEvidence?: boolean; evidenceContradiction?: boolean }
    expect(att.unattributedEvidence === true || att.evidenceContradiction === true).toBe(true)
  })

  it('🔴 r5-3 · un Payment PENDIENTE de este intento no deja una declaración «limpia»', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    await declarar(A)
    // Un pago atribuible con estado PENDING: el POST lo vetaría; S6 lo publicaba con los avisos apagados
    // y el cliente, que sólo mira `acreditaDinero`, liberaba.
    const orden = await f.nuevaVenta()
    await prisma.payment.create({
      data: {
        venueId: f.venueId, orderId: orden.id, amount: 50, method: 'CREDIT_CARD', status: 'PENDING',
        feePercentage: 0, feeAmount: 0, netAmount: 50, idempotencyKey: A,
      },
    })

    const visto = await consultar(A)
    const att = visto!.attempt as { paymentContradiction?: boolean; paymentStatus?: string | null }
    // O lo declara contradicción, o publica el estado del pago — lo que NO puede es quedar todo apagado.
    expect(att.paymentContradiction === true || att.paymentStatus === 'PENDING').toBe(true)
  })

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Pieza D (hallazgo del QA en hardware, 22-sep): la terminal mostraba desde hacía 25 h «quedó un
  // cobro de $50 sin confirmar» sobre una solicitud que el SERVIDOR ya había resuelto. Su bandeja
  // seguía en PROCESSING, la libreta no tenía ningún intento de esa solicitud, y nada la alcanzaba:
  // la recuperación consulta por INTENTO y esa fila no tiene intento. El cajero no podía quitarlo.
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('🔴 D1 · la terminal puede consultar el estado de UNA SOLICITUD suya (aunque no tenga intento)', async () => {
    const req = await f.solicitud({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' })

    const visto = await terminalPaymentService.consultarSolicitudDeTerminal({
      requestId: req.requestId, venueId: f.venueId, terminalSerial: f.serial,
    })
    expect(visto).not.toBeNull()
    expect(visto!.request.status).toBe('FAILED')
    expect(visto!.request.failureCode).toBe('OPERATOR_RECONCILED_NO_CHARGE')
    // Lo que la terminal necesita para cerrar su bandeja: ¿está resuelta de verdad?
    expect(visto!.resuelta).toBe(true)
  })

  it('🔴 D2 · una solicitud EN VUELO no se reporta como resuelta', async () => {
    const req = await f.solicitud({ status: 'SENT' })

    const visto = await terminalPaymentService.consultarSolicitudDeTerminal({
      requestId: req.requestId, venueId: f.venueId, terminalSerial: f.serial,
    })
    expect(visto!.resuelta).toBe(false)
  })

  it('🔴 D3 · AISLAMIENTO · la solicitud de OTRA terminal no se ve', async () => {
    const req = await f.solicitud({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    const otroSerial = `AVQD-N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
    await prisma.terminal.create({ data: { venueId: f.venueId, name: 'otra', serialNumber: otroSerial, type: 'TPV_ANDROID' } })

    const visto = await terminalPaymentService.consultarSolicitudDeTerminal({
      requestId: req.requestId, venueId: f.venueId, terminalSerial: otroSerial,
    })
    expect(visto).toBeNull()
  })

  it('🔴 r5-6 · el POST no acepta una declaración que la consulta va a inutilizar', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    // Evento del mismo negocio, sin serial y sin vínculo, con estado INVÁLIDO: el POST lo aceptaba porque no es
    // aprobación ni contradicción de procedencia, y S6 lo contaba en `sinDueno` ⇒ la declaración quedaba guardada e
    // INSERVIBLE al instante. Aceptar y poder usar tienen que decir lo mismo.
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR', eventId: `angelpay-inval-${randomUUID()}`, attemptId: A,
        venueId: f.venueId, payload: { payload: { status: null } }, status: 'PROCESSED',
      },
    })

    await expect(declarar(A)).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect(await prisma.terminalAttemptResolution.findUnique({ where: { attemptId: A } })).toBeNull()
  })

  it('sin permiso y sin PIN de supervisor: 403, y nada se escribe', async () => {
    await cajeroSinPermiso()
    const A = randomUUID()
    await expect(declarar(A)).rejects.toMatchObject({ code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' })
    expect(await prisma.terminalAttemptResolution.findUnique({ where: { attemptId: A } })).toBeNull()
  })
})
