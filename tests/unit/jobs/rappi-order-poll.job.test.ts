/**
 * Sondeo de pedidos de Rappi por tienda (Tarea 20) — la red por si se pierde el aviso NEW_ORDER.
 *
 * Lo medido en el sandbox (M13, 22-oct): con el servidor apagado Rappi intentó el aviso 3 veces y se rindió; el
 * `GET /restaurants/orders/v1/stores/{storeId}/orders` (host NUEVO) devolvió el pedido UNA vez y el segundo GET vino vacío:
 * 🔴 quien lee primero se lo lleva (READY → SENT). `GET …/orders/status/sent` (host clásico, global) es lectura.
 *
 * Aquí la red es simulada (`global.fetch`), la base es una tabla en memoria con el índice ÚNICO de `dedupKey` (P2002 de
 * verdad) y el procesador es un espía. El ingreso de Rappi es el REAL: la prueba central compara la llave del sondeo con la
 * del webhook firmado.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const PEDIDO_DEL_SANDBOX = fs.readFileSync(
  path.join(__dirname, '../services/delivery-channels/fixtures/rappi/sandbox/new-order-full-delivery-nuestro-menu.json'),
  'utf8',
)

const mockEnv: Record<string, unknown> = {}
const ENV_BASE = {
  RAPPI_ENVIRONMENT: 'SANDBOX',
  RAPPI_COUNTRY: 'MX',
  RAPPI_CLIENT_ID_SANDBOX: 'cid-sandbox',
  RAPPI_CLIENT_SECRET_SANDBOX: 'csecret-que-no-se-imprime',
  RAPPI_WRITABLE_STORE_IDS_SANDBOX: '900175625,900175626',
  RAPPI_ORDER_POLL_ENABLED: true,
}
jest.mock('@/config/env', () => ({ env: mockEnv }))

const mockProcess = jest.fn()
jest.mock('@/services/delivery-channels/providers/rappi/rappi.eventProcessor', () => ({
  processRappiEvent: (...args: unknown[]) => mockProcess(...args),
}))

const mockScheduleJob = jest.fn()
jest.mock('@/observability/jobContext', () => ({
  scheduleJob: (...args: unknown[]) => mockScheduleJob(...args),
}))

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { RappiOrderPollJob } from '@/jobs/rappi-order-poll.job'
import { llaveDeDeduplicacion, persistRappiWebhookEvent } from '@/services/delivery-channels/providers/rappi/rappi.webhookIngress'
import { _resetRappiTokenCacheForTests } from '@/services/delivery-channels/providers/rappi/rappi.token'

const TIENDA = '900175625'
const OTRA_AUTORIZADA = '900175626'
const URL_LOGIN = 'https://api.dev.rappi.com/restaurants/auth/v1/token/login/integrations/'
const urlPorTienda = (s: string) => `https://api.dev.rappi.com/restaurants/orders/v1/stores/${s}/orders`
const URL_ENVIADOS = 'https://microservices.dev.rappi.com/api/v2/restaurants-integrations-public-api/orders/status/sent'

/** El pedido medido, con un cliente reconocible: si su nombre o su dirección aparecen en un log, la prueba lo ve. */
function pedido(orderId: string, storeId = TIENDA, extra: Record<string, unknown> = {}) {
  const base = JSON.parse(PEDIDO_DEL_SANDBOX) as Record<string, any>
  base.order_detail.order_id = orderId
  base.store = { ...base.store, external_id: storeId, internal_id: storeId }
  base.customer = { first_name: 'Clienta Secreta Pérez', phone: '5512345678', address: 'Calle Privada 123' }
  return { ...base, ...extra }
}

type Respuesta = { status: number; body?: unknown; texto?: string }
const json = (r: Respuesta) =>
  ({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    text: async () => r.texto ?? JSON.stringify(r.body ?? {}),
    json: async () => r.body,
  }) as unknown as Response

