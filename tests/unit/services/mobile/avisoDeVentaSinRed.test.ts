/**
 * «Cobrar sin red» (S7) — aviso al gerente de una venta de la terminal que llegó con problema.
 *
 * La terminal sube por mobile (crear orden y pagar) y por las dos puertas de `/tpv` (`/fast` y `/orders/:o`) las ventas que hizo
 * sin red. El dinero ya se cobró: si el servidor la rechaza, nunca se pierde en silencio. OWNER y ADMIN activos reciben un aviso
 * en el panel (uno por persona y por venta) y queda `VENTA_SIN_RED_RECHAZADA` en la bitácora.
 *
 * Se montan los routers REALES (mobile y /tpv): el middleware del aviso va ANTES de `checkPermission`, así que un 403 del
 * permiso también avisa, igual que un 400 directo del controlador o uno que sale por el manejador de errores
 * (`validateStaffVenue`). Sólo la autenticación (contexto por cabecera), el permiso (el MISMO 403 directo de
 * `checkPermission`), la validación de `/tpv`, el envío de la notificación y la bitácora van simulados.
 */
const mockPermiso = { denegar: new Set<string>() }

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: (permiso: string) =>
    Object.assign(
      (_req: any, res: any, next: any) =>
        mockPermiso.denegar.has(permiso)
          ? res.status(403).json({ error: 'Forbidden', message: `Permission '${permiso}' required`, required: permiso })
          : next(),
      { permiso },
    ),
}))
jest.mock('@/middlewares/validation', () => ({ validateRequest: () => (_req: any, _res: any, next: any) => next() }))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/services/dashboard/notification.service', () => ({ sendNotification: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import express from 'express'
import request from 'supertest'
import mobileRouter from '@/routes/mobile.routes'
import tpvRouter from '@/routes/tpv.routes'
import { sendNotification } from '@/services/dashboard/notification.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { avisarSiLaVentaDeLaColaFalla, avisarVentaSinRed } from '@/services/mobile/avisoDeVentaSinRed'
import { prismaMock } from '../../../__helpers__/setup'

process.env.TOUCH_HEARTBEAT_ENABLED = 'false'

const VENUE = 'venue-1'
const SERIAL = 'AVQD-2841548417'
const TERMINAL = { userId: 'cajera-1', orgId: 'org-1', venueId: VENUE, role: 'CASHIER', terminalSerialNumber: SERIAL }
const ANDROID = { userId: 'cajera-1', orgId: 'org-1', venueId: VENUE, role: 'CASHIER' }
const LLAVE = 'ckvz8q2xk0000abcd1234efgh'
const DUENOS = [
  { id: 'sv-owner', staffId: 'owner-1' },
  { id: 'sv-admin', staffId: 'admin-1' },
]

const app = express()
app.use(express.json())
app.use('/api/v1/mobile', mobileRouter)
app.use('/api/v1/tpv', tpvRouter)
// Como el `globalErrorHandler` de `app.ts`: un AppError sale con su status y `{ message }`.
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ message: err.message }))

/** Las notificaciones «guardadas»: de aquí lee el dedupe (`notification.groupBy`), como en la base. */
let enviadas: any[]
const enviar = (ruta: string, cuerpo: unknown, token: unknown = TERMINAL) =>
  request(app)
    .post(ruta)
    .set('x-test-auth-context', JSON.stringify(token))
    .send(cuerpo as object)
/** El aviso corre después de responder (`finish`): se le da tiempo de asentarse. */
const asentar = () => new Promise(resolve => setTimeout(resolve, 30))
const notificaciones = () => (sendNotification as jest.Mock).mock.calls.map(c => c[0])
const bitacora = () => (logAction as jest.Mock).mock.calls.map(c => c[0])

beforeEach(() => {
  jest.clearAllMocks()
  mockPermiso.denegar = new Set()
  enviadas = []
  ;(sendNotification as jest.Mock).mockImplementation(async (p: any) => {
    enviadas.push(p)
    return p
  })
  prismaMock.venue.findUnique.mockResolvedValue({ slug: 'cafe-centro' })
  prismaMock.staffVenue.findMany.mockImplementation(async ({ where }: any) => (where.id ? [] : DUENOS))
  prismaMock.notification.groupBy.mockImplementation(async ({ where }: any) =>
    [
      ...new Set(
        enviadas
          .filter(n => n.venueId === where.venueId && n.entityType === where.entityType && n.entityId === where.entityId)
          .filter(n => where.recipientId.in.includes(n.recipientId))
          .map(n => n.recipientId),
      ),
    ].map(recipientId => ({ recipientId })),
  )
  prismaMock.activityLog.findFirst.mockImplementation(async ({ where }: any) =>
    bitacora().some(p => p.venueId === where.venueId && p.action === where.action && p.entityId === where.entityId) ? { id: 'al-1' } : null,
  )
  // Crear orden: la llave no existe todavía y la cajera ya no está en el negocio (`validateStaffVenue` ⇒ 400).
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
})

