import express from 'express'
import request from 'supertest'
import { ConflictError, ValidationError } from '@/errors/AppError'

// `@/app` (el manejador de errores REAL) carga todas las rutas, que usan el resto de las exportaciones de estos módulos: sólo
// se reemplazan los dos candados, el resto queda como está.
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: () => (_q: any, _s: any, n: any) => n(),
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkFeatureAccess.middleware'),
  checkFeatureAccess: () => (_q: any, _s: any, n: any) => n(),
}))
const mockConnect = {
  startShopifyConnect: jest.fn(),
  listIntentLocations: jest.fn(),
  confirmShopifyConnect: jest.fn(),
  getConnectReview: jest.fn(),
  requestApplyShopifyConnect: jest.fn(),
  saveConnectChoices: jest.fn(),
  disconnectShopify: jest.fn(),
}
// C3: `@/app` monta el callback con `SHOPIFY_OAUTH_CALLBACK_PATH` de este módulo; las constantes quedan reales.
jest.mock('@/services/commerce-channels/shopify/shopify.connect.service', () => ({
  ...jest.requireActual('@/services/commerce-channels/shopify/shopify.connect.service'),
  ...mockConnect,
}))
const mockOverview = {
  getShopifyOverview: jest.fn(),
  listShopifyReviews: jest.fn(),
  getShopifyReviewEnvios: jest.fn(),
  listShopifyIssues: jest.fn(),
}
jest.mock('@/services/commerce-channels/shopify/shopify.overview.service', () => mockOverview)
const mockReconcile = { resolveShopifyReview: jest.fn() }
jest.mock('@/services/commerce-channels/shopify/shopify.reconcile.service', () => mockReconcile)
const mockPanel = { requestShopifyResync: jest.fn(), reauthorizeShopDomain: jest.fn(), getShopifyReviewPreview: jest.fn() }
jest.mock('@/services/commerce-channels/shopify/shopify.dashboard.service', () => mockPanel)

import { globalErrorHandler } from '@/app'
import { MAX_ELECCIONES } from '@/services/commerce-channels/shopify/shopify.connect.service'
import shopifyRouter from '@/routes/dashboard/shopify.routes'

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  ;(req as any).authContext = { userId: 'u1', venueId: 'v1', role: 'ADMIN' }
  next()
})
app.use('/venues/:venueId/shopify', shopifyRouter)
app.use(globalErrorHandler)
const B = '/venues/v1/shopify'
const INTENT = 'intent-firmado-0123456789'
const RESOLVER = { choice: 'AVOQADO', expectedAvoqadoQty: '5', expectedShopifyQty: 4 }

beforeEach(() => jest.clearAllMocks())

