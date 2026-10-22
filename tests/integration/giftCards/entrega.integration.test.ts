/**
 * La entrega de tarjetas (1b S3) contra Postgres REAL: el reclamo en la fila (dos a la vez, vencido, quién es elegible), un solo
 * mensaje con dos vueltas a la vez, el aviso de fallo de Meta y de Resend en los dos órdenes (Q103, Q105) y el cruce con la
 * reposición del panel (Q38/Q43) por WhatsApp y por correo (Q46).
 *
 * 🔴 Nada sale a nadie: el envío de WhatsApp es un doble, Resend es un falso (debajo de `sendEmailWithResult`, con la llave de
 * idempotencia que recuerda) y `fetch` truena si algo intentara salir. La llave de Resend y el secreto del webhook son de prueba
 * y se regresan como estaban al terminar.
 *
 * Correr: source ~/.claude/worktrees/tarjetas-1b/urls-tarjetas-1b.sh && TZ=UTC npx jest --selectProjects=integration \
 *   --runInBand --testPathPattern "giftCards/entrega" --ci
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/whatsapp.service', () => ({
  ...jest.requireActual('@/services/whatsapp.service'),
  sendGiftCardDeliveryWhatsApp: (...args: unknown[]) => mockEnviarWhatsApp(...args),
  whatsappConfigurado: () => true,
}))
// `email.service` crea su cliente de Resend al importarse, sólo si hay llave: ésta es de prueba y el cliente, un falso.
// La llave que hubiera antes se guarda en `globalThis` (el factory corre antes que las constantes de este archivo) y se regresa al final.
jest.mock('resend', () => {
  ;(globalThis as Record<string, unknown>).__llaveDeResendAntesDeLaEntrega = process.env.RESEND_API_KEY
  process.env.RESEND_API_KEY = 're_falsa_de_pruebas'
  return { Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...args: unknown[]) => mockResendSend(...args) } })) }
})

const mockEnviarWhatsApp = jest.fn()
const mockResendSend = jest.fn()

import { createHash } from 'node:crypto'
import { Webhook } from 'svix'
import prisma from '@/utils/prismaClient'
import { operarSobreDeGerenteEnTx } from '@/services/giftCards/giftCardLedger'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { reiniciarFallosTempranosParaPruebas } from '@/services/giftCards/giftCardFallosTempranos'
import {
  type EntregaReclamada,
  RECLAMO_VENCE_MS,
  entregarTarjetas,
  marcarEntregaFallidaPorMensaje,
  reclamarEntregas,
} from '@/services/giftCards/giftCardDelivery.service'
import { processWhatsappWebhook } from '@/services/whatsappWebhook.service'
import { handleResendWebhook } from '@/controllers/webhooks/resend.webhook.controller'
import { cambiarDestinoDeTarjeta, reenviarTarjeta } from '@/services/giftCards/giftCardCuenta.service'
import { crearNegocioDePrueba, limpiarNegocioDePrueba, pidDe, sembrarVentaDeTarjetas } from './sembrarTarjetasDeRegalo'

jest.setTimeout(90000)

const SUF = `entrega-${process.pid}-${Date.now()}`
const SECRETO_DE_PRUEBA = 'whsec_' + Buffer.from('avoqado-test-secret-1234567890ab').toString('base64')
const CORREO = 'destinatario@pruebas-tarjetas.mx'
const fetchOriginal = global.fetch
const secretoOriginal = process.env.RESEND_WEBHOOK_SECRET
let negocio: Awaited<ReturnType<typeof crearNegocioDePrueba>>
let n = 0
const unico = (prefijo: string) => `${prefijo}-${SUF}-${++n}`

beforeAll(async () => {
  // Red de seguridad: si algo intentara salir (Meta, Resend o cualquier otro), la prueba truena en vez de mandar.
  global.fetch = jest.fn(async () => {
    throw new Error('🔴 prueba sin red: nada sale de aquí')
  }) as unknown as typeof global.fetch
  process.env.RESEND_WEBHOOK_SECRET = SECRETO_DE_PRUEBA
  negocio = await crearNegocioDePrueba('entrega')
})

afterAll(async () => {
  global.fetch = fetchOriginal
  if (secretoOriginal === undefined) delete process.env.RESEND_WEBHOOK_SECRET
  else process.env.RESEND_WEBHOOK_SECRET = secretoOriginal
  const llaveAntes = (globalThis as Record<string, unknown>).__llaveDeResendAntesDeLaEntrega as string | undefined
  if (llaveAntes === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = llaveAntes
  await limpiarNegocioDePrueba(negocio?.venueId)
})

beforeEach(() => {
  reiniciarFallosTempranosParaPruebas()
  mockEnviarWhatsApp.mockReset()
  mockResendSend.mockReset()
})

const porWhatsApp = { deliveryChannel: 'WHATSAPP' as const, recipientPhone: '5512345678', purchaserName: 'Luis' }
const porCorreo = { deliveryChannel: 'EMAIL' as const, recipientEmail: CORREO, recipientName: 'Ana', purchaserName: 'Luis' }

async function tarjetas(cuantas: number, entrega: Parameters<typeof sembrarVentaDeTarjetas>[0]['entrega'] = porWhatsApp) {
  const { giftCardIds } = await sembrarVentaDeTarjetas({ ...negocio, montos: Array(cuantas).fill(100), metodo: 'CASH', entrega })
  return giftCardIds
}

const fila = (id: string) => prisma.giftCard.findUniqueOrThrow({ where: { id } })
const pausa = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** ¿Hay otra sesión detenida por un candado que sostiene `pid`? (como `esperarAQueAlguienEspereA`, sin lanzar). */
async function alguienEsperaA(pid: number): Promise<boolean> {
  const filas = await prisma.$queryRaw<Array<{ pid: number }>>`
    SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid)) LIMIT 1`
  return filas.length > 0
}

