/*
  Planes editables B1, Task 9: la capa HTTP de la oferta de los planes en /api/v1/superadmin/plan-offer.

  Arranca el Express real (authenticateTokenMiddleware → authorizeRole([SUPERADMIN]) del router padre → controlador), con JWT real
  y `prismaMock`. El publicador se simula (sus reglas tienen su propia suite): aquí se mide que la subruta esté montada y guardada,
  que los cuerpos estrictos se rechacen ANTES de llamar al servicio, que lo del cuerpo llegue tal cual, y que los errores del
  servicio salgan con su código y sus detalles. El interruptor corre con el código de B1 (no se puede prender) y los destinatarios
  con el servicio real.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
const mockEstado = jest.fn()
const mockVistaPrevia = jest.fn()
const mockPublicar = jest.fn()
const mockReintentar = jest.fn()
const mockDescartar = jest.fn()
const mockEstadoDespues = jest.fn()
jest.mock('../../../src/services/billing/planOfferPublisher', () => ({
  estadoDeLaOferta: (...a: unknown[]) => mockEstado(...a),
  vistaPreviaDeLaOferta: (...a: unknown[]) => mockVistaPrevia(...a),
  publicarVersion: (...a: unknown[]) => mockPublicar(...a),
  reintentarPublicacion: (...a: unknown[]) => mockReintentar(...a),
  descartarPublicacion: (...a: unknown[]) => mockDescartar(...a),
  estadoDespuesDeConfirmar: (...a: unknown[]) => mockEstadoDespues(...a),
}))

import jwt from 'jsonwebtoken'
import { ConflictError } from '@/errors/AppError'
import { api, startApiServer } from '@tests/__helpers__/apiServer'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue, simularSuperadminReal } from '@tests/__helpers__/venueRoleMock'
import { punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const app = require('../../../src/app').default
startApiServer(() => app)

const BASE = '/api/v1/superadmin/plan-offer'
const VENUE = 'clvenuesoporte00000000001'
const VID = 'ckplanofferversion0000002'

function token(role: string) {
  mirrorTokenRoleOnStaffVenue(role, VENUE)
  // El SUPERADMIN del token sólo vale si la base lo confirma (Codex H6/S5).
  simularSuperadminReal(role === 'SUPERADMIN')
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: VENUE, role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}
const como = (role = 'SUPERADMIN') => ({ Authorization: `Bearer ${token(role)}` })

/** Lo que escribe el founder (netos SIN IVA), con los cambios pedidos. */
function entrada(cambios: Record<string, Record<string, unknown>> = {}) {
  const plan = (displayName: string, monthlyNetCents: number, annualNetCents: number) => ({
    displayName,
    onSale: true,
    requiresCard: true,
    trialDays: 30,
    monthlyNetCents,
    annualNetCents,
  })
  return {
    FREE: { displayName: 'Gratis', ...cambios.FREE },
    PRO: { ...plan('Pro', 79900, 999000), ...cambios.PRO },
    PREMIUM: { ...plan('Premium', 149900, 1699000), ...cambios.PREMIUM },
  }
}

const ESTADO = {
  revision: 3,
  vigente: { number: 2, versionId: VID, definition: {}, entrada: entrada(), publishedAt: null, publishedById: null },
  pendiente: null,
  interruptor: { prendido: true, desde: null, actualizadoPor: null, faltan: [] },
  nombresEnStripe: null,
  destinatarios: ['ops@example.com'],
}
const VISTA = {
  cambios: [{ plan: 'PRO', campo: 'monthlyNetCents', antes: 99900, despues: 79900 }],
  preciosNuevos: ['PRO:monthly'],
  bloqueos: { campanas: [], promociones: [] },
  conservanSuPrecio: { 'PRO:monthly': 3, 'PRO:annual': 0, 'PREMIUM:monthly': 1, 'PREMIUM:annual': 0 },
  problemas: [],
}
const PUBLICADA = { number: 2, versionId: VID }

beforeEach(() => {
  jest.clearAllMocks()
  mockEstado.mockResolvedValue(ESTADO)
  mockVistaPrevia.mockResolvedValue(VISTA)
  mockPublicar.mockResolvedValue(PUBLICADA)
  mockReintentar.mockResolvedValue(PUBLICADA)
  mockDescartar.mockResolvedValue(ESTADO)
  mockEstadoDespues.mockResolvedValue(ESTADO)
  // La v1 sembrada (la lee el interruptor real para sus requisitos).
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(punteroA('cv1', 1, versionUno()))
  prismaMock.interruptorDePlataforma.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.platformSettings.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.platformSettings.upsert.mockReset().mockResolvedValue({ id: 'default' })
})