/** La red de Rappi: el login da token; el resto se contesta por URL. Guarda el orden de las llamadas en `bitacora`. */
let respuestas: Record<string, Respuesta | (() => Promise<Respuesta>)>
let llamadas: string[]
let bitacora: string[]
/** Lo que contesta el login (por default, el token) y cuántas veces se pidió. */
let login: Respuesta
let logins: number
const LOGIN_BUENO: Respuesta = { status: 200, body: { access_token: 'tok-integ-secreto', expires_in: 3600 } }
function simularRed() {
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u === URL_LOGIN) {
      logins++
      return json(login)
    }
    llamadas.push(u)
    bitacora.push(`GET ${u}`)
    const r = respuestas[u]
    if (!r) return json({ status: 200, body: [] })
    return json(typeof r === 'function' ? await r() : r)
  }) as unknown as typeof fetch
}

/** Los eventos guardados, con el índice ÚNICO de `dedupKey` que hace la base. */
let eventos: Array<Record<string, any>>
let vinculos: Array<{ id: string; venueId: string; externalLocationId: string; status: string }>
function simularBase() {
  const { Prisma } = jest.requireActual('@prisma/client')
  ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockImplementation(async ({ where }: any) =>
    vinculos
      .filter(v => where.status.in.includes(v.status) && where.externalLocationId.in.includes(v.externalLocationId))
      .map(v => ({ externalLocationId: v.externalLocationId })),
  )
  ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
    const v = vinculos.find(x => x.externalLocationId === where.provider_externalLocationId.externalLocationId)
    return v ? { id: v.id, venueId: v.venueId } : null
  })
  ;(prisma.deliveryOrderEvent.create as jest.Mock).mockImplementation(async ({ data }: any) => {
    if (eventos.some(e => e.dedupKey === data.dedupKey)) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`dedupKey`)', {
        code: 'P2002',
        clientVersion: 'x',
      })
    }
    const fila = { id: `evt${eventos.length + 1}`, ...data }
    eventos.push(fila)
    bitacora.push(`GUARDAR ${data.externalOrderId}`)
    return { id: fila.id }
  })
}

function firmar(timestamp: string, body: Buffer, secreto: string): string {
  const firmado = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body])
  return `t=${timestamp},sign=${crypto.createHmac('sha256', secreto).update(firmado).digest('hex')}`
}

/** El webhook NEW_ORDER firmado, por la misma función que usa el controller. */
async function llegaElWebhook(p: unknown) {
  const rawBody = Buffer.from(JSON.stringify(p), 'utf8')
  return persistRappiWebhookEvent({
    rawBody,
    signatureHeader: firmar('1761130000', rawBody, 'sec-new-order'),
    evento: 'NEW_ORDER',
    secrets: ['sec-new-order'],
  })
}

/** Todo lo que se logueó, en texto: para buscar datos que no deben salir. */
function todoLoLogueado(): string {
  return JSON.stringify((['info', 'warn', 'error', 'debug'] as const).flatMap(nivel => (logger[nivel] as jest.Mock).mock.calls))
}

/** Cuántos 🚨 se loguearon (en cualquier nivel). */
const alarmas = () =>
  (['info', 'warn', 'error'] as const).flatMap(n => (logger[n] as jest.Mock).mock.calls).filter(c => String(c[0]).includes('🚨')).length

let job: RappiOrderPollJob
beforeEach(() => {
  for (const k of Object.keys(mockEnv)) delete mockEnv[k]
  Object.assign(mockEnv, ENV_BASE)
  respuestas = {}
  llamadas = []
  bitacora = []
  login = LOGIN_BUENO
  logins = 0
  eventos = []
  vinculos = [{ id: 'link1', venueId: 'venue1', externalLocationId: TIENDA, status: 'ACTIVE' }]
  _resetRappiTokenCacheForTests()
  simularRed()
  simularBase()
  mockProcess.mockImplementation(async (id: string) => {
    bitacora.push(`PROCESAR ${id}`)
    return { outcome: 'PROCESSED' }
  })
  mockScheduleJob.mockImplementation(() => ({ start: jest.fn(), stop: jest.fn() }))
  job = new RappiOrderPollJob()
})

