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
function simularRed() {
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u === URL_LOGIN) return json({ status: 200, body: { access_token: 'tok-integ-secreto', expires_in: 3600 } })
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

let job: RappiOrderPollJob
beforeEach(() => {
  for (const k of Object.keys(mockEnv)) delete mockEnv[k]
  Object.assign(mockEnv, ENV_BASE)
  respuestas = {}
  llamadas = []
  bitacora = []
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