const ningunServicio = () => {
  for (const m of [mockEstado, mockVistaPrevia, mockPublicar, mockReintentar, mockDescartar, mockEstadoDespues])
    expect(m).not.toHaveBeenCalled()
}

describe('/api/v1/superadmin/plan-offer — montaje y guardia', () => {
  it('401 sin token', async () => {
    expect((await api().get(BASE)).status).toBe(401)
    expect((await api().post(`${BASE}/publish`).send({ entrada: entrada(), expectedRevision: 1 })).status).toBe(401)
    ningunServicio()
  })

  it.each(['OWNER', 'ADMIN', 'MANAGER'])('🔴 403 para %s: la oferta de los planes es SÓLO de Avoqado', async role => {
    expect((await api().get(BASE).set(como(role))).status).toBe(403)
    const publicar = await api().post(`${BASE}/publish`).set(como(role)).send({ entrada: entrada(), expectedRevision: 1 })
    expect(publicar.status).toBe(403)
    const destinatarios = await api()
      .put(`${BASE}/recipients`)
      .set(como(role))
      .send({ correos: ['ops@example.com'] })
    expect(destinatarios.status).toBe(403)
    ningunServicio()
    expect(prismaMock.platformSettings.upsert).not.toHaveBeenCalled()
  })

  it('🔴 GET con SUPERADMIN → 200 en la URL completa /api/v1/superadmin/plan-offer', async () => {
    const res = await api().get('/api/v1/superadmin/plan-offer').set(como())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: ESTADO })
    expect(mockEstado).toHaveBeenCalledTimes(1)
  })

  it('🔴 /api/v1/dashboard/superadmin/plan-offer no existe → 404', async () => {
    const res = await api().get('/api/v1/dashboard/superadmin/plan-offer').set(como())
    expect(res.status).toBe(404)
    const publicar = await api()
      .post('/api/v1/dashboard/superadmin/plan-offer/publish')
      .set(como())
      .send({ entrada: entrada(), expectedRevision: 1 })
    expect(publicar.status).toBe(404)
    ningunServicio()
  })
})

describe('cuerpos estrictos: se rechazan antes del servicio', () => {
  const casos: Array<[string, (e: ReturnType<typeof entrada>) => Record<string, unknown>]> = [
    ['un campo de más arriba', e => ({ entrada: e, expectedRevision: 1, borrador: true })],
    ['un campo de más dentro de un plan', e => ({ entrada: { ...e, PRO: { ...e.PRO, stripePriceId: 'price_x' } }, expectedRevision: 1 })],
    ['un precio en texto', e => ({ entrada: { ...e, PRO: { ...e.PRO, monthlyNetCents: '79900' } }, expectedRevision: 1 })],
    ['sin la entrada', () => ({ expectedRevision: 1 })],
  ]

  it.each(casos)('POST /preview y POST /publish con %s → 400 PLAN_OFFER_INVALID y el servicio no corre', async (_n, cuerpo) => {
    for (const ruta of ['preview', 'publish']) {
      const body = cuerpo(entrada())
      if (ruta === 'preview') delete body.expectedRevision
      const res = await api().post(`${BASE}/${ruta}`).set(como()).send(body)
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({ code: 'PLAN_OFFER_INVALID', details: { issues: expect.any(Array) } })
      expect(res.body.details.issues.length).toBeGreaterThan(0)
      expect(typeof res.body.message).toBe('string')
    }
    ningunServicio()
  })

  it('el precio en texto dice en español qué campo está mal', async () => {
    const e = entrada()
    const res = await api()
      .post(`${BASE}/publish`)
      .set(como())
      .send({ entrada: { ...e, PRO: { ...e.PRO, monthlyNetCents: '79900' } }, expectedRevision: 1 })
    expect(res.body.details.issues).toEqual([
      { path: 'entrada.PRO.monthlyNetCents', message: 'El precio mensual sin IVA debe ser un número.' },
    ])
  })

  it.each([
    ['sin revisión', { entrada: entrada() }],
    ['revisión en texto', { entrada: entrada(), expectedRevision: '1' }],
    ['revisión con decimales', { entrada: entrada(), expectedRevision: 1.5 }],
    ['revisión negativa', { entrada: entrada(), expectedRevision: -1 }],
  ])('POST /publish %s → 400 y no publica', async (_n, cuerpo) => {
    const res = await api().post(`${BASE}/publish`).set(como()).send(cuerpo)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('PLAN_OFFER_INVALID')
    expect(mockPublicar).not.toHaveBeenCalled()
  })

  it.each(['retry', 'discard'])(
    'POST /pending/:versionId/%s con un id que no es cuid, o con cuerpo de más → 400 y no corre',
    async accion => {
      expect((await api().post(`${BASE}/pending/no-es-cuid/${accion}`).set(como())).status).toBe(400)
      const conCuerpo = await api().post(`${BASE}/pending/${VID}/${accion}`).set(como()).send({ forzar: true })
      expect(conCuerpo.status).toBe(400)
      expect(conCuerpo.body.code).toBe('PLAN_OFFER_INVALID')
      ningunServicio()
    },
  )

  it.each([
    ['sin prendido', {}],
    ['prendido en texto', { prendido: 'si' }],
    ['un campo de más', { prendido: false, motivo: 'x' }],
  ])('POST /interruptor %s → 400', async (_n, cuerpo) => {
    const res = await api().post(`${BASE}/interruptor`).set(como()).send(cuerpo)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('PLAN_OFFER_INVALID')
    expect(prismaMock.interruptorDePlataforma.findUnique).not.toHaveBeenCalled()
  })
})