describe('🔴 un pedido que llega por sondeo y por webhook se registra UNA vez', () => {
  it('sondeo primero: el webhook después es DUPLICATE y no hay segundo registro ni segundo proceso', async () => {
    const p = pedido('570494427')
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [p] }

    await job.runOnce()
    const r = await llegaElWebhook(p)

    expect(r.outcome).toBe('DUPLICATE')
    expect(eventos).toHaveLength(1)
    expect(eventos[0]).toMatchObject({ eventType: 'NEW_ORDER', externalOrderId: '570494427', channelLinkId: 'link1', venueId: 'venue1' })
    // La MISMA llave que el webhook firmado le habría puesto.
    expect(eventos[0].dedupKey).toBe(llaveDeDeduplicacion('NEW_ORDER', p, firmar('1761130000', Buffer.from('x'), 's')))
    expect(mockProcess).toHaveBeenCalledTimes(1)
    expect(mockProcess).toHaveBeenCalledWith('evt1')
  })

  it('webhook primero: el sondeo topa con el índice único (P2002) y ni guarda ni procesa otra vez', async () => {
    const p = pedido('570494427')
    expect((await llegaElWebhook(p)).outcome).toBe('PERSISTED')
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [p] }

    const resumen = await job.runOnce()

    expect(eventos).toHaveLength(1)
    expect(mockProcess).not.toHaveBeenCalled() // el webhook ya lo mandó a procesar; el sondeo no lo toca
    expect(resumen).toMatchObject({ guardados: 0, duplicados: 1 })
  })

  it('el mismo pedido en el GET por tienda y en status/sent de la MISMA pasada ⇒ una vez', async () => {
    const p = pedido('570494427')
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [p] }
    respuestas[URL_ENVIADOS] = { status: 200, body: [p] }

    await job.runOnce()

    expect(eventos).toHaveLength(1)
    expect(mockProcess).toHaveBeenCalledTimes(1)
  })
})