/** El panel repone el código (y con él la liga) de esa tarjeta, como «Reponer código». */
async function reponer(id: string) {
  await prisma.$transaction(
    tx =>
      operarSobreDeGerenteEnTx(tx, {
        venueId: negocio.venueId,
        giftCardId: id,
        staffId: negocio.staffId,
        operationKey: unico('repone'),
        op: { tipo: 'REEMPLAZAR_CODIGO', reason: 'LOST_CARD' },
      }),
    ORDER_LOCK_WAIT_BUDGET,
  )
}

/** El aviso de Resend llega por su controlador, con la firma de svix como la manda Resend. */
async function avisoDeResend(type: string, emailId: string) {
  const payload = JSON.stringify({ type, data: { email_id: emailId, to: [CORREO], from: 'Avoqado <noreply@avoqado.io>', created_at: '' } })
  const instante = new Date()
  const req: any = {
    body: Buffer.from(payload),
    headers: {
      'svix-id': `msg_${emailId}`,
      'svix-timestamp': String(Math.floor(instante.getTime() / 1000)),
      'svix-signature': new Webhook(SECRETO_DE_PRUEBA).sign(`msg_${emailId}`, instante, payload),
    },
  }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
  await handleResendWebhook(req, res, jest.fn())
  expect(res.status).toHaveBeenCalledWith(200)
}

/** Resend falso que recuerda cada llave con su contenido: la misma llave con OTRO contenido ⇒ 409 como el de verdad. */
function resendQueRecuerdaLlaves(antesDeResponder?: (llamada: number) => Promise<void>) {
  const vistas = new Map<string, string>()
  const llamadas: Array<{ llave: string; html: string; text: string }> = []
  mockResendSend.mockImplementation(async (payload: any, opciones?: { idempotencyKey?: string }) => {
    const llave = opciones?.idempotencyKey ?? ''
    const contenido = JSON.stringify([payload.to, payload.subject, payload.html, payload.text])
    llamadas.push({ llave, html: payload.html, text: payload.text })
    if (antesDeResponder) await antesDeResponder(llamadas.length)
    if (vistas.has(llave) && vistas.get(llave) !== contenido) {
      return { data: null, error: { name: 'invalid_idempotent_request', statusCode: 409, message: 'Same key, different request' } }
    }
    vistas.set(llave, contenido)
    return { data: { id: `re_${llamadas.length}-${SUF}` }, error: null }
  })
  return llamadas
}