describe('lo del cuerpo llega tal cual y la respuesta', () => {
  it('POST /preview llama a la vista previa con la entrada del cuerpo y responde la VistaPrevia', async () => {
    const e = entrada()
    const res = await api().post(`${BASE}/preview`).set(como()).send({ entrada: e })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: VISTA })
    expect(mockVistaPrevia).toHaveBeenCalledWith(e)
    expect(mockPublicar).not.toHaveBeenCalled()
  })

  it('POST /publish llama a publicarVersion con la entrada y la revisión del cuerpo, tal cual', async () => {
    const e = entrada({ PRO: { displayName: 'Pro Plus' } })
    const res = await api().post(`${BASE}/publish`).set(como()).send({ entrada: e, expectedRevision: 7 })
    expect(res.status).toBe(200)
    expect(mockPublicar).toHaveBeenCalledTimes(1)
    expect(mockPublicar).toHaveBeenCalledWith(e, 7, 'user_test')
    expect(mockEstadoDespues).toHaveBeenCalledWith('se publicó la versión', VID)
    expect(res.body).toEqual({ success: true, data: { publicada: PUBLICADA, estado: ESTADO } })
  })

  it('publicar ya hecho no se vuelve error aunque el estado no se pueda leer: 200 con el estado mínimo', async () => {
    mockEstadoDespues.mockResolvedValueOnce({ revision: 4, pendiente: null, parcial: true })
    const res = await api().post(`${BASE}/publish`).set(como()).send({ entrada: entrada(), expectedRevision: 3 })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ publicada: PUBLICADA, estado: { revision: 4, pendiente: null, parcial: true } })
  })

  it('POST /pending/:versionId/retry reintenta ESA versión y responde como publicar', async () => {
    const res = await api().post(`${BASE}/pending/${VID}/retry`).set(como())
    expect(res.status).toBe(200)
    expect(mockReintentar).toHaveBeenCalledWith(VID, 'user_test')
    expect(mockEstadoDespues).toHaveBeenCalledWith('se reintentó la publicación', VID)
    expect(res.body).toEqual({ success: true, data: { publicada: PUBLICADA, estado: ESTADO } })
  })

  it.each([
    ['el estado completo', ESTADO],
    ['el estado mínimo', { revision: 5, pendiente: null, parcial: true }],
  ])('POST /pending/:versionId/discard descarta ESA versión y responde %s tal cual', async (_n, respuesta) => {
    mockDescartar.mockResolvedValueOnce(respuesta)
    const res = await api().post(`${BASE}/pending/${VID}/discard`).set(como())
    expect(res.status).toBe(200)
    expect(mockDescartar).toHaveBeenCalledWith(VID, 'user_test')
    expect(res.body).toEqual({ success: true, data: respuesta })
  })
})