describe('recuperación por status/sent', () => {
  // Si el proceso muere después del GET y antes de guardar, el pedido ya no vuelve por el GET (ya está SENT): sólo por aquí.
  it('🔴 un pedido SENT que sólo aparece en status/sent se guarda y se procesa', async () => {
    respuestas[URL_ENVIADOS] = { status: 200, body: [pedido('570494999')] }

    const resumen = await job.runOnce()

    expect(eventos).toHaveLength(1)
    expect(eventos[0]).toMatchObject({ eventType: 'NEW_ORDER', externalOrderId: '570494999', channelLinkId: 'link1' })
    expect(mockProcess).toHaveBeenCalledWith('evt1')
    expect(resumen).toMatchObject({ guardados: 1 })
    // El origen queda visible en el log (el modelo no tiene columna de origen y no hay migración).
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('sondeo'),
      expect.objectContaining({ orderId: '570494999', origen: 'ENVIADOS' }),
    )
  })

  it('los de otras tiendas (sin vínculo vivo o fuera de la lista) se ignoran sin ruido', async () => {
    vinculos.push({ id: 'link9', venueId: 'venue9', externalLocationId: '111', status: 'ACTIVE' }) // vivo pero NO autorizado
    respuestas[URL_ENVIADOS] = { status: 200, body: [pedido('1', '111'), pedido('2', '999999'), pedido('3', OTRA_AUTORIZADA)] }

    await job.runOnce()

    expect(eventos).toHaveLength(0)
    expect(mockProcess).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('🔴 sólo se sondean las tiendas autorizadas (un GET a otra tienda le robaría sus pedidos)', () => {
  it('consulta una vez los vínculos RAPPI vivos de la lista, acotada y con el select mínimo', async () => {
    await job.runOnce()

    expect(prisma.deliveryChannelLink.findMany).toHaveBeenCalledTimes(1)
    const args = (prisma.deliveryChannelLink.findMany as jest.Mock).mock.calls[0][0]
    expect(args.where.provider).toBe('RAPPI')
    expect([...args.where.status.in].sort()).toEqual(['ACTIVE', 'PAUSED', 'PENDING'])
    expect(args.where.externalLocationId.in).toEqual([TIENDA, OTRA_AUTORIZADA])
    expect(args.select).toEqual({ externalLocationId: true })
    expect(args.take).toBe(2)
  })

  it('una tienda autorizada SIN vínculo vivo, o con vínculo DISABLED, no recibe GET', async () => {
    vinculos = [
      { id: 'link1', venueId: 'venue1', externalLocationId: TIENDA, status: 'ACTIVE' },
      { id: 'link2', venueId: 'venue2', externalLocationId: OTRA_AUTORIZADA, status: 'DISABLED' },
    ]

    await job.runOnce()

    expect(llamadas.filter(u => u.includes('/restaurants/orders/v1/stores/'))).toEqual([urlPorTienda(TIENDA)])
  })

  it('aunque la base devolviera una tienda fuera de la lista, no sale el GET (el candado y el filtro en memoria)', async () => {
    ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValueOnce([
      { externalLocationId: '111' },
      { externalLocationId: TIENDA },
    ])

    await job.runOnce()

    expect(llamadas.filter(u => u.includes('/restaurants/orders/v1/stores/'))).toEqual([urlPorTienda(TIENDA)])
  })

  it('PAUSED y PENDING cuentan como vivos (la misma regla que el PING)', async () => {
    vinculos = [
      { id: 'link1', venueId: 'venue1', externalLocationId: TIENDA, status: 'PAUSED' },
      { id: 'link2', venueId: 'venue2', externalLocationId: OTRA_AUTORIZADA, status: 'PENDING' },
    ]

    await job.runOnce()

    expect(llamadas.filter(u => u.includes('/restaurants/orders/v1/stores/')).sort()).toEqual(
      [urlPorTienda(TIENDA), urlPorTienda(OTRA_AUTORIZADA)].sort(),
    )
  })

  it('lista de escritura vacía ⇒ ni consulta a la base ni HTTP', async () => {
    mockEnv.RAPPI_WRITABLE_STORE_IDS_SANDBOX = ''

    await job.runOnce()

    expect(prisma.deliveryChannelLink.findMany).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('sin vínculos vivos ⇒ ni GET por tienda ni status/sent', async () => {
    vinculos = []

    await job.runOnce()

    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('sin las llaves de la integración ⇒ no sale nada', async () => {
    delete mockEnv.RAPPI_CLIENT_SECRET_SANDBOX

    await job.runOnce()

    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('el GET por tienda va al host NUEVO con la ruta por tienda; status/sent al host clásico; el GET global nunca', async () => {
    await job.runOnce()

    expect(llamadas).toEqual([urlPorTienda(TIENDA), URL_ENVIADOS])
    expect(llamadas.some(u => u.endsWith('/restaurants-integrations-public-api/orders'))).toBe(false)
  })
})

describe('guardar ANTES de procesar', () => {
  it('🔴 todos los pedidos de la tienda se guardan justo después de su GET, sin otra llamada de red en medio, y después se procesan', async () => {
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [pedido('A1'), pedido('A2')] }

    await job.runOnce()

    const i = bitacora.indexOf(`GET ${urlPorTienda(TIENDA)}`)
    expect(bitacora.slice(i, i + 3)).toEqual([`GET ${urlPorTienda(TIENDA)}`, 'GUARDAR A1', 'GUARDAR A2'])
    const primerProceso = bitacora.findIndex(x => x.startsWith('PROCESAR'))
    expect(primerProceso).toBeGreaterThan(bitacora.indexOf('GUARDAR A2'))
    expect(mockProcess.mock.calls.map(c => c[0]).sort()).toEqual(['evt1', 'evt2'])
  })

  it('🔴 un pedido PROGRAMADO del sondeo se guarda con SU llave y no tapa el NEW_ORDER real que llegue después', async () => {
    const programado = pedido('P1', TIENDA, { action: 'scheduled' })
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [programado] }

    await job.runOnce()
    const real = await llegaElWebhook(pedido('P1'))

    expect(eventos.map(e => e.eventType)).toEqual(['NEW_ORDER_SCHEDULED', 'NEW_ORDER'])
    expect(real.outcome).toBe('PERSISTED')
  })

  it('un elemento sin id de pedido no se guarda, se avisa sin el cuerpo, y los demás sí', async () => {
    const roto = pedido('X')
    delete (roto as any).order_detail.order_id
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [roto, pedido('B1')] }

    await job.runOnce()

    expect(eventos.map(e => e.externalOrderId)).toEqual(['B1'])
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ storeId: TIENDA }))
    expect(todoLoLogueado()).not.toContain('Clienta Secreta')
  })
})

describe('errores: una tienda no frena a las demás y nunca hay 🚨 por pasada', () => {
  it('un 5xx de una tienda queda en warn con la tienda; la otra tienda sí se guarda', async () => {
    vinculos.push({ id: 'link2', venueId: 'venue2', externalLocationId: OTRA_AUTORIZADA, status: 'ACTIVE' })
    respuestas[urlPorTienda(TIENDA)] = { status: 503, texto: 'Service Unavailable' }
    respuestas[urlPorTienda(OTRA_AUTORIZADA)] = { status: 200, body: [pedido('C1', OTRA_AUTORIZADA)] }

    await job.runOnce()

    expect(eventos.map(e => e.externalOrderId)).toEqual(['C1'])
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ storeId: TIENDA, status: 503 }))
    expect(logger.error).not.toHaveBeenCalled()
    expect(todoLoLogueado()).not.toContain('🚨')
  })

  it('un fallo de red (lanza) de una tienda tampoco frena a la otra', async () => {
    vinculos.push({ id: 'link2', venueId: 'venue2', externalLocationId: OTRA_AUTORIZADA, status: 'ACTIVE' })
    respuestas[urlPorTienda(TIENDA)] = async () => {
      throw new Error('ECONNRESET')
    }
    respuestas[urlPorTienda(OTRA_AUTORIZADA)] = { status: 200, body: [pedido('C2', OTRA_AUTORIZADA)] }

    await job.runOnce()

    expect(eventos.map(e => e.externalOrderId)).toEqual(['C2'])
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ storeId: TIENDA }))
    expect(todoLoLogueado()).not.toContain('🚨')
  })

  it('un 4xx de status/sent queda en warn y no tumba lo ya guardado de la pasada', async () => {
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [pedido('D1')] }
    respuestas[URL_ENVIADOS] = { status: 404, texto: 'not found' }

    await job.runOnce()

    expect(eventos).toHaveLength(1)
    expect(mockProcess).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 404 }))
    expect(todoLoLogueado()).not.toContain('🚨')
  })

  it('un 2xx con un cuerpo que no es lista se avisa SIN el cuerpo (puede traer datos del cliente)', async () => {
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: { pedido: pedido('E1') } }

    await job.runOnce()

    expect(eventos).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ storeId: TIENDA, status: 200 }))
    expect(todoLoLogueado()).not.toContain('Clienta Secreta')
  })

  it('un procesamiento que lanza no frena a los demás: el evento ya quedó guardado', async () => {
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [pedido('F1'), pedido('F2')] }
    mockProcess.mockRejectedValueOnce(new Error('se cayó a media aceptación'))

    await job.runOnce()

    expect(eventos).toHaveLength(2)
    expect(mockProcess).toHaveBeenCalledTimes(2)
  })

  it('🔴 sin secretos ni datos del cliente en los logs', async () => {
    vinculos.push({ id: 'link2', venueId: 'venue2', externalLocationId: OTRA_AUTORIZADA, status: 'ACTIVE' })
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [pedido('G1')] }
    respuestas[urlPorTienda(OTRA_AUTORIZADA)] = { status: 500, texto: 'error' }
    respuestas[URL_ENVIADOS] = { status: 200, body: [pedido('G2')] }

    await job.runOnce()

    const log = todoLoLogueado()
    expect(log).not.toContain('Clienta Secreta')
    expect(log).not.toContain('Calle Privada')
    expect(log).not.toContain('5512345678')
    expect(log).not.toContain('tok-integ-secreto')
    expect(log).not.toContain('csecret-que-no-se-imprime')
  })
})