const DE_LA_COLA_CREAR = { items: [{ productId: 'cafe', quantity: 1 }], staffId: 'cajera-baja', externalId: LLAVE, isOfflineReplay: true }
const DE_LA_COLA_PAGAR = { amount: 9000, tip: 0, idempotencyKey: LLAVE, isOfflineReplay: true }

describe('RECHAZADA — la venta de la cola de una terminal que el servidor no registró', () => {
  it('rechazo 4xx de crear orden (la cajera dada de baja: validateStaffVenue 400) ⇒ una notificación a cada OWNER/ADMIN y ActivityLog', async () => {
    const r = await enviar(`/api/v1/mobile/venues/${VENUE}/orders`, DE_LA_COLA_CREAR)
    await asentar()

    expect(r.status).toBe(400)
    expect(r.body.message).toContain('is not assigned')
    // OWNER y ADMIN activos del negocio, por tandas con cursor.
    expect((prismaMock.staffVenue.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
      venueId: VENUE,
      active: true,
      role: { in: ['OWNER', 'ADMIN'] },
    })
    expect(notificaciones()).toHaveLength(2)
    expect(
      notificaciones()
        .map(n => n.recipientId)
        .sort(),
    ).toEqual(['admin-1', 'owner-1'])
    expect(notificaciones()[0]).toMatchObject({
      venueId: VENUE,
      type: 'ALERT',
      channels: ['IN_APP'],
      entityType: 'VentaSinRed',
      entityId: `RECHAZADA:${LLAVE}`,
      title: 'Una venta sin conexión no se pudo registrar',
    })
    expect(notificaciones()[0].message).toContain(SERIAL)
    expect(notificaciones()[0].message).toContain('is not assigned')
    expect(bitacora()).toEqual([
      expect.objectContaining({
        venueId: VENUE,
        action: 'VENTA_SIN_RED_RECHAZADA',
        entity: 'VentaSinRed',
        entityId: LLAVE,
        staffId: 'cajera-1',
        data: expect.objectContaining({ terminalSerial: SERIAL, motivo: expect.stringContaining('400') }),
      }),
    ])
  })

  it.each([
    ['mobile: crear orden', `/api/v1/mobile/venues/${VENUE}/orders`, 'orders:create', DE_LA_COLA_CREAR],
    ['mobile: pagar', `/api/v1/mobile/venues/${VENUE}/orders/order-1/pay`, 'payments:create', DE_LA_COLA_PAGAR],
    ['/tpv/fast', `/api/v1/tpv/venues/${VENUE}/fast`, 'payments:create', DE_LA_COLA_PAGAR],
    ['/tpv/orders/:o', `/api/v1/tpv/venues/${VENUE}/orders/order-1`, 'payments:create', DE_LA_COLA_PAGAR],
  ])(
    '%s — permiso revocado ⇒ 403 del middleware ⇒ aviso REINTENTANDO (la terminal lo reintenta: nunca «regístrala a mano»)',
    async (_puerta, ruta, permiso, cuerpo) => {
      mockPermiso.denegar.add(permiso)

      const r = await enviar(ruta, cuerpo)
      await asentar()

      expect(r.status).toBe(403)
      expect(notificaciones()).toHaveLength(2)
      expect(notificaciones()[0]).toMatchObject({ entityId: `REINTENTANDO:${LLAVE}` })
      expect(notificaciones()[0].message).toContain(`Permission '${permiso}' required`)
      expect(notificaciones()[0].message).not.toContain('regístrala a mano')
      expect(notificaciones()[0].message).toContain('no la registres a mano')
      expect(bitacora()).toEqual([expect.objectContaining({ action: 'VENTA_SIN_RED_REINTENTANDO', entityId: LLAVE })])
    },
  )

  it('el pago rechazado lleva el monto y la liga a SU orden', async () => {
    mockPermiso.denegar.add('payments:create')

    await enviar(`/api/v1/mobile/venues/${VENUE}/orders/order-1/pay`, DE_LA_COLA_PAGAR)
    await asentar()

    expect(notificaciones()[0].message).toContain('$90.00')
    expect(notificaciones()[0].actionUrl).toBe('/venues/cafe-centro/orders/order-1')
    expect(bitacora()[0].data).toMatchObject({ montoCents: 9000, orderId: 'order-1' })
  })

  it.each([
    ['crear orden sin artículos', `/api/v1/mobile/venues/${VENUE}/orders`, { ...DE_LA_COLA_CREAR, items: [] }],
    ['pagar con monto negativo', `/api/v1/mobile/venues/${VENUE}/orders/order-1/pay`, { ...DE_LA_COLA_PAGAR, amount: -1 }],
  ])('400 devuelto directo por el controlador (%s) ⇒ aviso', async (_caso, ruta, cuerpo) => {
    const r = await enviar(ruta, cuerpo)
    await asentar()

    expect(r.status).toBe(400)
    expect(notificaciones()).toHaveLength(2)
    expect(notificaciones()[0].message).toContain(r.body.message)
    expect(bitacora()).toHaveLength(1)
  })

  it('el mismo externalId dos veces ⇒ una sola notificación por persona y una sola entrada de bitácora', async () => {
    mockPermiso.denegar.add('payments:create')

    await enviar(`/api/v1/mobile/venues/${VENUE}/orders/order-1/pay`, DE_LA_COLA_PAGAR)
    await asentar()
    await enviar(`/api/v1/mobile/venues/${VENUE}/orders/order-1/pay`, DE_LA_COLA_PAGAR)
    await asentar()

    expect(notificaciones()).toHaveLength(2)
    expect(bitacora()).toHaveLength(1)
  })

  it('venta de Android (token sin serial de terminal) ⇒ sin aviso', async () => {
    const r = await enviar(`/api/v1/mobile/venues/${VENUE}/orders`, DE_LA_COLA_CREAR, ANDROID)
    await asentar()

    expect(r.status).toBe(400)
    expect(notificaciones()).toHaveLength(0)
    expect(bitacora()).toHaveLength(0)
    expect(prismaMock.staffVenue.findMany).not.toHaveBeenCalled()
  })

  it('la terminal EN LÍNEA (sin isOfflineReplay) ⇒ sin aviso: la cajera ve el error en su pantalla', async () => {
    const r = await enviar(`/api/v1/mobile/venues/${VENUE}/orders`, { ...DE_LA_COLA_CREAR, isOfflineReplay: undefined })
    await asentar()

    expect(r.status).toBe(400)
    expect(notificaciones()).toHaveLength(0)
  })

  it('token de OTRO negocio que la ruta ⇒ sin aviso: nadie avisa a un negocio ajeno', async () => {
    mockPermiso.denegar.add('payments:create')

    await enviar(`/api/v1/mobile/venues/${VENUE}/orders/order-1/pay`, DE_LA_COLA_PAGAR, { ...TERMINAL, venueId: 'venue-2' })
    await asentar()

    expect(notificaciones()).toHaveLength(0)
  })

  it('una llave más larga que la columna (cuerpo sin validar) no viaja al aviso: se usa la del pago o la orden de la ruta', async () => {
    mockPermiso.denegar.add('payments:create')

    await enviar(`/api/v1/mobile/venues/${VENUE}/orders/order-1/pay`, { ...DE_LA_COLA_PAGAR, idempotencyKey: 'x'.repeat(300) })
    await asentar()

    expect(notificaciones()[0].entityId).toBe('REINTENTANDO:order-1')
  })

  it('5xx ⇒ sin aviso: la terminal reintenta y la venta todavía puede registrarse', async () => {
    prismaMock.order.findUnique.mockRejectedValue(new Error('pool agotado'))

    const r = await enviar(`/api/v1/mobile/venues/${VENUE}/orders`, DE_LA_COLA_CREAR)
    await asentar()

    expect(r.status).toBe(500)
    expect(notificaciones()).toHaveLength(0)
  })

  it('si el envío de la notificación truena, la respuesta HTTP es la misma', async () => {
    const normal = await enviar(`/api/v1/mobile/venues/${VENUE}/orders`, DE_LA_COLA_CREAR)
    await asentar()
    ;(sendNotification as jest.Mock).mockRejectedValue(new Error('correo caído'))
    prismaMock.staffVenue.findMany.mockRejectedValue(new Error('base caída'))

    const conFalla = await enviar(`/api/v1/mobile/venues/${VENUE}/orders`, { ...DE_LA_COLA_CREAR, externalId: 'otra-llave-de-venta-123' })
    await asentar()

    expect(conFalla.status).toBe(normal.status)
    expect(conFalla.body).toEqual(normal.body)
  })
})

