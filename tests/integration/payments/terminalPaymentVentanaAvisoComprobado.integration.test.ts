/**
 * A8 · la VENTANA DE CONFIRMACIÓN de 30 s sólo dice «no se cobró» donde el aviso del banco está COMPROBADO (founder, 21-oct-2026,
 * tablero D2 → «A») — contra Postgres REAL, en la base desechable.
 *
 * Un negativo de la TPV sin respuesta del banco (U100/U101/«Cancelled»/G505…) espera 30 s el aviso de AngelPay. Al vencer:
 *  · si TODAS las cuentas con las que pudo cobrar la terminal (el universo de `getVisibleMerchants`: las asignadas a la terminal o,
 *    sin asignadas, las del negocio) tienen el aviso comprobado, el silencio es evidencia: `FAILED / NO_EVIDENCE_AFTER_WINDOW`,
 *    igual que hoy (Testarudo);
 *  · si no —conjunto vacío, terminal desconocida, una cuenta que no es de AngelPay, una sin aviso, un canal que acaba de fallar o
 *    un cobro reciente sin su aviso—, se suelta SÓLO LA RANURA como A4b (`TIMED_OUT / AUTO_RELEASED`) con el asiento
 *    `TERMINAL_PAYMENT_SLOT_RELEASED_WEBHOOK_NOT_PROVEN`: la VENTA queda en duda hasta que una persona declare (E2) o el banco la
 *    concilie. Nunca un negativo financiero por silencio.
 */
import { randomUUID } from 'crypto'
import cuid from 'cuid'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { candadoDeSolicitud } from '@/services/tpv/candadoDeIntento'
import logger from '@/config/logger'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { _olvidarTodoParaPruebas, registrarAvisoNoGuardado } from '@/services/tpv/avisosNoGuardados'
import {
  bloqueaLaRanura,
  desenlaceCanonico,
  terminalPaymentService,
  UNPROVEN_NEGATIVE_WINDOW_MS,
} from '@/services/terminal-payment.service'
import { reconcileUncharged } from '@/services/tpv/uncharged-reconciliation.service'
import { TerminalPaymentWatchdogJob } from '@/jobs/terminal-payment-watchdog.job'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { utcTs } from '@/utils/sqlDates'
import { crearFixture, exigirBaseDesechable, exigir, type Fixture } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const svc = terminalPaymentService as any
/** El asiento nuevo: la ventana soltó SÓLO la ranura porque el aviso del banco no está comprobado. */
const RANURA_SIN_AVISO = 'TERMINAL_PAYMENT_SLOT_RELEASED_WEBHOOK_NOT_PROVEN'
/** El asiento del negativo financiero de la ventana («no se cobró»): sólo con el aviso comprobado. */
const NEGATIVO_DE_LA_VENTANA = 'TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW'
const ESTRICTO_DESDE_SIEMPRE = (venueId: string) => new Map([[venueId, new Date(0)]])
let f: Fixture

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('ventaviso')
})

/** Los temporizadores de 30 s de la ventana capturados (el de verdad se programa a 24 h: nunca dispara en la prueba). */
type Programado = { fn: () => unknown; handle: NodeJS.Timeout }
let programados: Programado[] = []
let espia: jest.SpyInstance
const setTimeoutReal = global.setTimeout

beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
  programados = []
  espia = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => unknown, ms?: number, ...args: unknown[]) => {
    if (ms === UNPROVEN_NEGATIVE_WINDOW_MS) {
      const handle = setTimeoutReal(() => undefined, 86_400_000)
      programados.push({ fn: fn as () => unknown, handle })
      return handle
    }
    return setTimeoutReal(fn, ms, ...args)
  }) as unknown as typeof setTimeout)
})
afterEach(async () => {
  espia.mockRestore()
  await _olvidarTodoParaPruebas()
  for (const p of programados) clearTimeout(p.handle)
  for (const mapa of ['ventanasProgramadas', 'liberacionesTrasCierre'] as const) {
    const m = svc[mapa] as Map<string, NodeJS.Timeout> | undefined
    for (const t of m?.values() ?? []) clearTimeout(t)
    m?.clear()
  }
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await prisma.venuePaymentConfig.deleteMany({ where: { venueId: f.venueId } })
  await prisma.terminal.update({ where: { serialNumber: f.serial }, data: { assignedMerchantIds: [] } })
  await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { angelpayWebhookLastReceivedAt: null, active: true } })
  await f.limpiar()
})
afterAll(() => f.destruir())