describe('una pasada a la vez', () => {
  it('🔴 si la pasada anterior sigue (GET colgado), la nueva no hace nada', async () => {
    let soltar!: (r: Respuesta) => void
    respuestas[urlPorTienda(TIENDA)] = () => new Promise<Respuesta>(res => (soltar = res))

    const primera = job.runOnce()
    await new Promise(r => setImmediate(r))
    const segunda = await job.runOnce()

    expect(segunda).toMatchObject({ saltada: 'EN_CURSO' })
    expect(prisma.deliveryChannelLink.findMany).toHaveBeenCalledTimes(1)
    soltar({ status: 200, body: [] })
    await primera
    // Al terminar, el candado se soltó: la siguiente sí corre (ya con un GET que contesta).
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [] }
    await job.runOnce()
    expect(prisma.deliveryChannelLink.findMany).toHaveBeenCalledTimes(2)
  })

  it('🔴 una pasada que revienta suelta el candado (finally): la siguiente corre', async () => {
    ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockRejectedValueOnce(new Error('consulta rota'))

    await expect(job.runOnce()).resolves.toBeDefined()
    await job.runOnce()

    expect(prisma.deliveryChannelLink.findMany).toHaveBeenCalledTimes(2)
    expect(llamadas).toContain(urlPorTienda(TIENDA))
  })
})