describe('el reclamo en la fila', () => {
  it('dos reclamos a la vez nunca toman la misma tarjeta', async () => {
    const ids = await tarjetas(6)
    const ahora = new Date()
    let reclamoB!: Promise<EntregaReclamada[]>
    let bTermino = false

    // A reclama y NO confirma; B llega mientras A sostiene las filas. B termina sola (las salta) o se queda esperando el
    // candado de A: se le da la oportunidad de las dos antes de que A confirme.
    const a = await prisma.$transaction(async tx => {
      const deA = await reclamarEntregas({ ahora, ids }, tx)
      const pidA = await pidDe(tx)
      reclamoB = reclamarEntregas({ ahora, ids })
      reclamoB.then(
        () => (bTermino = true),
        () => (bTermino = true),
      )
      for (let i = 0; i < 200 && !bTermino && !(await alguienEsperaA(pidA)); i++) await pausa(25)
      return deA
    }, ORDER_LOCK_WAIT_BUDGET)
    const b = await reclamoB

    const deA = a.map(x => x.id)
    const deB = b.map(x => x.id)
    expect([...deA, ...deB].sort()).toEqual([...ids].sort())
    expect(deA.filter(id => deB.includes(id))).toEqual([])
    for (const x of [...a, ...b]) expect(x.deliveryAttempts).toBe(1)
    const enLaBase = await prisma.giftCard.findMany({ where: { id: { in: ids } }, select: { deliveryAttempts: true }, take: ids.length })
    expect(enLaBase.map(x => x.deliveryAttempts)).toEqual([1, 1, 1, 1, 1, 1])
  })

  it('una tarjeta que otra transacción tiene tomada no se espera: se salta y se reclama en la vuelta siguiente', async () => {
    const [tomada, libre] = await tarjetas(2)
    let soltar!: () => void
    const suelta = new Promise<void>(resolve => (soltar = resolve))
    let avisar!: () => void
    const yaLaTiene = new Promise<void>(resolve => (avisar = resolve))
    // Otra transacción (otro reclamo, una reposición) sostiene el candado de la fila y no confirma todavía.
    const otra = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "GiftCard" WHERE id = ${tomada} FOR UPDATE`
        avisar()
        await suelta
      },
      { timeout: 30_000, maxWait: 5_000 },
    )
    await yaLaTiene
    let reloj: NodeJS.Timeout | undefined
    const tope = new Promise<'esperó'>(resolve => (reloj = setTimeout(() => resolve('esperó'), 5_000)))

    const r = await Promise.race([reclamarEntregas({ ahora: new Date(), ids: [tomada, libre] }), tope])
    clearTimeout(reloj)
    soltar()
    await otra

    // SKIP LOCKED: no esperó el candado ni tomó la fila ajena; la siguiente vuelta sí la toma.
    expect(r).not.toBe('esperó')
    expect((r as EntregaReclamada[]).map(x => x.id)).toEqual([libre])
    expect((await reclamarEntregas({ ahora: new Date(), ids: [tomada, libre] })).map(x => x.id)).toEqual([tomada])
  })

  it('dos entregas a la vez mandan UN mensaje', async () => {
    const [id] = await tarjetas(1)
    let soltar!: () => void
    const suelta = new Promise<void>(resolve => (soltar = resolve))
    let avisar!: () => void
    const yaEstaMandando = new Promise<void>(resolve => (avisar = resolve))
    mockEnviarWhatsApp.mockImplementation(async () => {
      avisar()
      await suelta
      return { messageId: unico('wamid.1') }
    })

    // La primera vuelta queda a media entrega (el trabajo de cada minuto) y llega la segunda (la patada de S4).
    const primera = entregarTarjetas({ ids: [id] })
    await yaEstaMandando
    const segunda = await entregarTarjetas({ ids: [id] })
    soltar()
    await primera

    expect(segunda.reclamadas).toBe(0)
    expect(mockEnviarWhatsApp).toHaveBeenCalledTimes(1)
    expect((await fila(id)).deliveryStatus).toBe('SENT')
  })

  it('un reclamo de hace 6 min se vuelve a tomar; uno de hace 4 min no', async () => {
    const [vieja, reciente] = await tarjetas(2)
    const ahora = new Date()
    await prisma.giftCard.update({
      where: { id: vieja },
      data: { deliveryAttempts: 1, deliveryClaimedAt: new Date(ahora.getTime() - 6 * 60_000) },
    })
    await prisma.giftCard.update({
      where: { id: reciente },
      data: { deliveryAttempts: 1, deliveryClaimedAt: new Date(ahora.getTime() - 4 * 60_000) },
    })

    const r = await reclamarEntregas({ ahora, ids: [vieja, reciente] })

    expect(r.map(x => [x.id, x.deliveryAttempts])).toEqual([[vieja, 2]])
  })

  it('PRINTED, HANDED_TO_BUYER, BLOCKED, vencida y PENDING nunca se reclaman', async () => {
    const [impresa, enMano, bloqueada, vencida, pendiente] = await tarjetas(5)
    await prisma.giftCard.update({ where: { id: impresa }, data: { deliveryChannel: 'PRINTED' } })
    await prisma.giftCard.update({ where: { id: enMano }, data: { deliveryChannel: 'HANDED_TO_BUYER' } })
    await prisma.giftCard.update({ where: { id: bloqueada }, data: { status: 'BLOCKED' } })
    await prisma.giftCard.update({ where: { id: vencida }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    await prisma.giftCard.update({ where: { id: pendiente }, data: { status: 'PENDING' } })

    expect(await reclamarEntregas({ ahora: new Date(), ids: [impresa, enMano, bloqueada, vencida, pendiente] })).toEqual([])
  })
})

/**
 * Cierre A (C3, M1 de la revisión final): en una base con tarjetas de la 1a (vendidas antes de que existiera la entrega: ACTIVE,
 * entrega PENDING para siempre, sin huella de venta), el envío automático no les manda nada. La vuelta de cada minuto y la patada
 * son la MISMA `entregarTarjetas` (la vuelta, sin `ids`): aquí, acotada a las tarjetas de la prueba. Un «Reenviar» de una persona
 * sí manda.
 */
describe('🔴 C3: el envío automático sólo toma tarjetas de la 1b; «Reenviar» sí manda una de la 1a', () => {
  /** Como la guardó la venta de la 1a: sin `ventaHuella` y sin llave de reenvío. */
  const comoLaUnoA = (id: string) => prisma.giftCard.update({ where: { id }, data: { ventaHuella: null, deliveryOperationKey: null } })
  const quien = () => ({ staffId: negocio.staffId, puedeVender: true, puedeGestionar: false })

  it('una de la 1a (ACTIVE, PENDING, WhatsApp) no la toma la vuelta; una de la 1b sí sale', async () => {
    const [deLaUnoA, deLaUnoB] = await tarjetas(2)
    await comoLaUnoA(deLaUnoA)
    expect((await fila(deLaUnoA)).deliveryStatus).toBe('PENDING')
    mockEnviarWhatsApp.mockImplementation(async () => ({ messageId: unico('wamid.c3') }))

    const r = await entregarTarjetas({ ids: [deLaUnoA, deLaUnoB] })

    expect(r).toEqual(expect.objectContaining({ reclamadas: 1, enviadas: 1, atoradas: 0 }))
    expect(mockEnviarWhatsApp).toHaveBeenCalledTimes(1)
    expect(mockEnviarWhatsApp.mock.calls[0][1].pageToken).toBe((await fila(deLaUnoB)).pageToken)
    expect((await fila(deLaUnoB)).deliveryStatus).toBe('SENT')
    expect(await fila(deLaUnoA)).toEqual(
      expect.objectContaining({ deliveryStatus: 'PENDING', deliveryAttempts: 0, deliveryClaimedAt: null, deliveryMessageId: null }),
    )
  })

  it('tampoco la cierra como atorada (4.º intento con el reclamo vencido): sigue PENDING, sin aviso de fallo', async () => {
    const [deLaUnoA] = await tarjetas(1)
    await comoLaUnoA(deLaUnoA)
    await prisma.giftCard.update({
      where: { id: deLaUnoA },
      data: { deliveryAttempts: 4, deliveryClaimedAt: new Date(Date.now() - 6 * 60_000) },
    })

    const r = await entregarTarjetas({ ids: [deLaUnoA] })

    expect(r).toEqual(expect.objectContaining({ reclamadas: 0, atoradas: 0 }))
    expect(await fila(deLaUnoA)).toEqual(expect.objectContaining({ deliveryStatus: 'PENDING', deliveryErrorCode: null }))
    expect(mockEnviarWhatsApp).not.toHaveBeenCalled()
  })

  it('«Reenviar» de una persona sobre una de la 1a SÍ manda, y la vuelta de cada minuto toma su reintento', async () => {
    const [deLaUnoA] = await tarjetas(1)
    await comoLaUnoA(deLaUnoA)
    await reenviarTarjeta(negocio.venueId, deLaUnoA, quien(), { operationKey: unico('reenvia-1a') })

    // El primer envío no sale (Meta no contesta): se reprograma a +1 min.
    mockEnviarWhatsApp.mockRejectedValueOnce(new Error('Meta no contestó'))
    expect(await entregarTarjetas({ ids: [deLaUnoA] })).toEqual(expect.objectContaining({ reclamadas: 1, reprogramadas: 1 }))
    // La vuelta de un minuto después la toma y sale.
    mockEnviarWhatsApp.mockResolvedValueOnce({ messageId: unico('wamid.reenvio-1a') })
    const r = await entregarTarjetas({ ids: [deLaUnoA], ahora: new Date(Date.now() + 61_000) })

    expect(r).toEqual(expect.objectContaining({ reclamadas: 1, enviadas: 1 }))
    expect(mockEnviarWhatsApp).toHaveBeenCalledTimes(2)
    expect(await fila(deLaUnoA)).toEqual(expect.objectContaining({ deliveryStatus: 'SENT', deliveryAttempts: 2 }))
  })
})

describe('un lote lento no manda con el reclamo vencido (I1)', () => {
  /** El reloj con que la vuelta mide su tiempo (`Date.now`), adelantado a mano: un envío «tarda» lo que la prueba diga. */
  function relojAdelantable() {
    const real = Date.now
    let desfase = 0
    const espia = jest.spyOn(Date, 'now').mockImplementation(() => real() + desfase)
    return { adelantar: (ms: number) => (desfase += ms), restaurar: () => espia.mockRestore() }
  }

  /** Qué tarjeta es cada `pageToken` (el reclamo no promete el orden de las filas). */
  async function porLiga(ids: string[]) {
    const filas = await prisma.giftCard.findMany({ where: { id: { in: ids } }, select: { id: true, pageToken: true }, take: ids.length })
    return new Map(filas.map(f => [f.pageToken, f.id]))
  }

  it('el primer envío tarda más que el reclamo ⇒ la siguiente no sale en esa vuelta: se suelta sin gastar intento y sale UNA vez después', async () => {
    const ids = await tarjetas(2)
    const tarjetaDe = await porLiga(ids)
    const reloj = relojAdelantable()
    const enviadas: string[] = []
    mockEnviarWhatsApp.mockImplementation(async (_telefono: string, d: { pageToken: string }) => {
      enviadas.push(tarjetaDe.get(d.pageToken)!)
      if (enviadas.length === 1) reloj.adelantar(RECLAMO_VENCE_MS + 1_000)
      return { messageId: unico('wamid.lento') }
    })

    try {
      await entregarTarjetas({ ids })
    } finally {
      reloj.restaurar()
    }

    expect(enviadas).toHaveLength(1)
    const [primera] = enviadas
    const siguiente = ids.find(id => id !== primera)!
    expect((await fila(primera)).deliveryStatus).toBe('SENT')
    expect(await fila(siguiente)).toEqual(
      expect.objectContaining({ deliveryStatus: 'PENDING', deliveryClaimedAt: null, deliveryAttempts: 0, deliveryMessageId: null }),
    )

    await entregarTarjetas({ ids })

    expect(enviadas).toEqual([primera, siguiente])
    expect(await fila(siguiente)).toEqual(expect.objectContaining({ deliveryStatus: 'SENT', deliveryAttempts: 1 }))
  })

  it('con el reclamo ya vencido, la patada que la toma la manda y la vuelta vieja ya no: un solo envío por tarjeta', async () => {
    const ids = await tarjetas(2)
    const tarjetaDe = await porLiga(ids)
    const reloj = relojAdelantable()
    const enviadas: string[] = []
    let patada: Awaited<ReturnType<typeof entregarTarjetas>> | undefined
    mockEnviarWhatsApp.mockImplementation(async (_telefono: string, d: { pageToken: string }) => {
      const id = tarjetaDe.get(d.pageToken)!
      enviadas.push(id)
      if (enviadas.length === 1) {
        // Mientras la vuelta vieja espera a Meta, pasa el reclamo y llega la patada de S4 (`getCuenta`) por la OTRA tarjeta.
        reloj.adelantar(RECLAMO_VENCE_MS + 1_000)
        patada = await entregarTarjetas({ ids: ids.filter(x => x !== id), ahora: new Date(Date.now()) })
      }
      return { messageId: unico('wamid.patada') }
    })

    try {
      await entregarTarjetas({ ids })
    } finally {
      reloj.restaurar()
    }

    expect(patada?.enviadas).toBe(1)
    expect([...enviadas].sort()).toEqual([...ids].sort())
    const otra = enviadas[1]
    // La reclamó la vuelta vieja (intento 1) y luego la patada (intento 2); soltarla ya no le toca: el CAS es sobre el reclamo viejo.
    expect(await fila(otra)).toEqual(expect.objectContaining({ deliveryStatus: 'SENT', deliveryAttempts: 2, deliveryClaimedAt: null }))
    expect((await fila(enviadas[0])).deliveryStatus).toBe('SENT')
  })
})

describe('el aviso de fallo de WhatsApp (Q2, Q103)', () => {
  it('webhook failed marca FAILED sólo la fila de ese deliveryMessageId', async () => {
    const [falla, llega] = await tarjetas(2)
    const wamidFalla = unico('wamid.falla')
    const wamidLlega = unico('wamid.llega')
    // Una vuelta por tarjeta: el reclamo no promete el orden en que regresa las filas.
    mockEnviarWhatsApp.mockResolvedValueOnce({ messageId: wamidFalla })
    await entregarTarjetas({ ids: [falla] })
    mockEnviarWhatsApp.mockResolvedValueOnce({ messageId: wamidLlega })
    await entregarTarjetas({ ids: [llega] })
    expect((await fila(falla)).deliveryStatus).toBe('SENT')

    await processWhatsappWebhook({
      entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: wamidFalla, status: 'failed' }] } }] }],
    })

    expect(await fila(falla)).toEqual(
      expect.objectContaining({ deliveryStatus: 'FAILED', deliveryErrorCode: 'WHATSAPP_UNDELIVERED', deliveryMessageId: wamidFalla }),
    )
    expect(await fila(llega)).toEqual(expect.objectContaining({ deliveryStatus: 'SENT', deliveryErrorCode: null }))
  })

  it('aviso failed antes de guardar el envío ⇒ FAILED', async () => {
    const [id] = await tarjetas(1)
    const wamid = unico('wamid.temprano')
    mockEnviarWhatsApp.mockImplementation(async () => {
      // Meta avisa del fallo mientras el envío todavía espera su respuesta HTTP: ninguna fila tiene aún ese id.
      expect(await marcarEntregaFallidaPorMensaje(wamid)).toBe(false)
      return { messageId: wamid }
    })

    await entregarTarjetas({ ids: [id] })

    expect(await fila(id)).toEqual(
      expect.objectContaining({ deliveryStatus: 'FAILED', deliveryErrorCode: 'WHATSAPP_UNDELIVERED', deliveryMessageId: wamid }),
    )
    expect((await entregarTarjetas({ ids: [id] })).reclamadas).toBe(0)
  })
})

describe('el rebote del correo (Q105)', () => {
  it('rebote antes de guardar ⇒ FAILED', async () => {
    const [id] = await tarjetas(1, porCorreo)
    const resendId = unico('re_X')
    mockResendSend.mockImplementation(async () => {
      await avisoDeResend('email.bounced', resendId)
      return { data: { id: resendId }, error: null }
    })

    await entregarTarjetas({ ids: [id] })

    expect(await fila(id)).toEqual(
      expect.objectContaining({ deliveryStatus: 'FAILED', deliveryErrorCode: 'EMAIL_INVALID_ADDRESS', deliveryMessageId: resendId }),
    )
  })

  it('guardar y luego el rebote ⇒ FAILED', async () => {
    const [id] = await tarjetas(1, porCorreo)
    const resendId = unico('re_X')
    mockResendSend.mockResolvedValue({ data: { id: resendId }, error: null })
    await entregarTarjetas({ ids: [id] })
    expect((await fila(id)).deliveryStatus).toBe('SENT')

    await avisoDeResend('email.bounced', resendId)

    expect(await fila(id)).toEqual(
      expect.objectContaining({ deliveryStatus: 'FAILED', deliveryErrorCode: 'EMAIL_INVALID_ADDRESS', deliveryMessageId: resendId }),
    )
  })

  it('email.complained después de guardar ⇒ sigue SENT', async () => {
    const [id] = await tarjetas(1, porCorreo)
    const resendId = unico('re_X')
    mockResendSend.mockResolvedValue({ data: { id: resendId }, error: null })
    await entregarTarjetas({ ids: [id] })

    await avisoDeResend('email.complained', resendId)

    expect(await fila(id)).toEqual(
      expect.objectContaining({ deliveryStatus: 'SENT', deliveryErrorCode: null, deliveryMessageId: resendId }),
    )
  })
})

describe('la reposición del panel a media entrega (Q38, Q43, Q46)', () => {
  it.each([1, 4])('Q38/Q43: reclamo → reposición del panel → fin del envío en el intento %i', async intento => {
    const [id] = await tarjetas(1)
    await prisma.giftCard.update({
      where: { id },
      data: { deliveryAttempts: intento - 1, deliveryNextAttemptAt: intento > 1 ? new Date(Date.now() - 60_000) : null },
    })
    const ligaVieja = (await fila(id)).pageToken
    mockEnviarWhatsApp.mockImplementationOnce(async () => {
      await reponer(id)
      return { messageId: unico('wamid.viejo') }
    })

    await entregarTarjetas({ ids: [id] })

    const tras = await fila(id)
    expect(tras.pageToken).not.toBe(ligaVieja)
    expect(tras).toEqual(
      expect.objectContaining({
        deliveryStatus: 'PENDING',
        deliveryAttempts: 0,
        deliveryNextAttemptAt: null,
        deliveryClaimedAt: null,
        deliveryMessageId: null,
      }),
    )

    mockEnviarWhatsApp.mockResolvedValueOnce({ messageId: unico('wamid.nuevo') })
    await entregarTarjetas({ ids: [id] })

    expect(mockEnviarWhatsApp).toHaveBeenCalledTimes(2)
    expect(mockEnviarWhatsApp.mock.calls[1][1].pageToken).toBe(tras.pageToken)
    expect((await fila(id)).deliveryStatus).toBe('SENT')
  })

  it.each([1, 4])('Q46: el mismo cruce por CORREO en el intento %i', async intento => {
    const [id] = await tarjetas(1, porCorreo)
    await prisma.giftCard.update({
      where: { id },
      data: { deliveryAttempts: intento - 1, deliveryNextAttemptAt: intento > 1 ? new Date(Date.now() - 60_000) : null },
    })
    const ligaVieja = (await fila(id)).pageToken
    const llamadas = resendQueRecuerdaLlaves(async llamada => {
      if (llamada === 1) await reponer(id)
    })

    await entregarTarjetas({ ids: [id] })
    expect((await fila(id)).deliveryStatus).toBe('PENDING')
    const ligaNueva = (await fila(id)).pageToken
    await entregarTarjetas({ ids: [id] })

    // Primero lo que vive el cliente: el segundo envío salió (Resend no lo rechazó por repetir llave) con la liga nueva.
    expect(await fila(id)).toEqual(expect.objectContaining({ deliveryStatus: 'SENT', deliveryErrorCode: null }))
    expect(llamadas).toHaveLength(2)
    expect(llamadas[1].html).toContain(`/tarjeta/${ligaNueva}`)
    expect(llamadas[1].text).toContain(`/tarjeta/${ligaNueva}`)
    expect(llamadas[1].html).not.toContain(ligaVieja)
    const huella = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 8)
    expect(llamadas[0].llave).toBe(`giftcard:${id}:auto:${huella(ligaVieja)}:${intento}`)
    expect(llamadas[1].llave).toBe(`giftcard:${id}:auto:${huella(ligaNueva)}:1`)
  })
})

describe('el cambio de destino a media entrega (Q38 con S4)', () => {
  it('reclamo → change-destination → fin del envío ⇒ no queda SENT con la liga vieja; el siguiente manda al teléfono nuevo', async () => {
    const [id] = await tarjetas(1)
    const ligaVieja = (await fila(id)).pageToken
    mockEnviarWhatsApp.mockImplementationOnce(async () => {
      await cambiarDestinoDeTarjeta(
        negocio.venueId,
        id,
        { staffId: negocio.staffId, puedeVender: true, puedeGestionar: true },
        { operationKey: unico('cambia'), destino: { deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' } },
      )
      return { messageId: unico('wamid.viejo') }
    })

    await entregarTarjetas({ ids: [id] })

    const tras = await fila(id)
    expect(tras.pageToken).not.toBe(ligaVieja)
    expect(tras).toEqual(
      expect.objectContaining({
        deliveryStatus: 'PENDING',
        recipientPhone: '+525598765432',
        deliveryAttempts: 0,
        deliveryClaimedAt: null,
        deliveryMessageId: null,
      }),
    )

    mockEnviarWhatsApp.mockResolvedValueOnce({ messageId: unico('wamid.nuevo') })
    await entregarTarjetas({ ids: [id] })

    expect(mockEnviarWhatsApp).toHaveBeenCalledTimes(2)
    expect(mockEnviarWhatsApp.mock.calls[1][0]).toBe('+525598765432')
    expect(mockEnviarWhatsApp.mock.calls[1][1].pageToken).toBe(tras.pageToken)
    expect((await fila(id)).deliveryStatus).toBe('SENT')
  })

  it('reclamo → resend al mismo destino → fin del envío ⇒ el resultado viejo no pisa el reenvío: sigue PENDING y la siguiente vuelta manda otra vez', async () => {
    const [id] = await tarjetas(1)
    const llave = unico('reenvia')
    mockEnviarWhatsApp.mockImplementationOnce(async () => {
      await reenviarTarjeta(
        negocio.venueId,
        id,
        { staffId: negocio.staffId, puedeVender: true, puedeGestionar: false },
        { operationKey: llave },
      )
      return { messageId: unico('wamid.viejo') }
    })

    await entregarTarjetas({ ids: [id] })

    expect(await fila(id)).toEqual(
      expect.objectContaining({
        deliveryStatus: 'PENDING',
        deliveryAttempts: 0,
        deliveryClaimedAt: null,
        deliveryMessageId: null,
        deliveryOperationKey: llave,
      }),
    )
    mockEnviarWhatsApp.mockResolvedValueOnce({ messageId: unico('wamid.reenvio') })
    await entregarTarjetas({ ids: [id] })
    expect(mockEnviarWhatsApp).toHaveBeenCalledTimes(2)
    expect((await fila(id)).deliveryStatus).toBe('SENT')
  })
})