const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const asientos = (entityId: string, action = RANURA_SIN_AVISO) =>
  prisma.activityLog.findMany({ where: { venueId: f.venueId, action, entityId } })
const ocupada = (llave = f.llaveTerminal) => terminalPaymentService.isTerminalBusy(llave, f.venueId)
const ventaCercada = (orderId: string) => terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, orderId)
const consultar = (requestId: string) => terminalPaymentService.getPaymentStatus(requestId, f.venueId)
const ventana = (requestId: string, origen: 'TIMER' | 'WATCHDOG' = 'WATCHDOG') =>
  terminalPaymentService.releaseUnprovenNegative(requestId, f.venueId, origen) as Promise<string>
const vigia = () => new TerminalPaymentWatchdogJob().run()
const declarar = (requestId: string, actorStaffId: string) =>
  reconcileUncharged(
    { venueId: f.venueId, requestId, actorStaffId, source: 'MOBILE' },
    { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
  )
/** Sesiones de ESTA base esperando un candado consultivo de dos llaves (`hashtext`): mide que alguien ESPERA, no que decidió a ciegas. */
const esperandoCandado = async () =>
  (
    await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory' AND query ILIKE '%hashtext%'`,
    )
  )[0].n
/** Las 🚨 del log que contienen ese texto. */
const alarmas = (texto: string) =>
  (logger.error as jest.Mock).mock.calls.filter(([m]) => String(m).includes('🚨') && String(m).includes(texto))

/** Las cuentas asignadas a la terminal (`assignedMerchantIds`) y cuáles recibieron avisos (`angelpayWebhookLastReceivedAt`). */
async function cuentas(ids: string[], conAvisos: string[] = ids) {
  await prisma.terminal.update({ where: { serialNumber: f.serial }, data: { assignedMerchantIds: ids } })
  for (const id of new Set([...ids, ...conAvisos])) {
    const esAngelPay = await prisma.merchantAccount.count({ where: { id, angelpayUserAccountId: { not: null } } })
    if (!esAngelPay) continue
    await prisma.merchantAccount.update({
      where: { id },
      data: { angelpayWebhookLastReceivedAt: conAvisos.includes(id) ? new Date(Date.now() - 60_000) : null, active: true },
    })
  }
}

let avisos = 0
/**
 * Los últimos 10 cobros con tarjeta del comercio, de hace más de 60 s, cada uno CON su aviso propio (ligado al pago, del serial
 * de la terminal que cobró y recibido por ESE comercio), salvo los índices de `sinAviso`.
 */
async function diezCobrosConSuAviso(merchantAccountId: string, sinAviso: number[] = []) {
  const terminal = await prisma.terminal.findUniqueOrThrow({ where: { serialNumber: f.serial }, select: { id: true } })
  for (let i = 0; i < 10; i++) {
    const orden = await f.nuevaVenta()
    const pago = await prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId: orden.id,
        amount: 100,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
        merchantAccountId,
        terminalId: terminal.id,
        createdAt: new Date(Date.now() - 120_000 - i * 1_000),
      },
    })
    if (sinAviso.includes(i)) continue
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${f.fixture}-cobro-${++avisos}`,
        paymentId: pago.id,
        venueId: f.venueId,
        payload: {
          payload: { status: 'approved', terminalSerial: f.serialCrudo },
          _avoqado: { receivedByMerchantAccountId: merchantAccountId },
        },
        status: 'PROCESSED',
      },
    })
  }
}

/** Una entrega DURABLE tal como la graba el servidor. */
const entrega = () => ({
  protocol: 'DURABLE',
  ackVersion: 1,
  cancelDispositionVersion: 1,
  probeVersion: 1,
  socketId: 'socket-de-la-terminal',
  at: new Date().toISOString(),
  replay: false,
})

/**
 * Una solicitud del POS que ENTRÓ a la ventana hace 31 s: la terminal contestó «cancelado» sin respuesta del banco (exactamente el
 * sobre que deja `closeRow`), con su orden y su intento vinculado.
 */
async function enLaVentana(over: Record<string, unknown> = {}) {
  const venta = await f.nuevaVenta(100)
  const terminalId = (over.terminalId as string | undefined) ?? f.llaveTerminal
  const solicitud = await f.solicitud({
    orderId: venta.id,
    status: 'TIMED_OUT',
    failureCode: null,
    acknowledgedAt: new Date(),
    expiresAt: new Date(Date.now() - 60_000),
    deliveryProvenance: { deliveries: [entrega()] },
    resultJson: {
      requestId: 'x',
      status: 'timeout',
      errorMessage: 'El resultado del cobro sigue pendiente de confirmar',
      terminalResult: {
        status: 'failed',
        errorMessage: 'User cancelled\n\nSDK U100: Operacion cancelada por el usuario',
        outcomeEvidence: null,
      },
    },
    ...over,
  })
  const attemptId = randomUUID()
  await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: solicitud.requestId, venueId: f.venueId, terminalId } })
  await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = ${utcTs(new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000))} WHERE "id" = ${solicitud.id}`
  return { solicitud, venta, attemptId }
}