describe('cableado — el aviso va ANTES del permiso en las cuatro puertas de la cola', () => {
  function pila(router: any, metodo: string, ruta: string): any[] {
    const capa = (router.stack ?? []).find((l: any) => l.route?.path === ruta && l.route.methods?.[metodo])
    return capa ? capa.route.stack.map((l: any) => l.handle) : []
  }

  it.each([
    ['mobile', '/venues/:venueId/orders', mobileRouter, 'orders:create'],
    ['mobile', '/venues/:venueId/orders/:orderId/pay', mobileRouter, 'payments:create'],
    ['tpv', '/venues/:venueId/fast', tpvRouter, 'payments:create'],
    ['tpv', '/venues/:venueId/orders/:orderId', tpvRouter, 'payments:create'],
  ])('%s %s', (_r, ruta, router, permiso) => {
    const handlers = pila(router, 'post', ruta)
    const i = handlers.indexOf(avisarSiLaVentaDeLaColaFalla)

    expect(i).toBeGreaterThan(0)
    expect(handlers[i + 1].permiso).toBe(permiso)
  })
})

describe('avisarVentaSinRed', () => {
  it('recorre a OWNER y ADMIN por tandas con cursor: ninguno se queda fuera', async () => {
    const muchos = Array.from({ length: 51 }, (_, k) => ({ id: `sv-${String(k).padStart(3, '0')}`, staffId: `admin-${k}` }))
    prismaMock.staffVenue.findMany.mockImplementation(async ({ where, take }: any) =>
      muchos.filter(s => !where.id || s.id > where.id.gt).slice(0, take),
    )

    await avisarVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE, terminalSerial: SERIAL, montoCents: 12050 })

    expect(notificaciones()).toHaveLength(51)
    expect((prismaMock.staffVenue.findMany as jest.Mock).mock.calls[1][0].where.id).toEqual({ gt: 'sv-049' })
  })

  it('TURNO_CERRADO y PRECIO_CAMBIADO dicen qué pasó, con el monto', async () => {
    await avisarVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE, terminalSerial: SERIAL, montoCents: 12050, orderId: 'order-9' })
    await avisarVentaSinRed(VENUE, 'PRECIO_CAMBIADO', {
      externalId: LLAVE,
      terminalSerial: SERIAL,
      montoCents: 9000,
      motivo: 'quedó un saldo pendiente de $40.00',
    })

    const [turno, , precio] = notificaciones()
    expect(turno).toMatchObject({ entityId: `TURNO_CERRADO:${LLAVE}`, actionUrl: '/venues/cafe-centro/orders/order-9' })
    expect(turno.message).toContain('$120.50')
    expect(turno.message).toContain('turno que ya se cerró')
    expect(precio).toMatchObject({ entityId: `PRECIO_CAMBIADO:${LLAVE}` })
    expect(precio.message).toContain('quedó un saldo pendiente de $40.00')
    expect(bitacora().map(b => b.action)).toEqual(['VENTA_SIN_RED_TURNO_CERRADO', 'VENTA_SIN_RED_PRECIO_CAMBIADO'])
  })

  it('dos subidas SIMULTÁNEAS de la misma venta ⇒ una sola notificación por persona (la terminal reintenta sin esperar al aviso)', async () => {
    const datos = { externalId: LLAVE, terminalSerial: SERIAL }

    await Promise.all([avisarVentaSinRed(VENUE, 'RECHAZADA', datos), avisarVentaSinRed(VENUE, 'RECHAZADA', datos)])

    expect(notificaciones()).toHaveLength(2)
  })

  it('nunca lanza: con la base caída resuelve sin error', async () => {
    prismaMock.venue.findUnique.mockRejectedValue(new Error('base caída'))

    await expect(avisarVentaSinRed(VENUE, 'RECHAZADA', { externalId: LLAVE })).resolves.toBeUndefined()
  })
})