describe('🔴 apagado por default', () => {
  it('env.ts: sin la variable queda en false; sólo "true" lo prende', () => {
    const ORIGINAL = process.env
    const cargar = (valor: string | undefined) => {
      let env: Record<string, unknown> = {}
      jest.isolateModules(() => {
        process.env = { ...ORIGINAL, RAPPI_ORDER_POLL_ENABLED: valor } as NodeJS.ProcessEnv
        env = jest.requireActual('@/config/env').env
      })
      process.env = ORIGINAL
      return env
    }
    expect(cargar(undefined).RAPPI_ORDER_POLL_ENABLED).toBe(false)
    expect(cargar('false').RAPPI_ORDER_POLL_ENABLED).toBe(false)
    expect(cargar('1').RAPPI_ORDER_POLL_ENABLED).toBe(false)
    expect(cargar('true').RAPPI_ORDER_POLL_ENABLED).toBe(true)
  })

  it('apagado: start() no programa nada y runOnce() no consulta la base ni sale a la red', async () => {
    mockEnv.RAPPI_ORDER_POLL_ENABLED = false

    job.start()
    const r = await job.runOnce()

    expect(mockScheduleJob).not.toHaveBeenCalled()
    expect(r).toMatchObject({ saltada: 'APAGADO' })
    expect(prisma.deliveryChannelLink.findMany).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('prendido: se programa una vez, en un patrón que nunca cae en :00, con su zona y su nombre', () => {
    job.start()
    job.start()

    expect(mockScheduleJob).toHaveBeenCalledTimes(1)
    const [nombre, patron, , , , zona] = mockScheduleJob.mock.calls[0]
    expect(nombre).toBe('rappi-order-poll')
    expect(zona).toBe('America/Mexico_City')
    const segundos = String(patron).split(' ')[0].split(',').map(Number)
    expect(segundos).not.toContain(0)
    expect(segundos).toEqual([7, 22, 37, 52])
    const programado = mockScheduleJob.mock.results[0].value
    expect(programado.start).toHaveBeenCalled()
    job.stop()
    expect(programado.stop).toHaveBeenCalled()
  })

  it('🔴 el ritmo: aunque el cron toque cada 15 s, una pasada sale cada 45 s (lo que Rappi pide para descargar pedidos)', async () => {
    job.start()
    const tick = mockScheduleJob.mock.calls[0][2] as () => Promise<void>
    const correr = jest.spyOn(job, 'runOnce').mockResolvedValue({} as never)
    const reloj = jest.spyOn(Date, 'now')
    try {
      for (const t of [0, 15_000, 30_000, 45_003, 60_000, 75_000, 89_998, 105_000]) {
        reloj.mockReturnValue(1_761_130_000_000 + t)
        await tick()
      }
      expect(correr).toHaveBeenCalledTimes(3) // en 0, 45 y 90 s
    } finally {
      reloj.mockRestore()
      job.stop()
    }
  })
})

// ── Ronda de arreglo 1 ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('🔴 I-1: si Rappi rechaza el login, el sondeo se pausa y no grita en cada pasada', () => {
  const T0 = 1_761_130_000_000
  let reloj: jest.SpyInstance
  beforeEach(() => {
    reloj = jest.spyOn(Date, 'now').mockReturnValue(T0)
  })
  afterEach(() => reloj.mockRestore())
  const a = (ms: number) => reloj.mockReturnValue(T0 + ms)

  it('login 401 durante varias pasadas ⇒ un solo 🚨, ningún status/sent en la pausa, y vuelve solo cuando el login funciona', async () => {
    login = { status: 401, texto: 'invalid_client' }

    const r1 = await job.runOnce()
    expect(logins).toBe(1)
    expect(llamadas).toEqual([]) // ni el GET por tienda salió (sin token no sale nada) ni status/sent
    expect(r1).toMatchObject({ fallidas: 1 })
    expect(alarmas()).toBe(1) // el 🚨 del login, al EMPEZAR la racha
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('se pausa'), expect.anything())

    // Durante la pausa (5 min): ni login ni GET ni status/sent, aunque el cron siga tocando.
    for (const t of [45_000, 90_000, 180_000, 299_000]) {
      a(t)
      expect(await job.runOnce()).toMatchObject({ saltada: 'PAUSA_SIN_LOGIN' })
    }
    expect(logins).toBe(1)
    expect(llamadas).toEqual([])

    // Pasada la pausa, se vuelve a intentar: sigue rechazado ⇒ otra pausa, pero ya sin 🚨 (la racha sigue).
    a(301_000)
    await job.runOnce()
    expect(logins).toBe(2)
    expect(llamadas).toEqual([])
    expect(alarmas()).toBe(1)
    const avisosDePausa = (logger.warn as jest.Mock).mock.calls.filter(c => String(c[0]).includes('se pausa')).length
    expect(avisosDePausa).toBe(1) // UN solo warn de pausa por racha

    // El login vuelve: la siguiente pasada después de la pausa trabaja normal, con status/sent.
    login = LOGIN_BUENO
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [pedido('R1')] }
    a(602_000)
    await job.runOnce()
    expect(llamadas).toEqual([urlPorTienda(TIENDA), URL_ENVIADOS])
    expect(eventos.map(e => e.externalOrderId)).toEqual(['R1'])
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('el login volvió'), expect.anything())

    // Una racha NUEVA vuelve a avisar con 🚨 (el login bueno rearmó el aviso).
    login = { status: 401, texto: 'invalid_client' }
    a(650_000)
    await job.runOnce()
    expect(alarmas()).toBe(2)
  })

  it.each([
    ['sin `access_token`', {}],
    ['con `access_token` vacío', { access_token: '' }],
    ['con `access_token` de puros espacios', { access_token: '   ' }],
    ['con `access_token` que no es texto', { access_token: 12345 }],
  ])('🔴 un 200 del login %s NO cierra la racha: no dice «el login volvió»', async (_caso, cuerpo) => {
    login = { status: 401, texto: 'invalid_client' }
    await job.runOnce()
    expect(alarmas()).toBe(1) // empieza la racha

    login = { status: 200, body: cuerpo } // Rappi contesta 200 pero el cuerpo no sirve
    a(301_000)
    await job.runOnce()

    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('el login volvió'), expect.anything())
  })

  it('🔴 con un 200 sin token la racha SIGUE abierta: el siguiente rechazo no es un inicio de racha (no grita) y sólo un token de verdad la cierra', async () => {
    login = { status: 401, texto: 'invalid_client' }
    await job.runOnce()
    expect(alarmas()).toBe(1)

    login = { status: 200, body: {} }
    a(301_000)
    await job.runOnce()
    expect(llamadas).toEqual([]) // sin token no salió ni el GET por tienda

    login = { status: 401, texto: 'invalid_client' }
    a(602_000)
    await job.runOnce()
    expect(alarmas()).toBe(1) // dentro de la hora y con la racha abierta: ni un 🚨 más

    login = LOGIN_BUENO
    a(903_000)
    await job.runOnce()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('el login volvió'), expect.anything())
  })

  it('🔴 una caída de login que dura más de una hora vuelve a gritar 🚨 (una por hora), no una sola vez', async () => {
    login = { status: 401, texto: 'invalid_client' }
    await job.runOnce()
    expect(alarmas()).toBe(1)

    a(30 * 60_000)
    await job.runOnce()
    expect(alarmas()).toBe(1) // media hora después: sigue sin repetirse

    a(60 * 60_000 + 1_000)
    await job.runOnce()
    expect(alarmas()).toBe(2) // pasó la hora y la caída sigue

    a(90 * 60_000)
    await job.runOnce()
    expect(alarmas()).toBe(2)

    a(2 * 60 * 60_000 + 5_000)
    await job.runOnce()
    expect(alarmas()).toBe(3)
  })

  it('con muchas tiendas, una pasada sin token pide el login UNA vez (no lo machaca por cada tienda)', async () => {
    const ids = ['900175625', '900175626', '900175627', '900175628', '900175629', '900175630', '900175631']
    mockEnv.RAPPI_WRITABLE_STORE_IDS_SANDBOX = ids.join(',')
    vinculos = ids.map((id, i) => ({ id: `link${i}`, venueId: `venue${i}`, externalLocationId: id, status: 'ACTIVE' }))
    login = { status: 503, texto: 'login caído' }

    await job.runOnce()

    expect(logins).toBe(1)
    expect(llamadas).toEqual([])
    expect(alarmas()).toBe(1)
  })

  it('un 5xx de la lista (con token) NO pausa: la siguiente pasada vuelve a sondear', async () => {
    respuestas[urlPorTienda(TIENDA)] = { status: 503, texto: 'x' }
    await job.runOnce()
    a(45_000)
    const r = await job.runOnce()
    expect(r.saltada).toBeUndefined()
    expect(llamadas.filter(u => u === urlPorTienda(TIENDA))).toHaveLength(2)
  })
})