/** «No se cobró» por el silencio del banco: la ventana con el aviso comprobado (lo de hoy, Testarudo). */
async function negativoFinanciero(requestId: string, orderId: string) {
  const r = await fila(requestId)
  expect(r).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW', paymentId: null })
  expect(desenlaceCanonico(r)).toMatchObject({ outcome: 'NOT_CHARGED', outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW' })
  expect(await ventaCercada(orderId)).toBe(false)
  expect(await asientos(r.id, NEGATIVO_DE_LA_VENTANA)).toHaveLength(1)
  expect(await asientos(r.id)).toHaveLength(0)
  return r
}

/**
 * Sin el aviso comprobado: la RANURA libre (en los dos regímenes), la VENTA en duda y cercada, ningún «no se cobró» (ni el código,
 * ni el asiento, ni el texto) y UN asiento de la ranura soltada con las cuentas medidas y el MOTIVO por el que falló cerrado.
 */
async function soloLaRanura(
  requestId: string,
  orderId: string,
  cuentasMedidas: Record<string, boolean | null>,
  motivo: 'TERMINAL_NOT_FOUND' | 'UNREADABLE' | 'EMPTY_SET' | 'ACCOUNT_NOT_FOUND' | 'NOT_ANGELPAY' | 'WEBHOOK_NOT_PROVEN',
  origen = 'WATCHDOG',
) {
  const r = await fila(requestId)
  expect(r).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', paymentId: null })
  expect(bloqueaLaRanura(r, new Map())).toBe(false)
  expect(bloqueaLaRanura(r, ESTRICTO_DESDE_SIEMPRE(f.venueId))).toBe(false)
  expect(desenlaceCanonico(r).outcome).toBe('UNRESOLVED')
  expect(await ventaCercada(orderId)).toBe(true)
  const estado = await consultar(requestId)
  expect(estado).toMatchObject({ status: 'TIMED_OUT', outcome: 'UNRESOLVED' })
  expect(JSON.stringify({ estado, resultJson: r.resultJson })).not.toMatch(/NO_EVIDENCE|no se cobr|volver a cobrar/i)
  expect(await asientos(r.id, NEGATIVO_DE_LA_VENTANA)).toHaveLength(0)
  const lista = await asientos(r.id)
  expect(lista).toHaveLength(1)
  expect(lista[0].data).toMatchObject({
    requestId,
    terminalId: r.terminalId,
    orderId,
    amountCents: 10000,
    windowMs: UNPROVEN_NEGATIVE_WINDOW_MS,
    origen,
    cuentas: cuentasMedidas,
    motivo,
  })
  expect(Object.keys((lista[0].data as { cuentas: Record<string, unknown> }).cuentas).sort()).toEqual(Object.keys(cuentasMedidas).sort())
  return r
}

describe('A8 · la ventana dice «no se cobró» SÓLO donde el aviso del banco está comprobado', () => {
  it('1 · una cuenta AngelPay asignada y comprobada (10 cobros con su aviso propio) ⇒ RELEASED con FAILED/NO_EVIDENCE_AFTER_WINDOW, igual que hoy', async () => {
    await cuentas([f.merchantId])
    await diezCobrosConSuAviso(f.merchantId)
    const { solicitud, venta } = await enLaVentana()
    expect(await ocupada()).toBe(true)
    expect(await ventana(solicitud.requestId)).toBe('RELEASED')
    await negativoFinanciero(solicitud.requestId, venta.id)
    expect(await ocupada()).toBe(false)
  })

  it('2 · A comprobada y B asignada a la misma terminal, activa y SIN aviso ⇒ sólo la ranura (UN asiento), la venta UNRESOLVED, el POS oye «necesita confirmación»; luego E2 se acepta', async () => {
    const b = await f.afiliacionSecundaria()
    await cuentas([f.merchantId, b.id], [f.merchantId])
    await diezCobrosConSuAviso(f.merchantId)
    const { solicitud, venta } = await enLaVentana()
    const { requestId } = solicitud
    // El POS sigue esperando en memoria (long-poll): recibe lo mismo que en A4b, nunca «no se cobró».
    const espera = {
      resolve: jest.fn(),
      reject: jest.fn(),
      timeout: setTimeoutReal(() => undefined, 1),
      requestId,
      terminalId: f.llaveTerminal,
      venueId: f.venueId,
    }
    svc.pendingPayments.set(requestId, espera)

    expect(await ventana(requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    await soloLaRanura(requestId, venta.id, { [f.merchantId]: true, [b.id]: false }, 'WEBHOOK_NOT_PROVEN')
    expect(await ocupada()).toBe(false)
    expect(espera.resolve).toHaveBeenCalledTimes(1)
    const [respuesta] = espera.resolve.mock.calls[0] as [{ status: string; errorMessage: string }]
    expect(respuesta).toEqual({
      requestId,
      status: 'timeout',
      errorMessage: expect.stringMatching(/terminal ya quedó libre.*necesita confirmación/),
    })
    expect(svc.pendingPayments.has(requestId)).toBe(false)
    // El warn: requestId, venueId, terminal y las cuentas NO comprobadas.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('webhook'),
      expect.objectContaining({ requestId, venueId: f.venueId, terminalId: f.llaveTerminal, cuentasNoComprobadas: [b.id] }),
    )

    // Otra pasada (y el job completo): nada más que hacer, ni otro asiento.
    expect(await ventana(requestId)).toBe('NOT_ELIGIBLE')
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
    expect(await asientos(solicitud.id)).toHaveLength(1)

    // E2: el cajero mira la terminal y declara «no se cobró»: se acepta y la venta se libera.
    await expect(declarar(requestId, f.staffId)).resolves.toMatchObject({ kind: 'UNCHARGED_VERIFIED' })
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' })
    expect(await ventaCercada(venta.id)).toBe(false)
  })

  it('3 · conjunto VACÍO o terminal DESCONOCIDA ⇒ no comprobado; control: sin asignadas, las del negocio (comprobadas) sí sostienen el negativo', async () => {
    // a) La terminal sin cuentas asignadas y el negocio sin cuentas en su configuración: el universo está vacío.
    await cuentas([], [f.merchantId]) // la cuenta del negocio recibe avisos, pero nadie la usa
    await diezCobrosConSuAviso(f.merchantId)
    const a = await enLaVentana()
    expect(await ventana(a.solicitud.requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    await soloLaRanura(a.solicitud.requestId, a.venta.id, {}, 'EMPTY_SET')

    // b) Control: la MISMA terminal sin asignadas, con la cuenta comprobada en la configuración del negocio ⇒ el universo es la del
    //    negocio y el silencio sí prueba (el camino de la unión de `getVisibleMerchants`).
    await prisma.venuePaymentConfig.create({ data: { venueId: f.venueId, primaryAccountId: f.merchantId } })
    const b = await enLaVentana()
    expect(await ventana(b.solicitud.requestId)).toBe('RELEASED')
    await negativoFinanciero(b.solicitud.requestId, b.venta.id)

    // c) Con la misma configuración comprobada, una fila de una terminal que NO existe en el negocio ⇒ no comprobado.
    const fantasma = `n86fantasma${randomUUID().slice(0, 6)}`
    const c = await enLaVentana({ terminalId: fantasma })
    expect(await ventana(c.solicitud.requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    await soloLaRanura(c.solicitud.requestId, c.venta.id, {}, 'TERMINAL_NOT_FOUND')
    expect(await ocupada(fantasma)).toBe(false)
  })

  it('4 · control PAX/Blumon: una cuenta que NO es de AngelPay en el conjunto exacto de la terminal ⇒ no comprobado', async () => {
    const proveedor = await prisma.paymentProvider.create({
      data: { code: `BLUMON-${f.fixture}`, name: 'Blumon de prueba', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    const pax = await prisma.merchantAccount.create({
      data: {
        providerId: proveedor.id,
        externalMerchantId: `pax-${randomUUID().slice(0, 8)}`,
        alias: 'PAX Blumon',
        credentialsEncrypted: {},
      },
    })
    try {
      await cuentas([f.merchantId, pax.id], [f.merchantId])
      await diezCobrosConSuAviso(f.merchantId)
      const { solicitud, venta } = await enLaVentana()
      expect(await ventana(solicitud.requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
      // La de Blumon nunca manda aviso: la regla la mide `null` (no es de AngelPay).
      await soloLaRanura(solicitud.requestId, venta.id, { [f.merchantId]: true, [pax.id]: null }, 'NOT_ANGELPAY')
    } finally {
      await prisma.terminal.update({ where: { serialNumber: f.serial }, data: { assignedMerchantIds: [] } })
      await prisma.merchantAccount.delete({ where: { id: pax.id } })
      await prisma.paymentProvider.delete({ where: { id: proveedor.id } })
    }
  })

  it('5 · el canal de avisos de A acaba de FALLAR (un aviso firmado que no se guardó) ⇒ no comprobado; al pasar, vuelve a sostener el negativo', async () => {
    await cuentas([f.merchantId])
    await diezCobrosConSuAviso(f.merchantId)
    registrarAvisoNoGuardado({ merchantAccountId: f.merchantId, attemptId: null, posibleDinero: false })
    const a = await enLaVentana()
    expect(await ventana(a.solicitud.requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    await soloLaRanura(a.solicitud.requestId, a.venta.id, { [f.merchantId]: false }, 'WEBHOOK_NOT_PROVEN')

    // Control: sin la falla del canal, la MISMA cuenta sostiene el negativo.
    await _olvidarTodoParaPruebas()
    const b = await enLaVentana()
    expect(await ventana(b.solicitud.requestId)).toBe('RELEASED')
    await negativoFinanciero(b.solicitud.requestId, b.venta.id)
  })

  it('6 · A comprobada salvo que UNO de sus últimos 10 cobros con tarjeta no trae su aviso ⇒ no comprobado', async () => {
    await cuentas([f.merchantId])
    await diezCobrosConSuAviso(f.merchantId, [4])
    const { solicitud, venta } = await enLaVentana()
    expect(await ventana(solicitud.requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    await soloLaRanura(solicitud.requestId, venta.id, { [f.merchantId]: false }, 'WEBHOOK_NOT_PROVEN')
  })

  it('7 · carrera: el temporizador de 30 s y el job del watchdog sobre la MISMA fila no comprobada ⇒ una sola transición y un solo asiento', async () => {
    const b = await f.afiliacionSecundaria()
    await cuentas([f.merchantId, b.id], [f.merchantId])
    const { solicitud, venta } = await enLaVentana()
    // El temporizador real de la ventana (el que programa `closeRow` al entrar), capturado.
    svc.programarLiberacionPorVentana(solicitud.requestId, f.venueId)
    expect(programados).toHaveLength(1)
    const ventanaReal = svc.releaseUnprovenNegative.bind(svc)
    const resultados: string[] = []
    const espiaVentana = jest.spyOn(svc, 'releaseUnprovenNegative').mockImplementation(async (...a: unknown[]) => {
      const r = (await ventanaReal(...a)) as string
      // El barrido es GLOBAL: sólo cuenta lo que se decidió sobre ESTA fila.
      if (a[0] === solicitud.requestId) resultados.push(`${a[2]}:${r}`)
      return r
    })
    // Para que los DOS compitan de verdad (y no gane uno antes de que el otro lea la fila), una transacción ajena sostiene el
    // candado de la solicitud hasta que los dos esperan en él; al soltarlo deciden uno detrás del otro.
    const base = await esperandoCandado()
    let soltar!: () => void
    let tomado!: () => void
    const abierta = new Promise<void>(r => (soltar = r))
    const tomada = new Promise<void>(r => (tomado = r))
    const sostiene = prisma.$transaction(
      async tx => {
        await candadoDeSolicitud(tx, solicitud.requestId)
        tomado()
        await abierta
      },
      { timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    )
    await Promise.race([tomada, sostiene])
    const job = vigia()
    await programados[0].fn() // el callback del temporizador no espera su promesa (`void`)
    try {
      expect(await f.esperar(async () => (await esperandoCandado()) >= base + 2, 6_000)).toBe(true)
    } finally {
      soltar()
      await sostiene
    }
    await job
    for (let i = 0; i < 100 && resultados.length < 2; i++) await new Promise(r => setTimeoutReal(r, 20))
    espiaVentana.mockRestore()
    expect(resultados.sort()).toEqual(expect.arrayContaining([expect.stringMatching(/^TIMER:/), expect.stringMatching(/^WATCHDOG:/)]))
    expect(resultados.filter(r => r.endsWith(':SLOT_RELEASED_UNPROVEN_WEBHOOK'))).toHaveLength(1)
    expect(resultados.filter(r => !r.endsWith(':SLOT_RELEASED_UNPROVEN_WEBHOOK'))).toEqual([expect.stringMatching(/:NOT_ELIGIBLE$/)])
    const origen = resultados.find(r => r.endsWith(':SLOT_RELEASED_UNPROVEN_WEBHOOK'))!.split(':')[0]
    await soloLaRanura(solicitud.requestId, venta.id, { [f.merchantId]: true, [b.id]: false }, 'WEBHOOK_NOT_PROVEN', origen)
  })

  it('8 · aprobado TARDÍO tras soltar la ranura por aviso no comprobado — por REST y por webhook ⇒ COMPLETED + 🚨, un solo Payment', async () => {
    const b = await f.afiliacionSecundaria()
    await cuentas([f.merchantId, b.id], [f.merchantId])

    // a) Llega el registro REST de la terminal.
    const uno = await enLaVentana()
    expect(await ventana(uno.solicitud.requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    const pago = await recordOrderPayment(
      f.venueId,
      uno.venta.id,
      f.registroDeLaTerminal({ attemptId: uno.attemptId, requestId: uno.solicitud.requestId }),
      f.staffId,
    )
    const filaUno = await fila(uno.solicitud.requestId)
    expect(filaUno).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, lateResult: true })
    expect(desenlaceCanonico(filaUno).outcome).toBe('CHARGED')
    const cobrosUno = await prisma.payment.findMany({ where: { venueId: f.venueId, orderId: uno.venta.id, status: 'COMPLETED' } })
    expect(cobrosUno.map(p => p.id)).toEqual([pago.id])
    expect(alarmas('already-TIMED_OUT')).toEqual([[expect.any(String), expect.objectContaining({ requestId: uno.solicitud.requestId })]])

    // b) Llega el aviso APROBADO del banco.
    ;(logger.error as jest.Mock).mockClear()
    const dos = await enLaVentana()
    expect(await ventana(dos.solicitud.requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    expect(
      await processAngelPayWebhook({
        payload: f.eventoAngelPay(dos.attemptId),
        eventId: f.nuevoEventId(),
        merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
        retryDelaysMs: [0],
      }),
    ).toMatchObject({ action: 'CONFIRMED' })
    const filaDos = await fila(dos.solicitud.requestId)
    expect(filaDos).toMatchObject({ status: 'COMPLETED', lateResult: true })
    expect(desenlaceCanonico(filaDos).outcome).toBe('CHARGED')
    const cobrosDos = await prisma.payment.findMany({ where: { venueId: f.venueId, orderId: dos.venta.id, status: 'COMPLETED' } })
    expect(cobrosDos.map(p => p.id)).toEqual([filaDos.paymentId])
    expect(await ventaCercada(dos.venta.id)).toBe(false)
    expect(alarmas('already-TIMED_OUT')).toEqual([[expect.any(String), expect.objectContaining({ requestId: dos.solicitud.requestId })]])
  })
  it('9 · rama EXACTA sin filtro de activas: A comprobada + B AngelPay INACTIVA asignadas ⇒ sólo la ranura (B=false); un id asignado que ya no existe ⇒ sólo la ranura (null); control: la UNIÓN del negocio conserva el filtro de activas', async () => {
    // a) B, de AngelPay, la desactivaron poco antes del cobro pero sigue en la caché de la TPV y pudo cobrar. Recibe avisos: lo
    //    único que la tumba es estar inactiva (`avisoDelBancoComprobado` exige cuenta activa).
    const b = await f.afiliacionSecundaria()
    await cuentas([f.merchantId, b.id], [f.merchantId, b.id])
    await prisma.merchantAccount.update({ where: { id: b.id }, data: { active: false } })
    await diezCobrosConSuAviso(f.merchantId)
    const a = await enLaVentana()
    expect(await ventana(a.solicitud.requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    await soloLaRanura(a.solicitud.requestId, a.venta.id, { [f.merchantId]: true, [b.id]: false }, 'WEBHOOK_NOT_PROVEN')

    // b) Un id asignado que ya no existe (`assignedMerchantIds` no tiene llave foránea): falla cerrado, nunca se ignora en silencio.
    const colgado = cuid()
    await cuentas([f.merchantId, colgado], [f.merchantId])
    const c = await enLaVentana()
    expect(await ventana(c.solicitud.requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    await soloLaRanura(c.solicitud.requestId, c.venta.id, { [f.merchantId]: true, [colgado]: null }, 'ACCOUNT_NOT_FOUND')

    // c) Control: la terminal SIN asignadas ⇒ la unión del negocio, que SÍ conserva el filtro de activas: la B inactiva que sigue
    //    en la configuración no apaga la ventana para siempre (una cuenta retirada del negocio).
    await cuentas([], [f.merchantId])
    await prisma.venuePaymentConfig.create({ data: { venueId: f.venueId, primaryAccountId: f.merchantId, secondaryAccountId: b.id } })
    const d = await enLaVentana()
    expect(await ventana(d.solicitud.requestId)).toBe('RELEASED')
    await negativoFinanciero(d.solicitud.requestId, d.venta.id)
  })

  // Codex, versiones viejas (3-nov): la TPV publicada contesta ACTIVE mientras su intento siga en duda, espera NOT_CHARGED para
  // soltarlo y no sabe certificar el cese. Sin esta salida, esa venta no se podía declarar nunca.
  it('10 · TPV publicada: su ACTIVE tras soltar sólo la ranura no le quita la salida a la persona; la TPV que sí certifica sigue vetando', async () => {
    await cuentas([f.merchantId], [])
    const terminal = { socketId: 'socket-de-la-terminal', terminalId: f.llaveTerminal, venueId: f.venueId }

    const vieja = await enLaVentana()
    expect(await ventana(vieja.solicitud.requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    expect(await svc.handleProbeResultFromSocket({ requestId: vieja.solicitud.requestId, disposition: 'ACTIVE' }, terminal)).toBe(true)
    const conActive = await fila(vieja.solicitud.requestId)
    expect(conActive.probeActiveAt).not.toBeNull()
    expect(conActive.status).toBe('TIMED_OUT')

    await declarar(vieja.solicitud.requestId, f.staffId)

    const declarada = await fila(vieja.solicitud.requestId)
    expect(declarada.status).toBe('FAILED')
    expect(declarada.failureCode).toBe('OPERATOR_RECONCILED_NO_CHARGE')
    // Lo que la TPV vieja lee para soltar su intento.
    expect(await consultar(vieja.solicitud.requestId)).toMatchObject({ outcome: 'NOT_CHARGED', outcomeEvidence: 'OPERATOR_RECONCILED' })
    const [asiento] = await asientos(declarada.id, 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED')
    expect(asiento.data).toMatchObject({ terminalReportabaActiva: true })

    const nueva = await enLaVentana({ deliveryProvenance: { deliveries: [{ ...entrega(), executionVersion: 1 }] } })
    expect(await ventana(nueva.solicitud.requestId)).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    expect(await svc.handleProbeResultFromSocket({ requestId: nueva.solicitud.requestId, disposition: 'ACTIVE' }, terminal)).toBe(true)
    await expect(declarar(nueva.solicitud.requestId, f.staffId)).rejects.toMatchObject({ code: 'EXECUTION_STILL_ACTIVE' })
  })
})