describe('el middleware con respuestas que la terminal reintenta sola', () => {
  const mini = (status: number) => {
    const a = express()
    a.use(express.json())
    a.post(
      '/venues/:venueId/orders',
      (req: any, _res: any, next: any) => {
        req.authContext = TERMINAL
        next()
      },
      avisarSiLaVentaDeLaColaFalla,
      (_req: any, res: any) => res.status(status).json({ message: `respuesta ${status}` }),
    )
    return a
  }

  it.each([201, 409, 429])('%s ⇒ sin aviso RECHAZADA', async status => {
    await request(mini(status)).post(`/venues/${VENUE}/orders`).send(DE_LA_COLA_CREAR)
    await asentar()

    expect(notificaciones()).toHaveLength(0)
  })
})

/**
 * 🔴 Codex servidor r1 #4 y #7: el texto depende de lo que la TERMINAL hace con esa respuesta (`SyncOutcome.kt`,
 * `PERMANENT_HTTP_CODES = 400, 404, 422`). Sólo lo definitivo dice «no se registró; regístrala a mano»: con un 401/403 la terminal
 * sigue reintentando, y registrarla a mano y luego devolver el permiso la registraría dos veces. Un 409 IDEMPOTENCY_KEY_REUSED nunca
 * se resuelve repitiendo la misma petición: ése sí es definitivo; los demás 409 siguen sin aviso.
 */
