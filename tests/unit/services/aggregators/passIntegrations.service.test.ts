import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import * as registry from '@/services/aggregators/core/adapterRegistry'
import * as visitSvc from '@/services/aggregators/core/visit.service'
import * as sync from '@/services/aggregators/passSessionSync'
import * as basePlan from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import logger from '@/config/logger'
import { fakeAdapter } from './fakeAdapter'
import {
  connectTotalPass,
  disconnectPassProvider,
  getPassIntegrationsOverview,
  normalizePlans,
  sanitizeProviderError,
  setPassConfirmMode,
  setPassProductLinks,
} from '@/services/aggregators/passIntegrations.service'

jest.mock('@/config/env', () => ({ env: { ...jest.requireActual('@/config/env').env, BASE_URL: 'https://api.test.avoqado.io' } }))

const NOW = new Date('2030-01-10T12:00:00Z')
const conn = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  venueId: 'v1',
  provider: 'TOTALPASS',
  status: 'ACTIVE',
  externalPlaceName: 'Estudio Prueba',
  confirmMode: 'AUTO',
  lastError: null,
  config: { hasSlotConfirmation: true, plans: [{ id: '305', name: 'Gold', code: 'ABCD1234' }] },
  updatedAt: NOW,
  productLinks: [],
  ...over,
})
/** Una clase del venue como la lee `setPassProductLinks` (nombre, tipo y si está archivada). */
const cls = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Clase ${id}`, type: 'CLASS', deletedAt: null, ...over })
const p2002 = (target?: unknown) => Object.assign(new Error('unique'), { code: 'P2002', meta: { target } })

beforeEach(() => {
  prismaMock.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prismaMock) : arg))
  prismaMock.aggregatorConnection.updateMany.mockResolvedValue({ count: 1 })
  // Releída dentro de la transacción de guardar ligas: sigue ACTIVE salvo que la prueba diga otra cosa.
  prismaMock.aggregatorConnection.findFirst.mockReset()
  prismaMock.aggregatorConnection.findFirst.mockResolvedValue({ id: 'c1' } as any)
  // Ligas activas que lee la transacción de guardar ligas: ninguna, salvo que la prueba diga otra cosa.
  prismaMock.aggregatorProductLink.findMany.mockResolvedValue([])
  jest.spyOn(sync, 'enqueueHorizonSessionsSync').mockResolvedValue(0)
  jest.spyOn(sync, 'enqueueLiveSessionsSync').mockResolvedValue(0)
})
afterEach(() => jest.restoreAllMocks())

describe('normalizePlans / sanitizeProviderError', () => {
  // nuevo
  it('planes: sólo id (texto), nombre y código; descarta basura', () => {
    expect(normalizePlans([{ id: 3, name: 'Gold', code: 'X', placeApiKey: 'no' }, { name: 'sin id' }, null])).toEqual([
      { id: '3', name: 'Gold', code: 'X' },
    ])
  })
  // nuevo — P1-7
  it('el error del proveedor nunca guarda URLs (la del webhook lleva el secreto) y se acota', () => {
    const out = sanitizeProviderError(
      'HTTP_400: bad webhook_url https://api.x/api/v1/webhooks/aggregators/totalpass/SECRETO123/booking ' + 'x'.repeat(500),
    )
    expect(out).not.toMatch(/SECRETO123|https?:/)
    expect(out.length).toBeLessThanOrEqual(300)
  })
  // nuevo — ronda 1, H3: el token también puede venir sin esquema o en JSON con barras escapadas
  it('tapa el token del webhook aunque venga como ruta suelta o en JSON escapado', () => {
    const tok = 'Ab_cd-EF0123456789'
    const out = sanitizeProviderError(`HTTP_422: {"url":"https:\\/\\/x\\/${tok}"} ruta /totalpass/${tok}/booking`, tok)
    expect(out).not.toContain(tok)
    expect(out).toContain('<secreto>')
  })
})

describe('getPassIntegrationsOverview', () => {
  beforeEach(() => jest.spyOn(basePlan, 'venueHasFeatureAccess').mockResolvedValue(true))
  afterEach(() => jest.restoreAllMocks())

  // nuevo — R62 (pausa suave): el dashboard sabe si el plan sigue incluyendo los pases; sin él, el contenido no cambia
  it.each([true, false])('planActive = %s según el acceso a AGGREGATOR_PASSES (una sola consulta)', async hasPlan => {
    const access = jest.spyOn(basePlan, 'venueHasFeatureAccess').mockResolvedValue(hasPlan)
    prismaMock.aggregatorConnection.findMany.mockResolvedValueOnce([conn()] as any)
    prismaMock.product.findMany.mockResolvedValueOnce([{ id: 'p1', name: 'Yoga' }] as any)
    prismaMock.product.count.mockResolvedValueOnce(1)
    const o = await getPassIntegrationsOverview('v1')
    expect(o.planActive).toBe(hasPlan)
    expect(access).toHaveBeenCalledTimes(1)
    expect(access).toHaveBeenCalledWith('v1', 'AGGREGATOR_PASSES')
    expect(o.connections[0]).toMatchObject({ provider: 'TOTALPASS', status: 'ACTIVE', externalPlaceName: 'Estudio Prueba' })
    expect(o.classProducts).toEqual({ items: [{ id: 'p1', name: 'Yoga' }], total: 1 })
  })

  // nuevo
  it('devuelve TOTALPASS y WELLHUB sin secretos y las clases del venue acotadas', async () => {
    prismaMock.aggregatorConnection.findMany.mockResolvedValueOnce([
      conn({ productLinks: [{ productId: 'p1', externalPlanId: '305', product: { name: 'Yoga', type: 'CLASS', deletedAt: null } }] }),
    ] as any)
    prismaMock.product.findMany.mockResolvedValueOnce([{ id: 'p1', name: 'Yoga' }] as any)
    prismaMock.product.count.mockResolvedValueOnce(1)
    const o = await getPassIntegrationsOverview('v1')
    expect(o.connections.map(c => c.provider)).toEqual(['TOTALPASS', 'WELLHUB'])
    expect(o.connections[0]).toMatchObject({ available: true, status: 'ACTIVE', externalPlaceName: 'Estudio Prueba' })
    expect(o.connections[0].productLinks).toEqual([
      { productId: 'p1', productName: 'Yoga', externalPlanId: '305', externalPlanName: 'Gold', productArchived: false },
    ])
    expect(o.connections[1]).toMatchObject({ available: false, status: null })
    expect(prismaMock.aggregatorConnection.findMany.mock.calls[0][0].select).not.toHaveProperty('credentialCiphertext')
    expect(prismaMock.aggregatorConnection.findMany.mock.calls[0][0].select).not.toHaveProperty('webhookToken')
    expect(prismaMock.product.findMany.mock.calls[0][0]).toMatchObject({
      where: { venueId: 'v1', type: 'CLASS', deletedAt: null },
      take: 200,
    })
  })

  // C9 (P2-10) — una liga a una clase archivada (o que ya no es CLASS) se VE, marcada, para poder quitarla: ocultarla la dejaba
  // activa y publicando sin forma de desligarla desde el dashboard.
  it('muestra todas las ligas activas y marca las de clases archivadas o que ya no son clase', async () => {
    prismaMock.aggregatorConnection.findMany.mockResolvedValueOnce([
      conn({
        productLinks: [
          { productId: 'p1', externalPlanId: '305', product: { name: 'Yoga', type: 'CLASS', deletedAt: null } },
          { productId: 'p2', externalPlanId: '305', product: { name: 'Spinning', type: 'CLASS', deletedAt: new Date('2030-01-01') } },
          { productId: 'p3', externalPlanId: '305', product: { name: 'Toalla', type: 'REGULAR', deletedAt: null } },
        ],
      }),
    ] as any)
    prismaMock.product.findMany.mockResolvedValueOnce([] as any)
    prismaMock.product.count.mockResolvedValueOnce(0)
    const o = await getPassIntegrationsOverview('v1')
    const select = prismaMock.aggregatorConnection.findMany.mock.calls[0][0].select.productLinks
    expect(select.where).toEqual({ active: true })
    expect(select.select.product).toEqual({ select: { name: true, type: true, deletedAt: true } })
    expect(o.connections[0].productLinks.map(l => [l.productId, l.productArchived])).toEqual([
      ['p1', false],
      ['p2', true],
      ['p3', true],
    ])
  })
})

describe('connectTotalPass', () => {
  // nuevo — Review Focus 1
  it('recorta la llave, reserva la sucursal ANTES de suscribir webhooks y queda ACTIVE con los planes', async () => {
    const a = fakeAdapter({
      setup: jest.fn().mockResolvedValue({
        ok: true,
        externalPlaceId: 'place-1',
        externalPlaceName: 'Estudio Prueba',
        data: { plans: [{ id: 305, name: 'Gold', code: 'ABCD1234' }] },
      }),
    })
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(conn() as any)
    prismaMock.aggregatorConnection.upsert.mockResolvedValueOnce({ id: 'c1', webhookToken: 'tokNuevo' } as any)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([])
    const view = await connectTotalPass('v1', '  11111111-2222-4333-8444-555555555555 \n', 's1')
    expect((a.identify as jest.Mock).mock.calls[0][0].credential).toBe('11111111-2222-4333-8444-555555555555')
    const up = prismaMock.aggregatorConnection.upsert.mock.calls[0][0]
    expect(up.create).toMatchObject({ venueId: 'v1', provider: 'TOTALPASS', externalPlaceId: 'place-1', status: 'PENDING' })
    expect(up.update).toMatchObject({ externalPlaceId: 'place-1', status: 'PENDING' })
    expect(prismaMock.aggregatorConnection.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      (a.setup as jest.Mock).mock.invocationCallOrder[0],
    )
    expect((a.setup as jest.Mock).mock.calls[0][1].booking).toBe(
      'https://api.test.avoqado.io/api/v1/webhooks/aggregators/totalpass/tokNuevo/booking',
    )
    // revisión final — F2: sólo activa la conexión que sigue PENDING (nadie la desconectó a la mitad)
    expect(prismaMock.aggregatorConnection.updateMany.mock.calls[0][0].where).toEqual({ id: 'c1', status: 'PENDING' })
    expect(prismaMock.aggregatorConnection.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'ACTIVE',
      externalPlaceName: 'Estudio Prueba',
      lastError: null,
      config: { hasSlotConfirmation: true, plans: [{ id: '305', name: 'Gold', code: 'ABCD1234' }] },
    })
    expect(view.status).toBe('ACTIVE')
    expect(JSON.stringify((logAction as jest.Mock).mock.calls)).not.toMatch(/11111111-2222/)
  })
  // revisión final — F2: un desconectar forzado mientras corría `setup` no se revive como ACTIVE sin llave ni sucursal
  it('la conexión dejó de estar PENDING durante setup ⇒ 409 PASS_CONNECT_INTERRUPTED, sin re-publicar ni dejar rastro', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        setup: jest.fn().mockResolvedValue({ ok: true, externalPlaceId: 'place-1', externalPlaceName: 'X', data: { plans: [] } }),
      }),
    )
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(null)
    prismaMock.aggregatorConnection.upsert.mockResolvedValueOnce({ id: 'c1', webhookToken: 'tok' } as any)
    prismaMock.aggregatorConnection.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(connectTotalPass('v1', 'llave-ok-0000', 's1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PASS_CONNECT_INTERRUPTED',
      // C4 (P3-21): neutral — la otra solicitud pudo haberla desconectado o simplemente activado
      message: 'La conexión cambió mientras se conectaba. Recarga y vuelve a intentar.',
    })
    expect(prismaMock.aggregatorProductLink.findMany).not.toHaveBeenCalled()
    expect(sync.enqueueHorizonSessionsSync).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
  // nuevo — P1-2: un reintento del mismo venue no rota el secreto
  it('reconectar la MISMA sucursal reutiliza el token del webhook', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        setup: jest.fn().mockResolvedValue({ ok: true, externalPlaceId: 'place-1', externalPlaceName: 'X', data: { plans: [] } }),
      }),
    )
    prismaMock.aggregatorConnection.findUnique
      .mockResolvedValueOnce({ id: 'c1', externalPlaceId: 'place-1', webhookToken: 'tokViejo' } as any)
      .mockResolvedValueOnce(conn() as any)
    prismaMock.aggregatorConnection.upsert.mockResolvedValueOnce({ id: 'c1', webhookToken: 'tokViejo' } as any)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([])
    const a = registry.adapterFor('TOTALPASS')
    await connectTotalPass('v1', 'llave-ok-0000', 's1')
    const up = prismaMock.aggregatorConnection.upsert.mock.calls[0][0]
    expect(up.create.webhookToken).toBe('tokViejo')
    // ronda 1, H2: el update nunca reescribe el token guardado; la URL sale del que quedó en la fila
    expect(up.update).not.toHaveProperty('webhookToken')
    expect((a.setup as jest.Mock).mock.calls[0][1].booking).toMatch(/\/totalpass\/tokViejo\/booking$/)
  })
  // C4 (P1-4) — «volver a pegar la llave» en una conexión sana no la apaga: un fallo transitorio de setup la dejaba PENDING
  // y el worker dejaba de validar. Sigue ACTIVE con la credencial anterior y el error se devuelve tal cual.
  describe('conexión ACTIVE de la MISMA sucursal (refrescar)', () => {
    const active = () =>
      prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce({
        id: 'c1',
        status: 'ACTIVE',
        externalPlaceId: 'place-1',
        webhookToken: 'tokViejo',
      } as any)

    it('setup falla (503) ⇒ sigue ACTIVE con la credencial vieja: no la pasa a PENDING ni la reescribe', async () => {
      jest
        .spyOn(registry, 'adapterFor')
        .mockReturnValue(
          fakeAdapter({ setup: jest.fn().mockResolvedValue({ ok: false, retryable: true, code: 'HTTP_503', message: 'caído' }) }),
        )
      active()
      await expect(connectTotalPass('v1', 'llave-nueva-0000', 's1')).rejects.toMatchObject({
        statusCode: 503,
        message: 'TotalPass no respondió. Intenta de nuevo en unos minutos.',
      })
      expect(prismaMock.aggregatorConnection.upsert).not.toHaveBeenCalled()
      expect(prismaMock.aggregatorConnection.update).not.toHaveBeenCalled()
      expect(prismaMock.aggregatorConnection.updateMany).not.toHaveBeenCalled()
    })

    it('setup sale bien ⇒ promueve credencial, planes y nombre sobre la misma ACTIVE (con candado) y re-publica', async () => {
      const a = fakeAdapter({
        setup: jest.fn().mockResolvedValue({
          ok: true,
          externalPlaceId: 'place-1',
          externalPlaceName: 'Estudio Prueba',
          data: { plans: [{ id: 306, name: 'Silver', code: 'EFGH5678' }] },
        }),
      })
      jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
      active()
      prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn() as any)
      prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([{ productId: 'p1' }] as any)
      await connectTotalPass('v1', 'llave-nueva-0000', 's1')
      expect(prismaMock.aggregatorConnection.upsert).not.toHaveBeenCalled()
      expect((a.setup as jest.Mock).mock.calls[0][0]).toMatchObject({ id: 'c1', credential: 'llave-nueva-0000' })
      expect((a.setup as jest.Mock).mock.calls[0][1].booking).toMatch(/\/totalpass\/tokViejo\/booking$/)
      const promote = prismaMock.aggregatorConnection.updateMany.mock.calls[0][0]
      expect(promote.where).toEqual({ id: 'c1', status: 'ACTIVE', externalPlaceId: 'place-1' })
      expect(promote.data).toMatchObject({
        externalPlaceName: 'Estudio Prueba',
        lastError: null,
        config: { hasSlotConfirmation: true, plans: [{ id: '306', name: 'Silver', code: 'EFGH5678' }] },
      })
      expect(promote.data.credentialCiphertext).toBeInstanceOf(Buffer)
      expect(promote.data).not.toHaveProperty('status')
      expect(sync.enqueueHorizonSessionsSync).toHaveBeenCalledWith(expect.anything(), 'v1', ['p1'], expect.any(Date))
    })

    it('la desconectaron mientras corría setup ⇒ 409 neutral, sin re-publicar', async () => {
      jest.spyOn(registry, 'adapterFor').mockReturnValue(
        fakeAdapter({
          setup: jest.fn().mockResolvedValue({ ok: true, externalPlaceId: 'place-1', externalPlaceName: 'X', data: { plans: [] } }),
        }),
      )
      active()
      prismaMock.aggregatorConnection.updateMany.mockResolvedValueOnce({ count: 0 })
      await expect(connectTotalPass('v1', 'llave-nueva-0000', 's1')).rejects.toMatchObject({
        statusCode: 409,
        code: 'PASS_CONNECT_INTERRUPTED',
        message: 'La conexión cambió mientras se conectaba. Recarga y vuelve a intentar.',
      })
      expect(sync.enqueueHorizonSessionsSync).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })
  })
  // nuevo — P1-3
  it('un negocio ya conectado a OTRA sucursal ⇒ 409 sin tocar nada', async () => {
    const a = fakeAdapter({ identify: jest.fn().mockResolvedValue({ ok: true, externalPlaceId: 'place-2', externalPlaceName: 'Otra' }) })
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce({ id: 'c1', externalPlaceId: 'place-1', webhookToken: 't' } as any)
    await expect(connectTotalPass('v1', 'llave-otra-0000', 's1')).rejects.toMatchObject({ statusCode: 409, code: 'PASS_OTHER_PLACE' })
    expect(prismaMock.aggregatorConnection.upsert).not.toHaveBeenCalled()
    expect(a.setup).not.toHaveBeenCalled()
  })
  // nuevo — Review Focus 1
  it('llave rechazada ⇒ 400 en español, sin crear la conexión ni tocar webhooks', async () => {
    const a = fakeAdapter({
      identify: jest
        .fn()
        .mockResolvedValue({ ok: false, retryable: false, code: 'UNAUTHORIZED', message: 'TotalPass rechazó las llaves (401)' }),
    })
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    await expect(connectTotalPass('v1', 'llave-mala-0000', 's1')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/TotalPass no reconoce esa llave/),
    })
    expect(prismaMock.aggregatorConnection.upsert).not.toHaveBeenCalled()
    expect(a.setup).not.toHaveBeenCalled()
  })
  // nuevo — P1-2 / P1-3 de Codex al Plan 1: otra sucursal ⇒ el índice único frena ANTES de los webhooks
  it('la sucursal ya está ligada a OTRO negocio (P2002 al reservarla) ⇒ 409 y setup nunca corre', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(null)
    prismaMock.aggregatorConnection.upsert.mockRejectedValueOnce(p2002(['provider', 'externalPlaceId']))
    await expect(connectTotalPass('v1', 'llave-ok-0000', 's1')).rejects.toMatchObject({ statusCode: 409, code: 'PASS_PLACE_TAKEN' })
    expect(a.setup).not.toHaveBeenCalled()
  })
  // nuevo — ronda 1, H2: Prisma da el índice como columnas o como nombre; las dos formas cuentan
  it.each([
    ['nombre del índice de la sucursal', 'AggregatorConnection_provider_externalPlaceId_key', 'PASS_PLACE_TAKEN'],
    ['columnas del negocio', ['venueId', 'provider'], 'PASS_CONNECT_IN_PROGRESS'],
    ['nombre del índice del negocio', 'AggregatorConnection_venueId_provider_key', 'PASS_CONNECT_IN_PROGRESS'],
  ])('P2002 por %s ⇒ %s', async (_l, target, code) => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(null)
    prismaMock.aggregatorConnection.upsert.mockRejectedValueOnce(p2002(target))
    await expect(connectTotalPass('v1', 'llave-ok-0000', 's1')).rejects.toMatchObject({ statusCode: 409, code })
    expect(a.setup).not.toHaveBeenCalled()
  })
  // nuevo — P1-7
  it('setup falla ⇒ guarda el motivo SANEADO en la conexión y responde 503', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        setup: jest.fn().mockResolvedValue({
          ok: false,
          retryable: true,
          code: 'HTTP_503',
          message: 'caído https://api.x/webhooks/aggregators/totalpass/SECRETO/booking',
        }),
      }),
    )
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(null)
    prismaMock.aggregatorConnection.upsert.mockResolvedValueOnce({ id: 'c1', webhookToken: 't' } as any)
    await expect(connectTotalPass('v1', 'llave-ok-0000', 's1')).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringMatching(/TotalPass no respondió/),
    })
    const saved = prismaMock.aggregatorConnection.update.mock.calls[0][0].data.lastError as string
    expect(saved).toMatch(/^HTTP_503: /)
    expect(saved).not.toMatch(/SECRETO/)
  })
  // nuevo — ronda 1, H3 + H5: un 4xx que no es 401 sí es respuesta de TotalPass; ni el error ni lastError llevan el token
  it('setup con un 4xx ⇒ 400 «TotalPass rechazó la conexión» y el token tapado en el mensaje y en lastError', async () => {
    const tok = 'TOKsecreto_0123456789'
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        setup: jest.fn().mockResolvedValue({
          ok: false,
          retryable: false,
          code: 'HTTP_422',
          message: `TotalPass HTTP 422: {"webhook_url":"https:\\/\\/api.x\\/totalpass\\/${tok}\\/booking"} /totalpass/${tok}/booking`,
        }),
      }),
    )
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(null)
    prismaMock.aggregatorConnection.upsert.mockResolvedValueOnce({ id: 'c1', webhookToken: tok } as any)
    const err = await connectTotalPass('v1', 'llave-ok-0000', 's1').catch(e => e)
    expect(err).toMatchObject({
      statusCode: 400,
      code: 'PASS_PROVIDER_REJECTED',
      message: expect.stringMatching(/^TotalPass rechazó la conexión: /),
    })
    expect(err.message).not.toContain(tok)
    const saved = prismaMock.aggregatorConnection.update.mock.calls[0][0].data.lastError as string
    expect(saved).toMatch(/^HTTP_422: /)
    expect(saved).not.toContain(tok)
  })
  // revisión final — F4: si TotalPass repite la llave pegada en su error, no sale ni en el mensaje ni en lastError
  it('un 4xx del proveedor que repite la place_api_key ⇒ la llave tapada en el mensaje y en lastError', async () => {
    const llave = '99999999-8888-4777-8666-555555555555'
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        setup: jest
          .fn()
          .mockResolvedValue({ ok: false, retryable: false, code: 'HTTP_422', message: `place_api_key ${llave} sin permisos` }),
      }),
    )
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(null)
    prismaMock.aggregatorConnection.upsert.mockResolvedValueOnce({ id: 'c1', webhookToken: 'tok' } as any)
    const err = await connectTotalPass('v1', `  ${llave} `, 's1').catch(e => e)
    expect(err).toMatchObject({ statusCode: 400, code: 'PASS_PROVIDER_REJECTED' })
    expect(err.message).not.toContain(llave)
    const saved = prismaMock.aggregatorConnection.update.mock.calls[0][0].data.lastError as string
    expect(saved).toMatch(/^HTTP_422: /)
    expect(saved).not.toContain(llave)
  })
  it('identify con un 4xx que repite la llave ⇒ la llave tapada en el mensaje', async () => {
    const llave = '99999999-8888-4777-8666-555555555555'
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        identify: jest.fn().mockResolvedValue({ ok: false, retryable: false, code: 'HTTP_403', message: `llave ${llave} bloqueada` }),
      }),
    )
    const err = await connectTotalPass('v1', llave, 's1').catch(e => e)
    expect(err).toMatchObject({ statusCode: 400, code: 'PASS_PROVIDER_REJECTED' })
    expect(err.message).not.toContain(llave)
    expect(err.message).toContain('<secreto>')
  })
  // nuevo — ronda 1, H5
  it('falta la llave de integrador de Avoqado ⇒ 500 que pide avisar a soporte', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        identify: jest.fn().mockResolvedValue({ ok: false, retryable: true, code: 'PARTNER_KEY_MISSING', message: 'falta la llave' }),
      }),
    )
    await expect(connectTotalPass('v1', 'llave-ok-0000', 's1')).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringMatching(/llave de integrador de Avoqado/),
    })
    expect(prismaMock.aggregatorConnection.upsert).not.toHaveBeenCalled()
  })
  // nuevo — ronda 1, H5: TotalPass respondió, pero sin la sucursal
  it.each([
    ['identify responde sin sucursal', { ok: true, externalPlaceName: 'X' }],
    ['identify devuelve NO_PLACE_ID', { ok: false, retryable: false, code: 'NO_PLACE_ID', message: 'sin identificador' }],
  ])('%s ⇒ 503 PASS_PROVIDER_BAD_RESPONSE', async (_l, who) => {
    const a = fakeAdapter({ identify: jest.fn().mockResolvedValue(who) })
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    await expect(connectTotalPass('v1', 'llave-ok-0000', 's1')).rejects.toMatchObject({
      statusCode: 503,
      code: 'PASS_PROVIDER_BAD_RESPONSE',
      message: expect.stringMatching(/respondió sin los datos de la sucursal/),
    })
    expect(prismaMock.aggregatorConnection.upsert).not.toHaveBeenCalled()
    expect(a.setup).not.toHaveBeenCalled()
  })
})

describe('setPassProductLinks', () => {
  // nuevo
  it('liga clases del venue con planes existentes y encola publicarlas en el horizonte', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn() as any).mockResolvedValueOnce(conn() as any)
    prismaMock.product.findMany.mockResolvedValueOnce([cls('p1')] as any)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([])
    await setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'p1', externalPlanId: '305' }], 's1', NOW)
    expect(prismaMock.aggregatorProductLink.upsert.mock.calls[0][0]).toMatchObject({
      where: { connectionId_productId: { connectionId: 'c1', productId: 'p1' } },
      create: { connectionId: 'c1', venueId: 'v1', productId: 'p1', externalPlanId: '305', externalPlanCode: 'ABCD1234' },
      update: { externalPlanId: '305', externalPlanCode: 'ABCD1234', active: true },
    })
    expect(sync.enqueueHorizonSessionsSync).toHaveBeenCalledWith(expect.anything(), 'v1', ['p1'], NOW)
  })
  // nuevo
  it('un plan que la sucursal no tiene ⇒ 400 con los disponibles', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn() as any)
    prismaMock.product.findMany.mockResolvedValueOnce([cls('p1')] as any)
    await expect(setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'p1', externalPlanId: '999' }], 's1', NOW)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/305.*Gold/),
    })
  })
  // revisión final — F5: sin planes conocidos no se acepta cualquier plan (moriría en el proveedor sin que nadie lo vea)
  it('la sucursal no trajo planes ⇒ 400 PASS_PLANS_UNKNOWN que pide reconectar, sin escribir', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn({ config: { hasSlotConfirmation: true, plans: [] } }) as any)
    prismaMock.product.findMany.mockResolvedValueOnce([cls('p1')] as any)
    await expect(setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'p1', externalPlanId: '305' }], 's1', NOW)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PASS_PLANS_UNKNOWN',
      message: 'No pudimos leer tus planes de TotalPass. Vuelve a conectar la llave para actualizarlos.',
    })
    expect(prismaMock.aggregatorProductLink.upsert).not.toHaveBeenCalled()
  })
  // R69 / Codex authz P2-10 — sólo lo que CAMBIA (liga nueva o cambio de plan) se valida contra los planes de la sucursal
  describe('planes que desaparecieron', () => {
    const plans = (...ids: string[]) =>
      conn({ config: { hasSlotConfirmation: true, plans: ids.map(id => ({ id, name: `Plan ${id}`, code: `C${id}` })) } })
    it('conservar SIN cambios una liga archivada cuyo plan ya no existe (queda otro) ⇒ ok, sin reescribirla', async () => {
      prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(plans('306') as any).mockResolvedValueOnce(plans('306') as any)
      prismaMock.product.findMany.mockResolvedValueOnce([cls('p2', { deletedAt: new Date('2030-01-01') })] as any)
      prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([
        { productId: 'p2', externalPlanId: '305', product: { name: 'Spinning' } },
      ] as any)
      await setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'p2', externalPlanId: '305' }], 's1', NOW)
      // Sin reescribir: el código del plan (que llega en los webhooks) no se pierde porque el plan ya no esté en la lista.
      expect(prismaMock.aggregatorProductLink.upsert).not.toHaveBeenCalled()
      expect(prismaMock.aggregatorProductLink.updateMany).not.toHaveBeenCalled()
    })
    it('sin planes conocidos se puede QUITAR una liga (las demás se conservan tal cual)', async () => {
      prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(plans() as any).mockResolvedValueOnce(plans() as any)
      prismaMock.product.findMany.mockResolvedValueOnce([cls('p1')] as any)
      prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([
        { productId: 'p1', externalPlanId: '305', product: { name: 'Yoga' } },
        { productId: 'p2', externalPlanId: '305', product: { name: 'Spinning' } },
      ] as any)
      prismaMock.aggregatorBooking.count.mockResolvedValueOnce(0)
      await setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'p1', externalPlanId: '305' }], 's1', NOW)
      expect(prismaMock.aggregatorProductLink.updateMany.mock.calls[0][0]).toEqual({
        where: { connectionId: 'c1', productId: { in: ['p2'] } },
        data: { active: false },
      })
      expect(sync.enqueueLiveSessionsSync).toHaveBeenCalledWith(expect.anything(), 'v1', 'c1', ['p2'], NOW)
    })
    it('cambiarle el plan a una liga vigente por uno que no existe ⇒ 400 PASS_UNKNOWN_PLAN', async () => {
      prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(plans('305') as any)
      prismaMock.product.findMany.mockResolvedValueOnce([cls('p1')] as any)
      prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([
        { productId: 'p1', externalPlanId: '305', product: { name: 'Yoga' } },
      ] as any)
      await expect(setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'p1', externalPlanId: '999' }], 's1', NOW)).rejects.toMatchObject({
        statusCode: 400,
        code: 'PASS_UNKNOWN_PLAN',
      })
      expect(prismaMock.aggregatorProductLink.upsert).not.toHaveBeenCalled()
    })
  })
  it('sin planes conocidos, desligar todo (lista vacía) sigue funcionando', async () => {
    const noPlans = conn({ config: { hasSlotConfirmation: true, plans: [] } })
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(noPlans as any).mockResolvedValueOnce(noPlans as any)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([])
    const v = await setPassProductLinks('v1', 'TOTALPASS', [], 's1', NOW)
    expect(v.productLinks).toEqual([])
    expect(prismaMock.aggregatorProductLink.upsert).not.toHaveBeenCalled()
  })
  // nuevo
  it('un producto que no es clase del venue ⇒ 400', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn() as any)
    prismaMock.product.findMany.mockResolvedValueOnce([])
    await expect(setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'pX', externalPlanId: '305' }], 's1', NOW)).rejects.toMatchObject({
      statusCode: 400,
    })
  })
  // nuevo — Review Focus 4 / P1-4: cuenta también a quien ya hizo check-in y la clase no ha terminado
  it('desligar una clase con socios reservados o ya registrados ⇒ 409 con el conteo y sin escribir', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn() as any)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([
      { productId: 'p1', externalPlanId: '305', product: { name: 'Yoga' } },
    ] as any)
    prismaMock.aggregatorBooking.count.mockResolvedValueOnce(2)
    await expect(setPassProductLinks('v1', 'TOTALPASS', [], 's1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/Yoga.*2/),
    })
    expect(prismaMock.aggregatorBooking.count.mock.calls[0][0].where).toEqual({
      connectionId: 'c1',
      decision: 'ACCEPTED',
      reservation: { productId: 'p1', status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] }, endsAt: { gt: NOW } },
    })
    expect(prismaMock.aggregatorProductLink.updateMany).not.toHaveBeenCalled()
  })
  // nuevo — Review Focus 4 / P2-12
  it('desligar sin socios ⇒ desactiva la liga y encola la baja de sus ocurrencias vivas', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn() as any).mockResolvedValueOnce(conn() as any)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([
      { productId: 'p1', externalPlanId: '305', product: { name: 'Yoga' } },
    ] as any)
    prismaMock.aggregatorBooking.count.mockResolvedValueOnce(0)
    await setPassProductLinks('v1', 'TOTALPASS', [], 's1', NOW)
    expect(prismaMock.aggregatorProductLink.updateMany.mock.calls[0][0]).toEqual({
      where: { connectionId: 'c1', productId: { in: ['p1'] } },
      data: { active: false },
    })
    expect(sync.enqueueLiveSessionsSync).toHaveBeenCalledWith(expect.anything(), 'v1', 'c1', ['p1'], NOW)
  })
  // nuevo — Ligas archivadas: la vista ya no muestra la liga de una clase archivada, así que el dashboard no la manda; como el
  // servidor calcula lo que sale contra TODAS las ligas activas, la desliga (y encola su baja) en vez de rechazar con PASS_NOT_A_CLASS
  it('la liga de una clase archivada que el dashboard ya no manda sale (se desactiva y encola su baja), sin 400', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn() as any).mockResolvedValueOnce(conn() as any)
    prismaMock.product.findMany.mockResolvedValueOnce([cls('p2')] as any) // sólo la que se manda
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([
      { productId: 'p1', externalPlanId: '305', product: { name: 'Yoga archivada' } },
      { productId: 'p2', externalPlanId: '305', product: { name: 'Pilates' } },
    ] as any)
    prismaMock.aggregatorBooking.count.mockResolvedValueOnce(0)
    await setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'p2', externalPlanId: '305' }], 's1', NOW)
    expect(prismaMock.aggregatorProductLink.updateMany.mock.calls[0][0]).toEqual({
      where: { connectionId: 'c1', productId: { in: ['p1'] } },
      data: { active: false },
    })
    expect(sync.enqueueLiveSessionsSync).toHaveBeenCalledWith(expect.anything(), 'v1', 'c1', ['p1'], NOW)
  })
  // C9 (P2-10) — una liga a una clase archivada se conserva tal cual o se quita; ligarla o cambiarle el plan, no
  describe('ligas a clases archivadas', () => {
    const twoPlans = () =>
      conn({
        config: {
          plans: [
            { id: '305', name: 'Gold', code: 'A' },
            { id: '306', name: 'Silver', code: 'B' },
          ],
        },
      })
    it('guardar sin cambios con una liga archivada ⇒ ok: no la publica ni la desliga', async () => {
      prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn() as any).mockResolvedValueOnce(conn() as any)
      prismaMock.product.findMany.mockResolvedValueOnce([cls('p1'), cls('p2', { deletedAt: new Date('2030-01-01') })] as any)
      prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([
        { productId: 'p1', externalPlanId: '305', product: { name: 'Yoga' } },
        { productId: 'p2', externalPlanId: '305', product: { name: 'Spinning' } },
      ] as any)
      await setPassProductLinks(
        'v1',
        'TOTALPASS',
        [
          { productId: 'p1', externalPlanId: '305' },
          { productId: 'p2', externalPlanId: '305' },
        ],
        's1',
        NOW,
      )
      expect(prismaMock.aggregatorProductLink.updateMany).not.toHaveBeenCalled()
      expect(sync.enqueueLiveSessionsSync).not.toHaveBeenCalled()
      expect(sync.enqueueHorizonSessionsSync).toHaveBeenCalledWith(expect.anything(), 'v1', [], NOW)
      // Las clases se leen sin filtrar por tipo ni archivo: así se sabe cuál está archivada.
      expect(prismaMock.product.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['p1', 'p2'] }, venueId: 'v1' })
    })
    it('quitar la liga archivada ⇒ se desliga y se encola su baja', async () => {
      prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn() as any).mockResolvedValueOnce(conn() as any)
      prismaMock.product.findMany.mockResolvedValueOnce([cls('p1')] as any)
      prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([
        { productId: 'p1', externalPlanId: '305', product: { name: 'Yoga' } },
        { productId: 'p2', externalPlanId: '305', product: { name: 'Spinning' } },
      ] as any)
      prismaMock.aggregatorBooking.count.mockResolvedValueOnce(0)
      await setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'p1', externalPlanId: '305' }], 's1', NOW)
      expect(prismaMock.aggregatorProductLink.updateMany.mock.calls[0][0]).toEqual({
        where: { connectionId: 'c1', productId: { in: ['p2'] } },
        data: { active: false },
      })
      expect(sync.enqueueLiveSessionsSync).toHaveBeenCalledWith(expect.anything(), 'v1', 'c1', ['p2'], NOW)
    })
    it.each([
      ['cambiarle el plan', [{ productId: 'p2', externalPlanId: '306' }], [{ productId: 'p2', externalPlanId: '305' }]],
      ['ligarla de nuevo', [{ productId: 'p2', externalPlanId: '305' }], []],
    ])('%s ⇒ 400 PASS_NOT_A_CLASS con el nombre de la clase, sin escribir', async (_l, wanted, current) => {
      prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(twoPlans() as any)
      prismaMock.product.findMany.mockResolvedValueOnce([cls('p2', { name: 'Spinning', deletedAt: new Date('2030-01-01') })] as any)
      prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce(current.map(c => ({ ...c, product: { name: 'Spinning' } })) as any)
      await expect(setPassProductLinks('v1', 'TOTALPASS', wanted, 's1', NOW)).rejects.toMatchObject({
        statusCode: 400,
        code: 'PASS_NOT_A_CLASS',
        message: expect.stringMatching(/«Spinning»/),
      })
      expect(prismaMock.aggregatorProductLink.upsert).not.toHaveBeenCalled()
      expect(prismaMock.aggregatorProductLink.updateMany).not.toHaveBeenCalled()
    })
  })
  // nuevo — P2-11
  it('cambiar el plan de una clase con ocurrencias publicadas a futuro ⇒ 409 «primero desliga»', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(
      conn({
        config: {
          plans: [
            { id: '305', name: 'Gold', code: 'A' },
            { id: '306', name: 'Silver', code: 'B' },
          ],
        },
      }) as any,
    )
    prismaMock.product.findMany.mockResolvedValueOnce([cls('p1')] as any)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([
      { productId: 'p1', externalPlanId: '305', product: { name: 'Yoga' } },
    ] as any)
    jest.spyOn(sync, 'countLiveFutureSessions').mockResolvedValueOnce(3)
    await expect(setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'p1', externalPlanId: '306' }], 's1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/desliga/),
    })
  })
  // nuevo — P2-11 también con la liga ya desactivada: sus ocurrencias siguen vivas con el plan viejo hasta darse de baja
  it('volver a ligar con OTRO plan una clase desligada que aún tiene ocurrencias vivas ⇒ 409', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(
      conn({
        config: {
          plans: [
            { id: '305', name: 'Gold', code: 'A' },
            { id: '306', name: 'Silver', code: 'B' },
          ],
        },
      }) as any,
    )
    prismaMock.product.findMany.mockResolvedValueOnce([cls('p1')] as any)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([])
    prismaMock.aggregatorProductLink.findUnique.mockResolvedValueOnce({ externalPlanId: '305', product: { name: 'Yoga' } } as any)
    const count = jest.spyOn(sync, 'countLiveFutureSessions').mockResolvedValueOnce(2)
    await expect(setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'p1', externalPlanId: '306' }], 's1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/Yoga.*desliga/),
    })
    expect(count).toHaveBeenCalledWith(expect.anything(), 'v1', 'c1', 'p1', NOW)
    expect(prismaMock.aggregatorProductLink.upsert).not.toHaveBeenCalled()
  })
  // C11 (P3-22) — la desconectaron después de la primera lectura: la transacción la relee y no deja ligas sobre una
  // conexión revocada
  it('la conexión dejó de estar ACTIVE antes de la transacción ⇒ 409 «primero conecta», sin escribir', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn() as any)
    prismaMock.product.findMany.mockResolvedValueOnce([cls('p1')] as any)
    prismaMock.aggregatorConnection.findFirst.mockResolvedValueOnce(null)
    await expect(setPassProductLinks('v1', 'TOTALPASS', [{ productId: 'p1', externalPlanId: '305' }], 's1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PASS_NOT_CONNECTED',
      message: 'Primero conecta TotalPass.',
    })
    expect(prismaMock.aggregatorConnection.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: 'c1', status: 'ACTIVE' } })
    expect(prismaMock.aggregatorProductLink.upsert).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorProductLink.updateMany).not.toHaveBeenCalled()
    expect(sync.enqueueHorizonSessionsSync).not.toHaveBeenCalled()
  })
  // nuevo
  it('sin conexión activa ⇒ 409 «primero conecta»', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(null)
    await expect(setPassProductLinks('v1', 'TOTALPASS', [], 's1', NOW)).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('setPassConfirmMode', () => {
  // nuevo — P1-5: pasar a AUTO hace lo mismo que la ingesta AUTO (check-in de la reserva + validación)
  it('pasar a AUTO confirma automáticamente cada visita pendiente en plazo', async () => {
    const auto = jest.spyOn(visitSvc, 'autoConfirmVisit').mockResolvedValue(true)
    prismaMock.aggregatorConnection.findUnique
      .mockResolvedValueOnce(conn({ confirmMode: 'ON_VENUE_CHECKIN' }) as any)
      .mockResolvedValueOnce(conn() as any)
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce([
      { id: 'vis1', venueId: 'v1', connectionId: 'c1', provider: 'TOTALPASS', reservationId: 'r1' },
    ] as any)
    await setPassConfirmMode('v1', 'TOTALPASS', 'AUTO', 's1', NOW)
    expect(prismaMock.aggregatorConnection.update.mock.calls[0][0]).toMatchObject({ where: { id: 'c1' }, data: { confirmMode: 'AUTO' } })
    expect(prismaMock.aggregatorVisit.findMany.mock.calls[0][0]).toMatchObject({
      where: { connectionId: 'c1', status: 'PENDING', deadlineAt: { gt: NOW } },
      take: 200,
    })
    expect(auto).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'vis1', venueId: 'v1', connectionId: 'c1', provider: 'TOTALPASS', reservationId: 'r1' },
      NOW,
    )
  })
  // C3 (P1-3) — con 201 pendientes la 201 también pasa por el helper protegido (asistencia + validación), no sólo por el
  // barrido (que sólo valida): tandas de 200 con cursor por id hasta que no quede ninguna.
  it('pasar a AUTO procesa TODAS las pendientes en tandas de 200 (cursor por id)', async () => {
    const auto = jest.spyOn(visitSvc, 'autoConfirmVisit').mockResolvedValue(true)
    prismaMock.aggregatorConnection.findUnique
      .mockResolvedValueOnce(conn({ confirmMode: 'ON_VENUE_CHECKIN' }) as any)
      .mockResolvedValueOnce(conn() as any)
    const mk = (i: number) => ({
      id: `vis${String(i).padStart(3, '0')}`,
      venueId: 'v1',
      connectionId: 'c1',
      provider: 'TOTALPASS',
      reservationId: null,
    })
    prismaMock.aggregatorVisit.findMany
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => mk(i + 1)) as any)
      .mockResolvedValueOnce([mk(201)] as any)
    await setPassConfirmMode('v1', 'TOTALPASS', 'AUTO', 's1', NOW)
    expect(auto).toHaveBeenCalledTimes(201)
    expect(auto.mock.calls.map(c => (c[1] as { id: string }).id)).toContain('vis201')
    const [first, second] = prismaMock.aggregatorVisit.findMany.mock.calls.map((c: any) => c[0])
    expect(first).toMatchObject({ orderBy: { id: 'asc' }, take: 200 })
    expect(first.where.id).toBeUndefined()
    expect(second.where).toEqual({ connectionId: 'c1', status: 'PENDING', deadlineAt: { gt: NOW }, id: { gt: 'vis200' } })
    expect(prismaMock.aggregatorVisit.findMany).toHaveBeenCalledTimes(2) // la tanda corta es la última
  })
  // C3 — tope de seguridad: no se queda dando vueltas para siempre, y lo deja dicho en el log
  it('al llegar al tope de tandas se detiene y lo registra con [PASES]', async () => {
    const auto = jest.spyOn(visitSvc, 'autoConfirmVisit').mockResolvedValue(true)
    prismaMock.aggregatorConnection.findUnique
      .mockResolvedValueOnce(conn({ confirmMode: 'ON_VENUE_CHECKIN' }) as any)
      .mockResolvedValueOnce(conn() as any)
    let page = 0
    prismaMock.aggregatorVisit.findMany.mockReset()
    prismaMock.aggregatorVisit.findMany.mockImplementation((async () => {
      page += 1
      return Array.from({ length: 200 }, (_, i) => ({ id: `p${page}-${String(i).padStart(3, '0')}`, venueId: 'v1', connectionId: 'c1' }))
    }) as any)
    await setPassConfirmMode('v1', 'TOTALPASS', 'AUTO', 's1', NOW)
    expect(page).toBe(10)
    expect(auto).toHaveBeenCalledTimes(2000)
    expect((logger.error as jest.Mock).mock.calls.map(c => String(c[0]))).toEqual([expect.stringMatching(/^\[PASES\].*tope/)])
    prismaMock.aggregatorVisit.findMany.mockReset()
    prismaMock.aggregatorVisit.findMany.mockResolvedValue([])
  })
  // nuevo — ronda 1, H6
  it('el mismo modo ⇒ no escribe nada ni deja rastro', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn() as any)
    const view = await setPassConfirmMode('v1', 'TOTALPASS', 'AUTO', 's1', NOW)
    expect(view.confirmMode).toBe('AUTO')
    expect(prismaMock.aggregatorConnection.update).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorVisit.findMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
  // nuevo — ronda 1, H6
  it('pasar a ON_VENUE_CHECKIN ⇒ cambia el modo y no confirma ninguna visita', async () => {
    const auto = jest.spyOn(visitSvc, 'autoConfirmVisit').mockResolvedValue(true)
    prismaMock.aggregatorConnection.findUnique
      .mockResolvedValueOnce(conn() as any)
      .mockResolvedValueOnce(conn({ confirmMode: 'ON_VENUE_CHECKIN' }) as any)
    await setPassConfirmMode('v1', 'TOTALPASS', 'ON_VENUE_CHECKIN', 's1', NOW)
    expect(prismaMock.aggregatorConnection.update.mock.calls[0][0]).toEqual({
      where: { id: 'c1' },
      data: { confirmMode: 'ON_VENUE_CHECKIN' },
    })
    expect(prismaMock.aggregatorVisit.findMany).not.toHaveBeenCalled()
    expect(auto).not.toHaveBeenCalled()
  })
})

describe('disconnectPassProvider', () => {
  const activeConnection = () =>
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce({
      id: 'c1',
      status: 'ACTIVE',
      credentialCiphertext: Buffer.from('x'),
      externalPlaceId: 'place-1',
    } as any)
  /** Socios próximos o en curso y check-ins por confirmar en plazo (lo primero que se revisa). */
  const pending = (futureBookings: number, pendingVisits: number) => {
    prismaMock.aggregatorBooking.count.mockResolvedValueOnce(futureBookings)
    prismaMock.aggregatorVisit.count.mockResolvedValueOnce(pendingVisits)
  }
  const UNLINKING = 'PASS_DISCONNECT_UNLINKING'

  // nuevo — R65: con clases ligadas y sin socios próximos, desconectar las desliga solo y pide volver a presionar
  it('ACTIVE con 2 clases ligadas y sin socios ni check-ins ⇒ las desliga, encola su baja y pide volver a presionar', async () => {
    activeConnection()
    pending(0, 0)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([{ productId: 'p1' }, { productId: 'p2' }] as any)
    prismaMock.aggregatorProductLink.updateMany.mockResolvedValueOnce({ count: 2 })
    await expect(disconnectPassProvider('v1', 'TOTALPASS', 's1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: UNLINKING,
      message: 'Estamos quitando tus 2 clases de TotalPass. Vuelve a presionar Desconectar en unos minutos.',
    })
    // Misma transacción SERIALIZABLE que desligar a mano: una reserva que entra a la vez se reintenta y ya ve la liga apagada.
    expect(prismaMock.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'Serializable' })
    expect(prismaMock.aggregatorProductLink.findMany.mock.calls[0][0]).toMatchObject({
      where: { connectionId: 'c1', active: true },
      take: 200,
    })
    expect(prismaMock.aggregatorProductLink.updateMany.mock.calls[0][0]).toEqual({
      where: { connectionId: 'c1', productId: { in: ['p1', 'p2'] } },
      data: { active: false },
    })
    expect(sync.enqueueLiveSessionsSync).toHaveBeenCalledWith(prismaMock, 'v1', 'c1', ['p1', 'p2'], NOW)
    // Sigue ACTIVE: el worker da de baja allá con la llave que todavía sirve.
    expect(prismaMock.aggregatorConnection.update).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PASS_INTEGRATION_PRODUCTS_UPDATED',
        data: { provider: 'TOTALPASS', linked: 0, removed: 2, reason: 'disconnect' },
      }),
    )
  })
  // nuevo — R65: singular
  it('con 1 clase ligada el mensaje va en singular', async () => {
    activeConnection()
    pending(0, 0)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([{ productId: 'p1' }] as any)
    prismaMock.aggregatorProductLink.updateMany.mockResolvedValueOnce({ count: 1 })
    await expect(disconnectPassProvider('v1', 'TOTALPASS', 's1', NOW)).rejects.toMatchObject({
      code: UNLINKING,
      message: 'Estamos quitando tu 1 clase de TotalPass. Vuelve a presionar Desconectar en unos minutos.',
    })
  })
  // nuevo — P2-10 + ronda 1, H6 + R65: con socios próximos o check-ins en plazo esas clases sí van a ocurrir: no se desliga nada
  // R2b-39: singular/plural, y los check-ins en plazo se cuentan como «sin resolver con TotalPass» (algunos ya los
  // confirmó el estudio y sólo esperan al proveedor: no son «por confirmar»)
  const BLOQUEO = 'Todavía no se puede desconectar TotalPass: '
  it.each([
    [1, 0, `${BLOQUEO}1 reserva de socio próxima o en curso.`],
    [3, 0, `${BLOQUEO}3 reservas de socios próximas o en curso.`],
    [0, 1, `${BLOQUEO}1 check-in todavía sin resolver con TotalPass (espera a que se confirme o venza).`],
    [
      2,
      2,
      `${BLOQUEO}2 reservas de socios próximas o en curso · 2 check-ins todavía sin resolver con TotalPass (espera a que se confirmen o venzan).`,
    ],
  ])('ACTIVE con clases ligadas y %i socio(s) / %i check-in(s) pendientes ⇒ 409 BLOCKED sin desligar', async (b, v, msg) => {
    activeConnection()
    pending(b, v)
    await expect(disconnectPassProvider('v1', 'TOTALPASS', 's1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PASS_DISCONNECT_BLOCKED',
      message: msg,
    })
    // Sólo cuenta lo FUTURO: reservas próximas o en curso y check-ins en plazo.
    expect(prismaMock.aggregatorBooking.count.mock.calls[0][0].where).toEqual({
      connectionId: 'c1',
      decision: 'ACCEPTED',
      reservation: { status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] }, endsAt: { gt: NOW } },
    })
    expect(prismaMock.aggregatorVisit.count.mock.calls[0][0].where).toEqual({
      connectionId: 'c1',
      status: 'PENDING',
      deadlineAt: { gt: NOW },
    })
    expect(prismaMock.aggregatorProductLink.findMany).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorProductLink.updateMany).not.toHaveBeenCalled()
    expect(sync.enqueueLiveSessionsSync).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorConnection.update).not.toHaveBeenCalled()
  })
  /** Registra si la transacción terminó (COMMIT) o se deshizo: lo encolado sólo cuenta si hizo COMMIT. */
  const trackCommits = () => {
    const outcomes: string[] = []
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      try {
        const r = await fn(prismaMock)
        outcomes.push('commit')
        return r
      } catch (e) {
        outcomes.push('rollback')
        throw e
      }
    })
    return outcomes
  }
  // nuevo — R65: ya sin ligas, pero la baja allá todavía no termina
  // C5 (P1-5): antes de responder «espera», vuelve a encolar la baja de esas ocurrencias (y lo encolado sí se guarda)
  it('ACTIVE sin ligas con una clase todavía publicada ⇒ re-encola su baja y 409 «espera unos minutos»', async () => {
    const outcomes = trackCommits()
    activeConnection()
    pending(0, 0)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([])
    prismaMock.aggregatorSessionLink.count.mockResolvedValueOnce(1)
    prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 0 }]) // ninguna abandonada
    await expect(disconnectPassProvider('v1', 'TOTALPASS', 's1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PASS_DISCONNECT_BLOCKED',
      message: 'Todavía no se puede desconectar TotalPass: 1 clase todavía publicada (espera unos minutos a que se dé de baja).',
    })
    expect(prismaMock.aggregatorSessionLink.count.mock.calls[0][0].where).toEqual({
      connectionId: 'c1',
      live: true,
      publishedStartsAt: { gt: NOW },
    })
    expect(sync.enqueueLiveSessionsSync).toHaveBeenCalledWith(prismaMock, 'v1', 'c1', null, NOW)
    expect(outcomes).toEqual(['commit'])
    expect(prismaMock.aggregatorProductLink.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorConnection.update).not.toHaveBeenCalled()
  })
  // C5 (P1-5) — una baja que terminó DEAD_LETTER: repetir Desconectar no la reencolaba y el mensaje pedía esperar para siempre
  it('con bajas que ya fallaron definitivamente ⇒ las re-encola y lo dice (portal del proveedor como salida)', async () => {
    const outcomes = trackCommits()
    activeConnection()
    pending(0, 0)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([])
    prismaMock.aggregatorSessionLink.count.mockResolvedValueOnce(3)
    prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 2 }])
    await expect(disconnectPassProvider('v1', 'TOTALPASS', 's1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PASS_DISCONNECT_BLOCKED',
      message:
        'No pudimos quitar 2 clases de TotalPass; las volvimos a intentar. Si sigue, bórralas desde su portal y vuelve a presionar Desconectar.',
    })
    expect(sync.enqueueLiveSessionsSync).toHaveBeenCalledWith(prismaMock, 'v1', 'c1', null, NOW)
    expect(outcomes).toEqual(['commit'])
    // Abandonada = viva a futuro, con una baja DEAD_LETTER y sin otra en camino; el plazo va con utcTs.
    const [strings, ...values] = prismaMock.$queryRaw.mock.calls[0]
    const sql = Prisma.sql(strings as TemplateStringsArray, ...values)
    expect(sql.sql.replace(/\s+/g, ' ')).toMatch(/'DEAD_LETTER'.*NOT EXISTS.*'PENDING', 'FAILED', 'IN_PROGRESS'/)
    expect(sql.sql).toMatch(/"publishedStartsAt" > \(\? AT TIME ZONE 'UTC'\)/)
    expect(sql.values).toEqual(['c1', NOW])
    expect(prismaMock.aggregatorConnection.update).not.toHaveBeenCalled()
  })
  it('varias clases publicadas, ninguna abandonada ⇒ el «espera» va en plural', async () => {
    activeConnection()
    pending(0, 0)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([])
    prismaMock.aggregatorSessionLink.count.mockResolvedValueOnce(4)
    prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 0 }])
    await expect(disconnectPassProvider('v1', 'TOTALPASS', 's1', NOW)).rejects.toMatchObject({
      message: 'Todavía no se puede desconectar TotalPass: 4 clases todavía publicadas (espera unos minutos a que se den de baja).',
    })
  })
  it('una sola baja abandonada ⇒ el mensaje va en singular', async () => {
    activeConnection()
    pending(0, 0)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([])
    prismaMock.aggregatorSessionLink.count.mockResolvedValueOnce(1)
    prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 1 }])
    await expect(disconnectPassProvider('v1', 'TOTALPASS', 's1', NOW)).rejects.toMatchObject({
      message:
        'No pudimos quitar 1 clase de TotalPass; la volvimos a intentar. Si sigue, bórrala desde su portal y vuelve a presionar Desconectar.',
    })
  })
  // nuevo — ronda 1, H1 (R41): sin llave válida no se puede dar de baja nada allá; bloquear sólo atrapa al estudio
  it.each(['REVOKED', 'PENDING'])(
    'conexión %s con clases ligadas y publicadas ⇒ se desconecta igual, desactiva todo y lo deja dicho',
    async status => {
      prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce({
        id: 'c1',
        status,
        credentialCiphertext: Buffer.from('x'),
        externalPlaceId: 'place-1',
      } as any)
      prismaMock.aggregatorSessionLink.count.mockResolvedValueOnce(1)
      prismaMock.aggregatorBooking.count.mockResolvedValueOnce(2)
      prismaMock.aggregatorProductLink.updateMany.mockResolvedValueOnce({ count: 2 })
      prismaMock.aggregatorSessionLink.updateMany.mockResolvedValueOnce({ count: 1 })
      await expect(disconnectPassProvider('v1', 'TOTALPASS', 's1', NOW)).resolves.toBeUndefined()
      expect(prismaMock.aggregatorProductLink.updateMany.mock.calls[0][0]).toEqual({
        where: { connectionId: 'c1', active: true },
        data: { active: false },
      })
      expect(prismaMock.aggregatorSessionLink.updateMany.mock.calls[0][0]).toEqual({
        where: { connectionId: 'c1', live: true },
        data: { live: false },
      })
      expect(prismaMock.aggregatorConnection.update.mock.calls[0][0]).toEqual({
        where: { id: 'c1' },
        data: { status: 'REVOKED', credentialCiphertext: null, externalPlaceId: null, lastError: null },
      })
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PASS_INTEGRATION_DISCONNECTED',
          data: { provider: 'TOTALPASS', forced: true, leftPublished: 1, futureBookings: 2 },
        }),
      )
    },
  )
  // regresión — una conexión ACTIVE sin nada pendiente se limpia como siempre
  it('ACTIVE sin nada pendiente ⇒ REVOKED, borra la credencial y libera la sucursal', async () => {
    activeConnection()
    pending(0, 0)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([])
    prismaMock.aggregatorSessionLink.count.mockResolvedValueOnce(0)
    await disconnectPassProvider('v1', 'TOTALPASS', 's1', NOW)
    expect(prismaMock.aggregatorConnection.update.mock.calls[0][0]).toEqual({
      where: { id: 'c1' },
      data: { status: 'REVOKED', credentialCiphertext: null, externalPlaceId: null, lastError: null },
    })
    expect(prismaMock.aggregatorProductLink.updateMany).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASS_INTEGRATION_DISCONNECTED', data: { provider: 'TOTALPASS' } }),
    )
  })
  // nuevo
  it('nunca conectado, o ya limpio ⇒ no hace nada', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce({
      id: 'c1',
      status: 'REVOKED',
      credentialCiphertext: null,
      externalPlaceId: null,
    } as any)
    await disconnectPassProvider('v1', 'TOTALPASS', 's1', NOW)
    expect(prismaMock.aggregatorConnection.update).not.toHaveBeenCalled()
  })
})