describe('M-1: un elemento con una identidad que revienta no frena a los demás', () => {
  const raro = () => {
    const p = pedido('X2')
    ;(p as any).store.external_id = 123 // `.trim()` de un número lanza TypeError
    return p
  }

  it('en el GET por tienda: se descarta con un warn sin datos del cliente y los otros dos se guardan', async () => {
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [pedido('X1'), raro(), pedido('X3')] }

    const r = await job.runOnce()

    expect(eventos.map(e => e.externalOrderId)).toEqual(['X1', 'X3'])
    expect(r).toMatchObject({ guardados: 2, descartados: 1 })
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ storeId: TIENDA }))
    expect(todoLoLogueado()).not.toContain('Clienta Secreta')
    expect(mockProcess).toHaveBeenCalledTimes(2)
  })

  it('en status/sent: la pasada no se cae y los otros dos se guardan', async () => {
    respuestas[URL_ENVIADOS] = { status: 200, body: [pedido('Y1'), raro(), pedido('Y3')] }

    const r = await job.runOnce()

    expect(r.saltada).toBeUndefined()
    expect(eventos.map(e => e.externalOrderId)).toEqual(['Y1', 'Y3'])
    expect(r).toMatchObject({ guardados: 2, descartados: 1 })
    expect(todoLoLogueado()).not.toContain('Clienta Secreta')
  })
})

describe('M-7: el resumen separa los desenlaces del procesamiento', () => {
  it('«procesados» cuenta sólo PROCESSED; IN_FLIGHT, FAILED y un throw van aparte', async () => {
    respuestas[urlPorTienda(TIENDA)] = { status: 200, body: [pedido('Z1'), pedido('Z2'), pedido('Z3'), pedido('Z4')] }
    mockProcess
      .mockResolvedValueOnce({ outcome: 'PROCESSED' })
      .mockResolvedValueOnce({ outcome: 'IN_FLIGHT' })
      .mockResolvedValueOnce({ outcome: 'FAILED', error: 'ACCEPT_500' })
      .mockRejectedValueOnce(new Error('tronó'))

    const r = await job.runOnce()

    expect(r.procesados).toBe(1)
    expect(r.desenlaces).toEqual({ PROCESSED: 1, IN_FLIGHT: 1, FAILED: 1, LANZO: 1 })
  })
})