describe('los errores del servicio pasan con su código y sus detalles', () => {
  const campaigns = [{ id: 'lc1', code: 'POS22', name: 'Campaña de prueba', planTier: 'PRO' }]
  it.each([
    ['publish', 'PLAN_OFFER_STALE', mockPublicar, new ConflictError('La oferta cambió.', 'PLAN_OFFER_STALE'), { code: 'PLAN_OFFER_STALE' }],
    [
      'publish',
      'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS',
      mockPublicar,
      new ConflictError('Hay campañas activas.', 'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS', { motivo: 'PRECIO', campaigns }),
      { code: 'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS', details: { motivo: 'PRECIO', campaigns } },
    ],
    [
      'publish',
      'PLAN_EDIT_DISABLED',
      mockPublicar,
      new ConflictError('La edición de los planes está apagada.', 'PLAN_EDIT_DISABLED'),
      { code: 'PLAN_EDIT_DISABLED' },
    ],
    [
      'retry',
      'PLAN_OFFER_PREPARING',
      mockReintentar,
      new ConflictError('No pudimos preparar el precio.', 'PLAN_OFFER_PREPARING', {
        versionId: VID,
        etapa: 'PRECIO',
        ranura: 'PRO:monthly',
        motivo: 'INCIERTO',
      }),
      { code: 'PLAN_OFFER_PREPARING', details: { versionId: VID, etapa: 'PRECIO', ranura: 'PRO:monthly', motivo: 'INCIERTO' } },
    ],
  ] as const)('POST %s: %s pasa con su código y sus detalles', async (accion, _codigo, mock, error, esperado) => {
    mock.mockRejectedValueOnce(error)
    const res =
      accion === 'publish'
        ? await api().post(`${BASE}/publish`).set(como()).send({ entrada: entrada(), expectedRevision: 3 })
        : await api().post(`${BASE}/pending/${VID}/retry`).set(como())
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ message: error.message, ...esperado })
    expect(mockEstadoDespues).not.toHaveBeenCalled()
  })
})

describe('el interruptor y los destinatarios', () => {
  it('POST /interruptor {prendido:true} con el código de B1 → 409 PLAN_EDIT_PREREQUISITE con faltan', async () => {
    const res = await api().post(`${BASE}/interruptor`).set(como()).send({ prendido: true })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'PLAN_EDIT_PREREQUISITE', details: { faltan: expect.arrayContaining(['SERVIDOR_LISTO']) } })
    // La v1 es válida: lo que falta es el SERVIDOR (B4), no la versión.
    expect(res.body.details.faltan).not.toContain('VERSION_1')
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('POST /interruptor {prendido:false} sin renglón → 200 con el estado del interruptor (apagado)', async () => {
    const res = await api().post(`${BASE}/interruptor`).set(como()).send({ prendido: false })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      success: true,
      data: { prendido: false, desde: null, actualizadoPor: null, faltan: expect.arrayContaining(['SERVIDOR_LISTO']) },
    })
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('PUT /recipients normaliza y rechaza 11 correos o uno inválido con 400', async () => {
    const guardado = await api()
      .put(`${BASE}/recipients`)
      .set(como())
      .send({ correos: ['  Ventas@Example.COM ', 'ventas@example.com', 'ops@example.com'] })
    expect(guardado.status).toBe(200)
    expect(guardado.body).toEqual({ success: true, data: { correos: ['ventas@example.com', 'ops@example.com'] } })
    expect(prismaMock.platformSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { avisosDelAltaCorreos: ['ventas@example.com', 'ops@example.com'], updatedById: 'user_test' },
      }),
    )
    prismaMock.platformSettings.upsert.mockClear()

    const once = await api()
      .put(`${BASE}/recipients`)
      .set(como())
      .send({ correos: Array.from({ length: 11 }, (_, i) => `aviso${i}@example.com`) })
    expect(once.status).toBe(400)
    expect(once.body).toMatchObject({ code: 'PLAN_OFFER_INVALID', details: { issues: [{ path: 'correos' }] } })

    const invalido = await api()
      .put(`${BASE}/recipients`)
      .set(como())
      .send({ correos: ['ops@example.com', 'no-es-correo'] })
    expect(invalido.status).toBe(400)
    expect(invalido.body).toMatchObject({ code: 'PLAN_OFFER_INVALID', details: { issues: [{ path: 'correos.1' }] } })
    expect(prismaMock.platformSettings.upsert).not.toHaveBeenCalled()
  })

  it.each([
    ['sin correos', {}],
    ['correos que no es lista', { correos: 'ops@example.com' }],
    ['un correo que no es texto', { correos: [42] }],
    ['un campo de más', { correos: [], todos: true }],
  ])('PUT /recipients %s → 400 por la forma, sin escribir', async (_n, cuerpo) => {
    const res = await api().put(`${BASE}/recipients`).set(como()).send(cuerpo)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('PLAN_OFFER_INVALID')
    expect(prismaMock.platformSettings.upsert).not.toHaveBeenCalled()
  })
})
