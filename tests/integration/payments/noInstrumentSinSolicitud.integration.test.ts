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
import { hayDineroConEstaLlaveSql, sinDineroConEstaLlaveSql } from '@/services/tpv/evidenciaPositivaSql'
import { PATRON_SQL_TRIM_COMO_JS } from '@/utils/terminalSerial'
import { readFile } from 'fs/promises'
import { resolve } from 'path'

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
      venueId: hermano,
      orderNumber: `h-${randomUUID().slice(0, 8)}`,
      type: 'TAKEOUT',
      source: 'TPV',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      createdById: f.staffId,
    },
  })
  return prisma.payment.create({
    data: {
      venueId: hermano,
      orderId: orden.id,
      amount: 100,
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
      idempotencyKey: attemptId,
    },
  })
}

/** Otra persona del MISMO venue, con PIN y con el permiso: es quien puede ELEVAR a un cajero que no lo tiene. */
async function supervisorConPin() {
  const pin = '4821'
  const staff = await prisma.staff.create({
    data: {
      firstName: 'Supervisora',
      lastName: 'Test',
      email: `${f.fixture}-sup-${randomUUID().slice(0, 6)}@example.test`,
      active: true,
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

/**
 * Codex r7 (P1-3): intercepta la SIGUIENTE `prisma.$transaction` (la de la declaración) y, justo DESPUÉS de la consulta cuyo
 * SQL —incluidos sus fragmentos anidados— contenga `marcador`, ejecuta `entre` POR FUERA (autocommit): es el hueco exacto
 * «entre la comprobación previa y el CAS» de un escritor que no toma el candado del intento (el fallback del webhook cuya
 * espera venció). Mismo patrón que `terminalPaymentWindow.integration.test.ts`; aquí mira también los `Prisma.Sql` anidados,
 * porque la consulta del veto es un fragmento compartido.
 */
const interceptarSiguienteTx = (marcador: string, entre: () => Promise<void>) => {
  const original = prisma.$transaction.bind(prisma)
  let hecho = false
  return jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: any, opts: any) =>
    original(async (tx: any) => {
      const envuelto = new Proxy(tx, {
        get(target, prop) {
          const v = (target as any)[prop]
          if (prop !== '$queryRaw') return typeof v === 'function' ? v.bind(target) : v
          return async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const r = await target.$queryRaw(strings, ...values)
            const texto = [...(Array.isArray(strings) ? strings : []), ...values.map(x => (x as { sql?: string })?.sql ?? '')].join(' ')
            if (!hecho && texto.includes(marcador)) {
              hecho = true
              await entre()
            }
            return r
          }
        },
      })
      return fn(envuelto)
    }, opts)) as any)
}

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
    await declarar(A) // declaración LOCAL: no había vínculo

    // Ahora llega la solicitud del POS y se vincula ese mismo intento.
    const req = await f.solicitud()
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
    })

    // Declarar otra vez ya NO es un camino nuevo: el testimonio local existe y manda.
    await expect(declarar(A)).rejects.toMatchObject({ code: 'RESOLUTION_CONFLICT' })
    const link = await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId: A } })
    expect(link!.operatorResolution).toBeNull() // ni un segundo testimonio en la otra tabla
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

  it('🔴 r6 P2-10 · el patrón del ÍNDICE es byte a byte el de la aplicación, y el índice se USA', async () => {
    // Codex: son regex equivalentes pero CONSTANTES distintas, y PostgreSQL decide si un predicado puede usar un
    // índice funcional comparando la EXPRESIÓN de forma ESTRUCTURAL. Si se separan, el índice existe y la consulta no
    // lo usa — y esta búsqueda corre en el sondeo interactivo cada 5 s, no sólo al declarar.
    const sql = await readFile(
      resolve(__dirname, '../../../prisma/migrations/20260922180000_payment_idempotency_key_trimmed_idx/migration.sql'),
      'utf8',
    )
    const patrones = [...sql.matchAll(/'(\^\[[^']*)'/g)].map(m => m[1])
    expect(patrones.length).toBeGreaterThan(0)
    for (const p of patrones) expect(p).toBe(PATRON_SQL_TRIM_COMO_JS)

    // Y que de verdad se elija como BÚSQUEDA (`Index Cond`), no como recorrido con filtro encima. `SET LOCAL` sólo
    // vale DENTRO de una transacción, y sin apagar el seq scan una tabla pequeña nunca elige el índice — lo que se
    // comprueba aquí es que el índice sea ELEGIBLE para este predicado, no qué decide el planificador con 40 filas.
    const plan = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN (COSTS OFF) SELECT "id" FROM "Payment" WHERE "idempotencyKey" IS NOT NULL AND regexp_replace("idempotencyKey", $1, '', 'g') = $2`,
        PATRON_SQL_TRIM_COMO_JS,
        'llave-que-no-existe',
      )
    })
    const texto = plan.map(l => l['QUERY PLAN']).join('\n')
    expect(texto).toContain('Payment_idempotencyKey_trimmed_idx')
    expect(texto).toContain('Index Cond')
  })

  it('🔴 r6 P2-10b · la regla de dinero ENTERA es una búsqueda por índice — ninguna rama recorre la tabla', async () => {
    // La prueba de arriba mide una consulta escrita a mano; ésta mide el FRAGMENTO que de verdad usan el POST y el CAS.
    // Medido: con dos ramas (`llave = X` UNION `recorte(llave) = X`) la exacta no tenía índice que la sirviera —el
    // único con la llave empieza por `venueId`— y salía `Filter`: un recorrido de la tabla de pagos cada 5 s del sondeo.
    const plan = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
      return tx.$queryRaw<{ 'QUERY PLAN': string }[]>`EXPLAIN (COSTS OFF) SELECT ${hayDineroConEstaLlaveSql(randomUUID())}`
    })
    const texto = plan.map(l => l['QUERY PLAN']).join('\n')
    expect(texto).toContain('Index Cond')
    // Ninguna rama puede filtrar la llave sin índice.
    expect(texto).not.toMatch(/Filter: \(\("idempotencyKey"\)::text = /)
  })

  it('🔴 r6 P2-10c · y la regla sigue viendo una llave guardada con espacios, y una llave limpia', async () => {
    // Quitar la rama exacta no puede perder ningún cobro: si la llave ES el intento, su recorte también lo es.
    await cajeroConPermiso()
    const limpia = randomUUID()
    const sucia = randomUUID()
    const orden = await f.nuevaVenta()
    for (const llave of [limpia, `\t${sucia} `]) {
      await prisma.payment.create({
        data: {
          venueId: f.venueId, orderId: orden.id, amount: 1, method: 'CREDIT_CARD', status: 'COMPLETED',
          feePercentage: 0, feeAmount: 0, netAmount: 1, idempotencyKey: llave,
        },
      })
    }
    for (const intento of [limpia, sucia]) {
      const [{ hay }] = await prisma.$queryRaw<{ hay: boolean }[]>`SELECT ${hayDineroConEstaLlaveSql(intento)} AS "hay"`
      expect(hay).toBe(true)
    }
  })

  it('🔴 r6 P2-6 · una declaración LOCAL previa sigue publicándose si el vínculo aparece DESPUÉS', async () => {
    // El POS reclama esa venta más tarde y crea el vínculo. S6, al ver vínculo, omitía la tabla local y devolvía
    // `resolution:null`: el testimonio quedaba escrito pero irrecuperable por consulta.
    await cajeroConPermiso()
    const A = randomUUID()
    await declarar(A)                                    // declaración LOCAL, sin solicitud
    const req = await f.solicitud()
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
    })

    const visto = await consultar(A)
    const decl = (visto!.attempt as { resolution?: { kind?: string } | null }).resolution
    expect(decl?.kind).toBe('NO_INSTRUMENT_PRESENTED')
  })

  it('🔴 r6 P2-7 · la pieza D NO dice «resuelta» con una aprobación conocida pendiente de conciliar', async () => {
    // `UNRESOLVED_FINANCIAL_OUTCOME` clasifica la FILA de solicitud: no mira Payments ni eventos. Una solicitud ya
    // liberada a la que después entra una aprobación durable salía `resuelta:true`, y la terminal apagaba su último
    // aviso sobre dinero que S6 sí ve.
    const req = await f.solicitud()
    const A = randomUUID()
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
    })
    await prisma.terminalPaymentRequest.update({
      where: { id: req.id },
      data: { status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' },
    })
    const antes = await terminalPaymentService.consultarSolicitudDeTerminal({
      requestId: req.requestId, venueId: f.venueId, terminalSerial: f.serialCrudo,
    })
    expect(antes!.resuelta).toBe(true)   // control positivo: liberada y sin evidencia ⇒ resuelta

    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR', eventId: `angelpay-tardio-${randomUUID()}`, attemptId: A,
        venueId: f.venueId, type: 'send_transaction',
        payload: { payload: { status: 'approved', terminalSerial: f.serialCrudo } }, status: 'PROCESSED',
      },
    })

    const despues = await terminalPaymentService.consultarSolicitudDeTerminal({
      requestId: req.requestId, venueId: f.venueId, terminalSerial: f.serialCrudo,
    })
    expect(despues!.resuelta).toBe(false)
  })

  it('🔴 r6 P1-1 · la ESCRITURA con solicitud rechaza el dinero que la comprobación previa veta', async () => {
    // El hueco medido por Codex: la comprobación previa acaba, el fallback del webhook —que NO toma el candado consultivo
    // del intento— persiste el cobro, y el CAS lo ignoraba porque su `NOT EXISTS` cuelga de la SOLICITUD (venue propio,
    // `send_transaction`, COMPLETED) y no de la LLAVE DEL INTENTO. Aquí se comprueba la condición del propio UPDATE:
    // con dinero de ese intento tiene que dar 0 filas, sea cual sea la forma en que ese dinero esté guardado.
    await cajeroConPermiso()
    const A = randomUUID()
    const orden = await f.nuevaVenta()
    const ajeno = await venueHermano()
    // Las tres formas que la regla de la solicitud NO ve: llave sin recortar · otro negocio · estado PENDING.
    await prisma.payment.create({
      data: {
        venueId: ajeno, orderId: orden.id, amount: 50, method: 'CREDIT_CARD', status: 'PENDING',
        feePercentage: 0, feeAmount: 0, netAmount: 50, idempotencyKey: `\t${A}\n`,
      },
    })

    const [{ sinDinero }] = await prisma.$queryRaw<{ sinDinero: boolean }[]>`
      SELECT ${sinDineroConEstaLlaveSql(A)} AS "sinDinero"`
    expect(sinDinero).toBe(false)
  })

  it('🔴 r6 P1-1b · y sin ese cobro la condición deja pasar (control positivo)', async () => {
    const [{ sinDinero }] = await prisma.$queryRaw<{ sinDinero: boolean }[]>`
      SELECT ${sinDineroConEstaLlaveSql(randomUUID())} AS "sinDinero"`
    expect(sinDinero).toBe(true)
  })

  it('🔴 r6 P1-1c · el UPDATE de la declaración CON solicitud lleva esa condición', async () => {
    // Estructural a propósito: la condición vive DENTRO del UPDATE, y un `NOT EXISTS` que no se puede observar desde fuera
    // de una carrera real se fija aquí. Si alguien la saca del CAS, esta prueba cae aunque el camino feliz siga verde.
    const fuente = await readFile(resolve(__dirname, '../../../src/services/tpv/no-instrument-resolution.service.ts'), 'utf8')
    const update = fuente.slice(fuente.indexOf('UPDATE "TerminalPaymentRequest"'))
    expect(update.slice(0, update.indexOf('`'))).toContain('sinDineroConEstaLlaveSql(attemptId)')
  })

  it('🔴 r7 P1-3 · el CAS con solicitud revalida la regla ENTERA de eventos: un aprobado bajo OTRO negocio que entra entre la comprobación y la escritura la deja en 0', async () => {
    // El escenario de Codex, intercalado de verdad (no un SELECT del fragmento): termina la comprobación previa; el fallback
    // persiste un APROBADO de este intento recibido bajo otro venue, sin Payment; después corre el CAS. Antes, el aprobado de
    // `sinEvidenciaPositivaSql` exigía venue PROPIO: nadie lo veía y se escribía «no se cobró».
    await cajeroConPermiso()
    const A = randomUUID()
    const req = await f.solicitud()
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
    })
    const ajeno = await venueHermano()
    const espia = interceptarSiguienteTx('LINK_TERMINAL_MISMATCH', async () => {
      await prisma.providerEventLog.create({
        data: {
          provider: 'PAYMENT_PROCESSOR', eventId: `angelpay-otro-venue-${randomUUID()}`, attemptId: A,
          venueId: ajeno, type: 'send_transaction',
          payload: { payload: { status: 'approved', terminalSerial: f.serialCrudo } }, status: 'PROCESSED',
        },
      })
    })

    try {
      await expect(declarar(A, { requestId: req.requestId })).rejects.toMatchObject({ code: 'ATTEMPT_NOT_ELIGIBLE' })
    } finally {
      espia.mockRestore()
    }
    // El evento SÍ entró (no es que la intercalación no ocurriera): y es justo lo que la escritura tenía que ver.
    expect(await prisma.providerEventLog.count({ where: { attemptId: A, venueId: ajeno } })).toBe(1)
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(fila.failureCode).not.toBe('OPERATOR_RECONCILED_NO_CHARGE')
    const link = await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId: A } })
    expect(link!.operatorResolution).toBeNull()
  })

  it('🔴 r7 P1-3 · control: la MISMA intercalación sin evento deja pasar la declaración (el arnés no rompe el flujo)', async () => {
    await cajeroConPermiso()
    const A = randomUUID()
    const req = await f.solicitud()
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
    })
    let intercalado = false
    const espia = interceptarSiguienteTx('LINK_TERMINAL_MISMATCH', async () => {
      intercalado = true
    })

    try {
      await declarar(A, { requestId: req.requestId })
    } finally {
      espia.mockRestore()
    }
    expect(intercalado).toBe(true)
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(fila.failureCode).toBe('OPERATOR_RECONCILED_NO_CHARGE')
  })

  it('🔴 r8 · el CAS con solicitud revalida la LLAVE: un Payment de este intento que entra DESPUÉS de la última comprobación lo deja en 0', async () => {
    // Codex r8: «r6 P1-1», pese a su nombre, prueba un SELECT del fragmento y no el UPDATE. Aquí el Payment se intercala de
    // verdad: la consulta de eventos (`LINK_TERMINAL_MISMATCH`) es la ÚLTIMA comprobación previa —corre sólo si las de
    // Payment no encontraron nada—, así que lo que entre después de ella sólo lo puede ver el propio CAS. Las tres formas que
    // la regla de la SOLICITUD no ve: llave sin recortar, otro negocio y PENDING.
    await cajeroConPermiso()
    const A = randomUUID()
    const req = await f.solicitud()
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
    })
    const orden = await f.nuevaVenta()
    const ajeno = await venueHermano()
    const espia = interceptarSiguienteTx('LINK_TERMINAL_MISMATCH', async () => {
      await prisma.payment.create({
        data: {
          venueId: ajeno, orderId: orden.id, amount: 50, method: 'CREDIT_CARD', status: 'PENDING',
          feePercentage: 0, feeAmount: 0, netAmount: 50, idempotencyKey: `\t${A}\n`,
        },
      })
    })

    try {
      await expect(declarar(A, { requestId: req.requestId })).rejects.toMatchObject({ code: 'ATTEMPT_NOT_ELIGIBLE' })
    } finally {
      espia.mockRestore()
    }
    // El Payment SÍ entró entre la comprobación y la escritura: es justo lo que el CAS tenía que ver.
    expect(await prisma.payment.count({ where: { idempotencyKey: `\t${A}\n` } })).toBe(1)
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(fila.failureCode).not.toBe('OPERATOR_RECONCILED_NO_CHARGE')
    const link = await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId: A } })
    expect(link!.operatorResolution).toBeNull()
  })

  it('🔴 r7 P2-2 · la pieza D NO dice «resuelta» con un Payment PENDING o con la llave sucia de un intento vinculado', async () => {
    // `hayPagoLigadoSql` sólo cuenta cobros COMPLETED y la llave EXACTA: S6 y el POST sí veían estas dos formas de dinero,
    // la consulta por solicitud no, y la terminal apagaba su último aviso sobre ellas.
    const formas: Array<{ status: 'PENDING' | 'COMPLETED'; llave: (a: string) => string }> = [
      { status: 'PENDING', llave: a => a },
      { status: 'COMPLETED', llave: a => `\t${a}\n` },
    ]
    for (const forma of formas) {
      const req = await f.solicitud()
      const A = randomUUID()
      await prisma.terminalPaymentAttemptLink.create({
        data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
      })
      await prisma.terminalPaymentRequest.update({
        where: { id: req.id },
        data: { status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' },
      })
      const orden = await f.nuevaVenta()
      await prisma.payment.create({
        data: {
          venueId: f.venueId, orderId: orden.id, amount: 50, method: 'CREDIT_CARD', status: forma.status,
          feePercentage: 0, feeAmount: 0, netAmount: 50, idempotencyKey: forma.llave(A),
        },
      })
      const visto = await terminalPaymentService.consultarSolicitudDeTerminal({
        requestId: req.requestId, venueId: f.venueId, terminalSerial: f.serialCrudo,
      })
      expect({ forma: forma.status, resuelta: visto!.resuelta }).toEqual({ forma: forma.status, resuelta: false })
    }
  })

  it('🔴 r7 P2-2b · la pieza D NO dice «resuelta» con evidencia de conciliación pendiente (colisión de referencia)', async () => {
    // El Payment PENDING que el registrador deja cuando la referencia colisiona NO liga por ninguna identidad de dinero
    // (no es COMPLETED y su llave no es la del intento): sólo lo encuentra `hayEvidenciaDeConciliacionSql`.
    const req = await f.solicitud()
    const A = randomUUID()
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: req.requestId, attemptId: A, venueId: f.venueId, terminalId: f.llaveTerminal },
    })
    await prisma.terminalPaymentRequest.update({
      where: { id: req.id },
      data: { status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' },
    })
    const orden = await f.nuevaVenta()
    await prisma.payment.create({
      data: {
        venueId: f.venueId, orderId: orden.id, amount: 50, method: 'CREDIT_CARD', status: 'PENDING',
        feePercentage: 0, feeAmount: 0, netAmount: 50, idempotencyKey: `colision-${randomUUID()}`,
        terminalPaymentRequestId: req.requestId,
        processorData: { reconciliation: { kind: 'POSSIBLE_REFERENCE_COLLISION', requestId: req.requestId } },
      },
    })
    const visto = await terminalPaymentService.consultarSolicitudDeTerminal({
      requestId: req.requestId, venueId: f.venueId, terminalSerial: f.serialCrudo,
    })
    expect(visto!.resuelta).toBe(false)
  })

  it('🔴 r7 P2-3 · S6 dice lo mismo que el POST: un REFUND con la llave del intento también contradice', async () => {
    // S6 tenía su propia copia de la regla, que excluía los REFUND; el veto del POST (el fragmento único) no. Con un REFUND
    // como única fila con esa llave, el POST rechazaba la declaración y S6 la habría publicado limpia.
    const A = randomUUID()
    const orden = await f.nuevaVenta()
    await prisma.payment.create({
      data: {
        venueId: f.venueId, orderId: orden.id, amount: 50, method: 'CREDIT_CARD', status: 'COMPLETED', type: 'REFUND',
        feePercentage: 0, feeAmount: 0, netAmount: 50, idempotencyKey: A,
      },
    })
    const visto = await consultar(A)
    expect(visto!.attempt.paymentContradiction).toBe(true)
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
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-ajeno-${randomUUID()}`,
        attemptId: A,
        venueId: await venueHermano(),
        payload: { payload: { status: 'approved', terminalSerial: f.serialCrudo } },
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
    // 🔴 Codex r6 (P3-12): el pago tiene que ser ATRIBUIBLE, o la prueba pasa por el motivo equivocado. Un PENDING
    // suelto —sin terminal ni vínculo— ya enciende `paymentContradiction` por no ser de nadie, así que la aserción con
    // `OR` salía verde aunque el veto nuevo por `paymentId` no existiera. Se le pone la TERMINAL de este fixture: así
    // es dinero PROPIO de este intento, y lo único que puede publicarlo es la regla que se quiere probar.
    const orden = await f.nuevaVenta()
    const terminal = await prisma.terminal.findFirst({ where: { venueId: f.venueId }, select: { id: true } })
    await prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId: orden.id,
        amount: 50,
        method: 'CREDIT_CARD',
        status: 'PENDING',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 50,
        idempotencyKey: A,
        ...(terminal ? { terminalId: terminal.id } : {}),
      },
    })

    const visto = await consultar(A)
    const att = visto!.attempt as {
      paymentContradiction?: boolean
      paymentStatus?: string | null
      paymentId?: string | null
    }
    // Y se afirma lo CONCRETO: el pago se publica con su id y su estado. Sin el veto por `paymentId`, `acreditaDinero`
    // del cliente devolvía false y liberaba la venta.
    expect(att.paymentId).toBeTruthy()
    expect(att.paymentStatus).toBe('PENDING')
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
      requestId: req.requestId,
      venueId: f.venueId,
      terminalSerial: f.serial,
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
      requestId: req.requestId,
      venueId: f.venueId,
      terminalSerial: f.serial,
    })
    expect(visto!.resuelta).toBe(false)
  })

  it('🔴 D3 · AISLAMIENTO · la solicitud de OTRA terminal no se ve', async () => {
    const req = await f.solicitud({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    const otroSerial = `AVQD-N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
    await prisma.terminal.create({ data: { venueId: f.venueId, name: 'otra', serialNumber: otroSerial, type: 'TPV_ANDROID' } })

    const visto = await terminalPaymentService.consultarSolicitudDeTerminal({
      requestId: req.requestId,
      venueId: f.venueId,
      terminalSerial: otroSerial,
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
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-inval-${randomUUID()}`,
        attemptId: A,
        venueId: f.venueId,
        payload: { payload: { status: null } },
        status: 'PROCESSED',
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