describe('controller de Shopify: lo que llega a los servicios y lo que vuelve', () => {
  it('el resumen se envuelve en { success, data }', async () => {
    mockOverview.getShopifyOverview.mockResolvedValue({ planActive: true, connection: null })
    const r = await request(app).get(`${B}/`)
    expect(r.body).toEqual({ success: true, data: { planActive: true, connection: null } })
    expect(mockOverview.getShopifyOverview).toHaveBeenCalledWith('v1')
  })

  it('conectar: dominio limpio, quién lo pidió y propósito CONNECT', async () => {
    mockConnect.startShopifyConnect.mockResolvedValue({ url: 'https://x/authorize' })
    const r = await request(app).post(`${B}/connect/start`).send({ shopDomain: '  Mi-Tienda.myshopify.com ' })
    expect(r.body.data).toEqual({ url: 'https://x/authorize' })
    expect(mockConnect.startShopifyConnect).toHaveBeenCalledWith({
      venueId: 'v1',
      authUserId: 'u1',
      shopDomain: 'mi-tienda.myshopify.com',
      purpose: 'CONNECT',
    })
  })

  it('reautorizar: la MISMA tienda de la conexión, propósito REAUTHORIZE', async () => {
    mockPanel.reauthorizeShopDomain.mockResolvedValue('mi-tienda.myshopify.com')
    mockConnect.startShopifyConnect.mockResolvedValue({ url: 'https://x/authorize' })
    await request(app).post(`${B}/reauthorize/start`).send({})
    expect(mockPanel.reauthorizeShopDomain).toHaveBeenCalledWith('v1')
    expect(mockConnect.startShopifyConnect).toHaveBeenCalledWith({
      venueId: 'v1',
      authUserId: 'u1',
      shopDomain: 'mi-tienda.myshopify.com',
      purpose: 'REAUTHORIZE',
    })
  })

  it('reautorizar sin conexión: el 409 SHOPIFY_REAUTORIZAR_SIN_TIENDA llega tal cual y no se empieza nada (L9)', async () => {
    mockPanel.reauthorizeShopDomain.mockRejectedValue(
      new ConflictError('Esta sucursal no está conectada a una tienda; usa «Conectar»', 'SHOPIFY_REAUTORIZAR_SIN_TIENDA'),
    )
    const r = await request(app).post(`${B}/reauthorize/start`).send({})
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('SHOPIFY_REAUTORIZAR_SIN_TIENDA')
    expect(mockConnect.startShopifyConnect).not.toHaveBeenCalled()
  })

  it('🔴 confirmar NO acepta el nombre de la ubicación: lo pone el servidor desde Shopify (Codex #22)', async () => {
    const malo = await request(app)
      .post(`${B}/connect/confirm`)
      .send({ intent: INTENT, locationId: 'gid://shopify/Location/1', locationName: 'Inventado' })
    expect(malo.status).toBe(400)
    expect(malo.body.message).toMatch(/Hay un campo que no se esperaba/)
    expect(mockConnect.confirmShopifyConnect).not.toHaveBeenCalled()
    mockConnect.confirmShopifyConnect.mockResolvedValue({ locationLinkId: 'l1' })
    await request(app).post(`${B}/connect/confirm`).send({ intent: INTENT, locationId: 'gid://shopify/Location/1' })
    expect(mockConnect.confirmShopifyConnect).toHaveBeenCalledWith({
      venueId: 'v1',
      authUserId: 'u1',
      intent: INTENT,
      locationId: 'gid://shopify/Location/1',
    })
  })

  it('una ubicación que no es un GID de Shopify se rechaza antes del servicio', async () => {
    const r = await request(app).post(`${B}/connect/confirm`).send({ intent: INTENT, locationId: '1' })
    expect(r.status).toBe(400)
    expect(mockConnect.confirmShopifyConnect).not.toHaveBeenCalled()
  })

  it('🔴 el negocio sale de la URL: un venueId en el body se rechaza y nunca llega a los servicios (L11)', async () => {
    const cuerpos: Array<[string, object]> = [
      ['connect/start', { shopDomain: 'mi-tienda.myshopify.com', venueId: 'otro' }],
      ['connect/confirm', { intent: INTENT, locationId: 'gid://shopify/Location/1', venueId: 'otro' }],
      ['reviews/r1/resolve', { ...RESOLVER, venueId: 'otro' }],
    ]
    for (const [ruta, body] of cuerpos) {
      const r = await request(app).post(`${B}/${ruta}`).send(body)
      expect(r.status).toBe(400)
    }
    expect(mockConnect.startShopifyConnect).not.toHaveBeenCalled()
    expect(mockConnect.confirmShopifyConnect).not.toHaveBeenCalled()
    expect(mockReconcile.resolveShopifyReview).not.toHaveBeenCalled()
  })

  it('la vista previa de conexión: página acotada a 50 y filtro CAMBIAN de fábrica', async () => {
    expect((await request(app).get(`${B}/connect/review?limit=500`)).status).toBe(400)
    mockConnect.getConnectReview.mockResolvedValue({ items: [], total: 0, nextOffset: null, resumen: {} })
    await request(app).get(`${B}/connect/review?offset=20`)
    expect(mockConnect.getConnectReview).toHaveBeenCalledWith({ venueId: 'v1', offset: 20, limit: 20, filtro: 'CAMBIAN' })
  })

  it('las listas pasan búsqueda y motivo del servidor, con offset y límite ya como número; un motivo inventado es 400 en español (Z9, L10)', async () => {
    mockOverview.listShopifyReviews.mockResolvedValue({ items: [], total: 0, nextOffset: null })
    mockOverview.listShopifyIssues.mockResolvedValue({ items: [], total: 0, nextOffset: null })
    await request(app).get(`${B}/reviews?q=camisa`)
    expect(mockOverview.listShopifyReviews).toHaveBeenCalledWith('v1', { offset: 0, limit: 20, q: 'camisa' })
    await request(app).get(`${B}/reviews?offset=10&limit=5`)
    expect(mockOverview.listShopifyReviews).toHaveBeenLastCalledWith('v1', { offset: 10, limit: 5, q: undefined })
    await request(app).get(`${B}/issues?reason=SIN_SKU&offset=40`)
    expect(mockOverview.listShopifyIssues).toHaveBeenCalledWith('v1', { offset: 40, limit: 20, q: undefined, reason: 'SIN_SKU' })
    const mal = await request(app).get(`${B}/issues?reason=NOPE`)
    expect(mal.status).toBe(400)
    expect(mal.body.message).toMatch(/Motivo no reconocido/)
    for (const q of ['limit=0', 'limit=51', 'limit=abc', 'offset=-1', 'limit=1.5', 'offset=100001']) {
      expect((await request(app).get(`${B}/reviews?${q}`)).status).toBe(400)
    }
    // El tope de B (OFFSET_MAX = 100_000) es el último valor válido; uno más es 400, no un recorte en silencio.
    expect((await request(app).get(`${B}/reviews?offset=100000`)).status).toBe(200)
    expect(mockOverview.listShopifyReviews).toHaveBeenLastCalledWith('v1', { offset: 100000, limit: 20, q: undefined })
    expect(mockOverview.listShopifyReviews).toHaveBeenCalledTimes(3)
    expect(mockOverview.listShopifyIssues).toHaveBeenCalledTimes(1)
  })

  it('🔴 el sondeo de las elecciones en camino: ids sin repetir y como máximo 50; vacío o de más es 400 (R2-4)', async () => {
    mockOverview.getShopifyReviewEnvios.mockResolvedValue({ items: [] })
    const r = await request(app).get(`${B}/reviews/envios?ids=r1,r2,r1`)
    expect(r.body).toEqual({ success: true, data: { items: [] } })
    expect(mockOverview.getShopifyReviewEnvios).toHaveBeenCalledWith('v1', ['r1', 'r2'])
    const muchos = Array.from({ length: 51 }, (_, n) => `r${n}`).join(',')
    expect((await request(app).get(`${B}/reviews/envios?ids=${muchos}`)).status).toBe(400)
    expect((await request(app).get(`${B}/reviews/envios?ids=`)).status).toBe(400)
    expect((await request(app).get(`${B}/reviews/envios`)).status).toBe(400)
    // El parámetro repetido llega como arreglo: mensaje en español, no el de Zod.
    const repetido = await request(app).get(`${B}/reviews/envios?ids=r1&ids=r2`)
    expect(repetido.status).toBe(400)
    expect(repetido.body.message).toMatch(/separadas por comas/)
    expect(mockOverview.getShopifyReviewEnvios).toHaveBeenCalledTimes(1)
  })

  it('resolver manda la elección con las cantidades que se VIERON y quién eligió', async () => {
    mockReconcile.resolveShopifyReview.mockResolvedValue({ estado: 'ENVIO_PENDIENTE' })
    const r = await request(app).post(`${B}/reviews/r1/resolve`).send(RESOLVER)
    expect(r.body).toEqual({ success: true, data: { estado: 'ENVIO_PENDIENTE' } })
    expect(mockReconcile.resolveShopifyReview).toHaveBeenCalledWith({ venueId: 'v1', reviewId: 'r1', ...RESOLVER, staffId: 'u1' })
  })

  it('resolver con cantidades mal formadas: 400 sin tocar el servicio', async () => {
    for (const body of [{ ...RESOLVER, expectedShopifyQty: 4.5 }, { ...RESOLVER, expectedAvoqadoQty: 'cinco' }, { choice: 'AVOQADO' }]) {
      expect((await request(app).post(`${B}/reviews/r1/resolve`).send(body)).status).toBe(400)
    }
    expect(mockReconcile.resolveShopifyReview).not.toHaveBeenCalled()
  })

  it.each([
    ['409 cambió', new ConflictError('Las cantidades cambiaron; vuelve a revisar.', 'SHOPIFY_REVISION_CAMBIO'), 409],
    ['409 en camino', new ConflictError('Todavía hay cambios en camino.', 'SHOPIFY_CAMBIOS_EN_CAMINO'), 409],
    ['422 no entera', new ValidationError('Shopify sólo cuenta piezas enteras.', 'SHOPIFY_DIFERENCIA_NO_ENTERA'), 422],
  ])('🔴 resolver: %s llega con su código y su mensaje en español', async (_c, error, status) => {
    mockReconcile.resolveShopifyReview.mockRejectedValue(error)
    const r = await request(app).post(`${B}/reviews/r1/resolve`).send(RESOLVER)
    expect(r.status).toBe(status)
    expect(r.body).toEqual({ message: (error as Error).message, code: (error as ConflictError).code })
  })

  it('conectar una tienda fuera del piloto: 409 SHOPIFY_SOLO_PILOTO', async () => {
    mockConnect.startShopifyConnect.mockRejectedValue(new ConflictError('Por ahora sólo tiendas del piloto.', 'SHOPIFY_SOLO_PILOTO'))
    const r = await request(app).post(`${B}/connect/start`).send({ shopDomain: 'otra.myshopify.com' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('SHOPIFY_SOLO_PILOTO')
  })

  const VISTA = { linkId: 'l1', generation: 1, tokenVersion: 1 }
  const UNA = { variantLinkId: 'vl1', choice: 'AVOQADO', expectedAvoqadoQty: '5', expectedShopifyQty: 6 }

  it('D1: guardar elecciones manda la conexión vista y las elecciones, con el negocio de la ruta y quién eligió', async () => {
    mockConnect.saveConnectChoices.mockResolvedValue({ guardadas: 1, porDecidir: 2 })
    const r = await request(app)
      .post(`${B}/connect/choices`)
      .send({ vista: VISTA, elecciones: [UNA] })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: true, data: { guardadas: 1, porDecidir: 2 } })
    expect(mockConnect.saveConnectChoices).toHaveBeenCalledWith({
      venueId: 'v1',
      staffId: 'u1',
      vista: VISTA,
      elecciones: [UNA],
      todos: undefined,
    })
  })

  it('D1: «en todos» viaja por la misma ruta', async () => {
    mockConnect.saveConnectChoices.mockResolvedValue({ guardadas: 30, porDecidir: 0 })
    await request(app).post(`${B}/connect/choices`).send({ vista: VISTA, todos: 'SHOPIFY' })
    expect(mockConnect.saveConnectChoices).toHaveBeenCalledWith({
      venueId: 'v1',
      staffId: 'u1',
      vista: VISTA,
      elecciones: undefined,
      todos: 'SHOPIFY',
    })
  })

  it('🔴 D1: el negocio sale de la URL; un venueId en el body se rechaza y quién eligió sale de la sesión, no del body', async () => {
    const r = await request(app).post(`${B}/connect/choices`).send({ vista: VISTA, todos: 'AVOQADO', venueId: 'otro', staffId: 'otro' })
    expect(r.status).toBe(400)
    expect(mockConnect.saveConnectChoices).not.toHaveBeenCalled()
  })

  it.each([
    ['sin la conexión vista', { elecciones: [UNA] }, 'Falta la conexión que viste'],
    ['las dos cosas a la vez', { vista: VISTA, elecciones: [UNA], todos: 'AVOQADO' }, 'no las dos'],
    ['ninguna', { vista: VISTA }, 'ni ninguna'],
    // Una lista vacía sin `todos` llegaba al servicio y reventaba como un 500 (`Prisma.join([])`): la guarda es la forma.
    ['sin elecciones', { vista: VISTA, elecciones: [] }, 'Elige al menos un producto'],
    ['una lista vacía aunque venga «en todos»', { vista: VISTA, elecciones: [], todos: 'AVOQADO' }, 'Elige al menos un producto'],
    ['una lista que no es lista', { vista: VISTA, elecciones: UNA }, 'Las elecciones van en una lista'],
    ['«en todos» con una opción que no existe', { vista: VISTA, todos: 'AMBOS' }, 'Elige Avoqado o Shopify para todos'],
    [
      'más de 50',
      { vista: VISTA, elecciones: Array.from({ length: 51 }, (_, n) => ({ ...UNA, variantLinkId: `vl${n}` })) },
      'Máximo 50 productos por vez',
    ],
    ['una opción que no existe', { vista: VISTA, elecciones: [{ ...UNA, choice: 'AMBOS' }] }, 'Elige Avoqado o Shopify'],
    ['sin lo que vio', { vista: VISTA, elecciones: [{ variantLinkId: 'vl1', choice: 'SHOPIFY' }] }, 'Faltan las cantidades que viste'],
    [
      'una cantidad fuera de rango',
      { vista: VISTA, elecciones: [{ ...UNA, expectedShopifyQty: 2 ** 60 }] },
      'La cantidad de Shopify no es válida',
    ],
    [
      'una cantidad con decimales',
      { vista: VISTA, elecciones: [{ ...UNA, expectedShopifyQty: 6.5 }] },
      'La cantidad de Shopify no es válida',
    ],
    ['una cantidad de Avoqado que no es texto', { vista: VISTA, elecciones: [{ ...UNA, expectedAvoqadoQty: 5 }] }, 'debe ir como texto'],
    ['un producto sin id', { vista: VISTA, elecciones: [{ ...UNA, variantLinkId: '' }] }, 'Falta el producto'],
    [
      'una conexión vista sin número de generación',
      { vista: { linkId: 'l1', tokenVersion: 1 }, todos: 'AVOQADO' },
      'Falta la conexión que viste',
    ],
    [
      'una conexión vista con una versión fuera de rango',
      { vista: { ...VISTA, tokenVersion: 2 ** 60 }, todos: 'AVOQADO' },
      'La conexión no es válida',
    ],
    ['una conexión vista sin id', { vista: { ...VISTA, linkId: '' }, todos: 'AVOQADO' }, 'Falta la conexión que viste'],
    ['un campo de más', { vista: VISTA, todos: 'AVOQADO', venueId: 'otro' }, 'Hay un campo que no se esperaba'],
    [
      'un campo de más dentro de una elección',
      { vista: VISTA, elecciones: [{ ...UNA, productId: 'p1' }] },
      'Hay un campo que no se esperaba',
    ],
  ])('D1: guardar con %s ⇒ 400 en español y el servicio ni se llama', async (_c, body, texto) => {
    const r = await request(app).post(`${B}/connect/choices`).send(body)
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain(texto)
    expect(mockConnect.saveConnectChoices).not.toHaveBeenCalled()
  })

  it('D1: el tope de la forma es el MISMO del servicio (MAX_ELECCIONES): exactamente el tope pasa, uno más no', async () => {
    mockConnect.saveConnectChoices.mockResolvedValue({ guardadas: MAX_ELECCIONES, porDecidir: 0 })
    const lista = (n: number) => Array.from({ length: n }, (_, k) => ({ ...UNA, variantLinkId: `vl${k}` }))
    expect(
      (
        await request(app)
          .post(`${B}/connect/choices`)
          .send({ vista: VISTA, elecciones: lista(MAX_ELECCIONES) })
      ).status,
    ).toBe(200)
    expect(
      (
        await request(app)
          .post(`${B}/connect/choices`)
          .send({ vista: VISTA, elecciones: lista(MAX_ELECCIONES + 1) })
      ).status,
    ).toBe(400)
    expect(mockConnect.saveConnectChoices).toHaveBeenCalledTimes(1)
  })

  it('D1: una pantalla vieja llega como 409 con su código; «Aplicar» con decisiones pendientes como 422', async () => {
    mockConnect.saveConnectChoices.mockRejectedValue(
      new ConflictError(
        'La conexión con Shopify cambió desde que viste la lista: vuelve a cargar la vista previa.',
        'SHOPIFY_CONEXION_CAMBIO',
      ),
    )
    const g = await request(app).post(`${B}/connect/choices`).send({ vista: VISTA, todos: 'AVOQADO' })
    expect(g.status).toBe(409)
    expect(g.body.code).toBe('SHOPIFY_CONEXION_CAMBIO')
    mockConnect.requestApplyShopifyConnect.mockRejectedValue(
      new ValidationError('Falta elegir en 2 productos qué número se queda.', 'SHOPIFY_FALTAN_DECISIONES'),
    )
    const r = await request(app).post(`${B}/connect/apply`).send({})
    expect(r.status).toBe(422)
    expect(r.body).toEqual({ message: 'Falta elegir en 2 productos qué número se queda.', code: 'SHOPIFY_FALTAN_DECISIONES' })
  })

  it('aplicar, desconectar y cuadrar devuelven su confirmación', async () => {
    mockConnect.requestApplyShopifyConnect.mockResolvedValue({ applyRequestedAt: new Date() })
    mockConnect.disconnectShopify.mockResolvedValue({ desconectada: true })
    mockPanel.requestShopifyResync.mockResolvedValue({ programado: true })
    expect((await request(app).post(`${B}/connect/apply`).send({})).body.data).toEqual({ solicitado: true })
    expect(mockConnect.requestApplyShopifyConnect).toHaveBeenCalledWith({ venueId: 'v1', staffId: 'u1' })
    expect((await request(app).post(`${B}/disconnect`).send({})).body.data).toEqual({ desconectado: true })
    expect(mockConnect.disconnectShopify).toHaveBeenCalledWith({ venueId: 'v1', staffId: 'u1' })
    expect((await request(app).post(`${B}/resync`).send({})).body.data).toEqual({ programado: true })
    expect(mockPanel.requestShopifyResync).toHaveBeenCalledWith({ venueId: 'v1', staffId: 'u1' })
  })

  it('🔴 desconectar dice la verdad: si B no tenía nada que desconectar, `desconectado` es false (L17)', async () => {
    mockConnect.disconnectShopify.mockResolvedValue({ desconectada: false })
    const r = await request(app).post(`${B}/disconnect`).send({})
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: true, data: { desconectado: false } })
  })
})