describe('el texto del aviso según lo que la terminal hace con la respuesta', () => {
  const mini = (status: number, code?: string) => {
    const a = express()
    a.use(express.json())
    a.post(
      '/venues/:venueId/orders',
      (req: any, _res: any, next: any) => {
        req.authContext = TERMINAL
        next()
      },
      avisarSiLaVentaDeLaColaFalla,
      (_req: any, res: any) => res.status(status).json({ message: `respuesta ${status}`, ...(code ? { code } : {}) }),
    )
    return a
  }
  const subir = async (status: number, code?: string) => {
    await request(mini(status, code)).post(`/venues/${VENUE}/orders`).send(DE_LA_COLA_CREAR)
    await asentar()
  }

  it.each([400, 404, 422])('%s (definitivo para la terminal) ⇒ RECHAZADA: no se registró y se puede registrar a mano', async status => {
    await subir(status)

    expect(notificaciones()).toHaveLength(2)
    expect(notificaciones()[0]).toMatchObject({ entityId: `RECHAZADA:${LLAVE}`, title: 'Una venta sin conexión no se pudo registrar' })
    expect(notificaciones()[0].message).toContain('regístrala a mano')
    expect(bitacora()).toEqual([expect.objectContaining({ action: 'VENTA_SIN_RED_RECHAZADA' })])
  })

  it.each([401, 403, 405])(
    '%s (la terminal lo sigue reintentando) ⇒ REINTENTANDO: qué revisar, nunca «regístrala a mano»',
    async status => {
      await subir(status)

      expect(notificaciones()).toHaveLength(2)
      const aviso = notificaciones()[0]
      expect(aviso).toMatchObject({ entityId: `REINTENTANDO:${LLAVE}`, title: 'Una venta sin conexión todavía no se puede subir' })
      expect(aviso.message).toContain('sigue reintentando')
      expect(aviso.message).toContain('permiso')
      expect(aviso.message).toContain('sesión')
      expect(aviso.message).not.toContain('regístrala a mano')
      expect(aviso.message).toContain(`respuesta ${status}`)
      expect(bitacora()).toEqual([expect.objectContaining({ action: 'VENTA_SIN_RED_REINTENTANDO', entityId: LLAVE })])
    },
  )

  it('409 IDEMPOTENCY_KEY_REUSED (nunca se resuelve repitiendo) ⇒ RECHAZADA', async () => {
    await subir(409, 'IDEMPOTENCY_KEY_REUSED')

    expect(notificaciones()).toHaveLength(2)
    expect(notificaciones()[0]).toMatchObject({ entityId: `RECHAZADA:${LLAVE}` })
    expect(bitacora()).toEqual([expect.objectContaining({ action: 'VENTA_SIN_RED_RECHAZADA' })])
  })

  it.each(['ORDER_PAYMENT_CONFLICT', undefined])('409 con código %s (pasajero) ⇒ sin aviso', async code => {
    await subir(409, code)

    expect(notificaciones()).toHaveLength(0)
    expect(bitacora()).toHaveLength(0)
  })
})
