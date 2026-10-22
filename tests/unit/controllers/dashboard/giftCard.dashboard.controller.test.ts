/**
 * Dashboard de tarjetas de regalo: el sub-router REAL con permiso y plan dejados pasar (los prueba
 * dashboard.giftCards.routes.test.ts) y los servicios simulados. Mide lo que llega a cada servicio, lo que vuelve y la
 * bitácora de las operaciones de gerente (sin el código nuevo de una reposición). Los ajustes dejan su bitácora en A5.
 */
import express from 'express'
import request from 'supertest'

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkFeatureAccess.middleware'),
  checkFeatureAccess: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}))
jest.mock('@/services/giftCards/giftCardSurface.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardSurface.service'),
  auditarTarjetas: jest.fn(),
  estadoDeVentaDeTarjetas: jest.fn(),
  negocioTieneTarjetas: jest.fn(),
  operarSobreDeGerente: jest.fn(),
  // 1b S7: la MISMA traducción a bitácora del reenvío que usa el POS (S4), y la bitácora que SÍ espera y lanza (Q102/Q104).
  auditarReenvio: jest.fn(),
  registrarSalidaDelSecreto: jest.fn().mockResolvedValue(undefined),
}))
// 1b S7: reenviar y cambiar el destino (su lógica la prueban giftCardCuenta.service.test.ts y la integración).
jest.mock('@/services/giftCards/giftCardCuenta.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardCuenta.service'),
  reenviarTarjeta: jest.fn(),
  cambiarDestinoDeTarjeta: jest.fn(),
}))
// Q17: la patada de la entrega es un doble: nada sale a nadie.
jest.mock('@/services/giftCards/giftCardDelivery.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardDelivery.service'),
  entregarTarjetas: jest.fn().mockResolvedValue({ reclamadas: 0, enviadas: 0, reprogramadas: 0, fallidas: 0, atoradas: 0 }),
}))
jest.mock('@/services/giftCards/giftCardSettings.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardSettings.service'),
  getGiftCardSettings: jest.fn(),
  updateGiftCardSettings: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardReports.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardReports.service'),
  listGiftCards: jest.fn(),
  getGiftCardDetail: jest.fn(),
  getGiftCardSummary: jest.fn(),
  getGiftCardLiabilityAging: jest.fn(),
  listPendingAccountingReview: jest.fn(),
  streamGiftCardBalancesCsv: jest.fn(),
}))

import { globalErrorHandler } from '@/app'
import giftCardsRouter from '@/routes/dashboard/giftCards.routes'
import * as superficie from '@/services/giftCards/giftCardSurface.service'
import { getGiftCardSettings, updateGiftCardSettings } from '@/services/giftCards/giftCardSettings.service'
import * as reportes from '@/services/giftCards/giftCardReports.service'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { BadRequestError } from '@/errors/AppError'
import { exportCsv, operate } from '@/controllers/dashboard/giftCard.dashboard.controller'
import { cambiarDestinoDeTarjeta, reenviarTarjeta } from '@/services/giftCards/giftCardCuenta.service'
import { entregarTarjetas } from '@/services/giftCards/giftCardDelivery.service'

const m = (f: unknown) => f as jest.Mock
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  ;(req as any).authContext = { userId: 'gerente-1', venueId: 'v1', role: 'MANAGER' }
  next()
})
app.use('/venues/:venueId/gift-cards', giftCardsRouter)
app.use(globalErrorHandler)
const B = '/venues/v1/gift-cards'
const audit = m(superficie.auditarTarjetas)
const AJUSTES = {
  enabled: false,
  suggestedAmounts: [500, 1000, 2000],
  minAmount: 100,
  maxAmount: 10000,
  validityMonths: null,
  termsVersion: '2026-10-14',
  topePorOperacion: 70000,
  llavesConfiguradas: true,
  updatedAt: null,
}
const VENTA = { sellable: true, code: null, message: null, howToEnable: null, operationLimit: 70000 }

beforeEach(() => {
  jest.clearAllMocks()
  m(superficie.estadoDeVentaDeTarjetas).mockResolvedValue(VENTA)
  m(superficie.negocioTieneTarjetas).mockResolvedValue(false)
})

describe('ajustes', () => {
  it('GET: los ajustes de A5, el estado de venta y `hasCards` (decisión 1 del coordinador)', async () => {
    m(getGiftCardSettings).mockResolvedValue(AJUSTES)
    m(superficie.negocioTieneTarjetas).mockResolvedValue(true)
    const r = await request(app).get(`${B}/settings`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: true, data: { ...AJUSTES, sale: VENTA, hasCards: true } })
    expect(superficie.negocioTieneTarjetas).toHaveBeenCalledWith('v1')
  })

  it('prender: pasa `aceptaTerminos` a A5 (que valida y deja su bitácora) y responde con el estado de venta', async () => {
    m(updateGiftCardSettings).mockResolvedValue({ ...AJUSTES, enabled: true })
    const r = await request(app).put(`${B}/settings`).send({ enabled: true, aceptaTerminos: true })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ enabled: true, topePorOperacion: 70000, sale: VENTA, hasCards: false })
    expect(updateGiftCardSettings).toHaveBeenCalledWith('v1', { enabled: true, aceptaTerminos: true }, 'gerente-1')
    expect(audit).not.toHaveBeenCalled() // GIFT_CARD_SETTINGS_UPDATED lo escribe A5
  })

  it('🔴 guardar montos sin tocar el interruptor: llegan como números en pesos y SIN `enabled` (auditoría r1 A-4)', async () => {
    m(updateGiftCardSettings).mockResolvedValue({ ...AJUSTES, enabled: true, suggestedAmounts: [250, 750.5] })
    await request(app)
      .put(`${B}/settings`)
      .send({ suggestedAmounts: [250, 750.5] })
    expect(updateGiftCardSettings).toHaveBeenCalledWith('v1', { suggestedAmounts: [250, 750.5] }, 'gerente-1')
    // Ni el esquema ni el controller inventan `enabled`: A5 sólo escribe los campos enviados (bajo su candado), así un
    // guardado de montos con una foto vieja no vuelve a prender lo que otra sesión apagó.
    expect(m(updateGiftCardSettings).mock.calls[0][1]).not.toHaveProperty('enabled')
  })

  it('prender sin aceptar los términos → 400 GIFT_CARD_TERMS_REQUIRED (el texto de A5)', async () => {
    m(updateGiftCardSettings).mockRejectedValue(
      new BadRequestError('Para activar las tarjetas de regalo acepta los términos.', 'GIFT_CARD_TERMS_REQUIRED'),
    )
    const r = await request(app).put(`${B}/settings`).send({ enabled: true })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'GIFT_CARD_TERMS_REQUIRED', message: 'Para activar las tarjetas de regalo acepta los términos.' })
  })
})

describe('lista y detalle', () => {
  it('la lista pasa página, tamaño (el servicio lo topa), búsqueda y estados ya parseados', async () => {
    m(reportes.listGiftCards).mockResolvedValue({ items: [], page: 2, pageSize: 100, total: 0 })
    const r = await request(app).get(`${B}?page=2&pageSize=500&search=ana&status=active,BLOCKED`)
    expect(r.body).toEqual({ success: true, data: { items: [], page: 2, pageSize: 100, total: 0 } })
    expect(reportes.listGiftCards).toHaveBeenCalledWith('v1', { page: 2, pageSize: 500, search: 'ana', status: ['ACTIVE', 'BLOCKED'] })
  })

  it('decisión 1: el filtro acepta EXPIRED y la respuesta lleva el saldo de todo el filtro (`totalBalance`)', async () => {
    m(reportes.listGiftCards).mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 3, totalBalance: 1250.5 })
    const r = await request(app).get(`${B}?status=expired,BLOCKED`)
    expect(r.body).toEqual({ success: true, data: { items: [], page: 1, pageSize: 50, total: 3, totalBalance: 1250.5 } })
    expect(reportes.listGiftCards).toHaveBeenCalledWith('v1', {
      page: undefined,
      pageSize: undefined,
      search: undefined,
      status: ['EXPIRED', 'BLOCKED'],
    })
  })

  it('el detalle pasa el cursor y el límite de su libreta', async () => {
    m(reportes.getGiftCardDetail).mockResolvedValue({ id: 'gc1' })
    await request(app).get(`${B}/gc1?cursor=abc&limit=20`)
    expect(reportes.getGiftCardDetail).toHaveBeenCalledWith('v1', 'gc1', { cursor: 'abc', limit: 20 })
  })
})

describe('operaciones de gerente', () => {
  it('ajuste: monto Decimal a la libreta y bitácora con dirección, monto en pesos, motivo y nota', async () => {
    m(superficie.operarSobreDeGerente).mockResolvedValue({ activityIds: ['a1'], replayed: false })
    const body = {
      operationKey: 'ajuste-0001-abc',
      tipo: 'AJUSTE',
      direccion: 'INCREMENT',
      amount: 50.25,
      reason: 'CASHIER_ERROR',
      note: 'faltó cargar',
    }
    const r = await request(app).post(`${B}/gc1/operations`).send(body)
    expect(r.body).toEqual({ success: true, data: { activityIds: ['a1'] } })
    const [venueId, giftCardId, staffId, input] = m(superficie.operarSobreDeGerente).mock.calls[0]
    expect([venueId, giftCardId, staffId]).toEqual(['v1', 'gc1', 'gerente-1'])
    expect(input.amount.toString()).toBe('50.25')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GIFT_CARD_ADJUSTED',
        entity: 'GiftCard',
        entityId: 'gc1',
        data: {
          operationKey: 'ajuste-0001-abc',
          tipo: 'AJUSTE',
          reason: 'CASHIER_ERROR',
          note: 'faltó cargar',
          direccion: 'INCREMENT',
          amount: 50.25,
          activityIds: ['a1'],
        },
      }),
    )
  })

  it('reponer el código: el gerente recibe el código nuevo; la bitácora NO lo guarda', async () => {
    m(superficie.operarSobreDeGerente).mockResolvedValue({
      activityIds: ['a2'],
      nuevoCodigo: { display: 'AB12-CD34-EF56-GH78-J', last4: 'GH78' },
      replayed: false,
    })
    const r = await request(app)
      .post(`${B}/gc1/operations`)
      .send({ operationKey: 'repone-0001-abc', tipo: 'REEMPLAZAR_CODIGO', reason: 'LOST_CARD', folio: 'ORD-1729' })
    expect(m(superficie.operarSobreDeGerente).mock.calls[0][3]).toMatchObject({ folio: 'ORD-1729' })
    expect(r.body.data.nuevoCodigo).toEqual({ display: 'AB12-CD34-EF56-GH78-J', last4: 'GH78' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'GIFT_CARD_CODE_REPLACED' }))
    expect(JSON.stringify(audit.mock.calls)).not.toContain('AB12-CD34')
  })

  it('el reintento del dashboard (misma llave) no repite la bitácora', async () => {
    m(superficie.operarSobreDeGerente).mockResolvedValue({ activityIds: ['a3'], replayed: true })
    await request(app).post(`${B}/gc1/operations`).send({ operationKey: 'bloquea-0001-abc', tipo: 'BLOQUEAR', reason: 'CHARGEBACK' })
    expect(audit).not.toHaveBeenCalled()
  })

  it('misma llave con otro contenido → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    m(superficie.operarSobreDeGerente).mockRejectedValue(
      new GiftCardError('IDEMPOTENCY_KEY_REUSED', 'Esa llave ya se usó para otra operación distinta. Genera una nueva.', 409),
    )
    const r = await request(app)
      .post(`${B}/gc1/operations`)
      .send({ operationKey: 'bloquea-0001-abc', tipo: 'DESBLOQUEAR', reason: 'CUSTOMER_REQUEST' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })
})

/** Q104 (r21-2): el replay de «Reponer código» devuelve el código VIGENTE: es una salida del secreto (Q102). */
describe('Q104: el reintento de «Reponer código» deja su renglón antes de devolver el código', () => {
  const salida = m(superficie.registrarSalidaDelSecreto)
  const NUEVO = { display: 'AB12-CD34-EF56-GH78-J', last4: 'GH78' }
  const REPONER = { operationKey: 'repone-0001-abc', tipo: 'REEMPLAZAR_CODIGO', reason: 'LOST_CARD', folio: 'ORD-1729' }
  /** `operate` llamado directo, con `req`/`res`/`next` falsos: así se ve el orden entre la bitácora y la respuesta. */
  const llamada = (body: Record<string, unknown> = REPONER) => {
    const req = {
      params: { venueId: 'v1', giftCardId: 'gc1' },
      body,
      authContext: { userId: 'gerente-1', venueId: 'v1', role: 'MANAGER' },
      ip: '10.0.0.7',
      get: (h: string) => (h.toLowerCase() === 'user-agent' ? 'panel-test' : undefined),
    } as any
    const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) }
    const next = jest.fn()
    return { req, res, next }
  }

  it('replay con el código ⇒ UN GIFT_CARD_CODE_REVEALED (REPLACE_REPLAY) y la respuesta sale DESPUÉS de que se guardó', async () => {
    m(superficie.operarSobreDeGerente).mockResolvedValue({ activityIds: ['a2'], nuevoCodigo: NUEVO, replayed: true })
    let guardar: () => void = () => undefined
    salida.mockImplementationOnce(() => new Promise<void>(r => (guardar = r)))
    const { req, res, next } = llamada()
    const enCurso = operate(req, res, next)
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
    expect(salida).toHaveBeenCalledTimes(1)
    expect(res.json).not.toHaveBeenCalled()
    guardar()
    await enCurso
    expect(res.json).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { activityIds: ['a2'], nuevoCodigo: NUEVO } })
    expect(next).not.toHaveBeenCalled()
    const [db, filas] = salida.mock.calls[0]
    expect(db).toBeDefined()
    expect(filas).toEqual([
      {
        venueId: 'v1',
        staffId: 'gerente-1',
        action: 'GIFT_CARD_CODE_REVEALED',
        entity: 'GiftCard',
        entityId: 'gc1',
        data: { operationKey: 'repone-0001-abc', motivo: 'REPLACE_REPLAY', ruta: 'dashboard:operate' },
        ipAddress: '10.0.0.7',
        userAgent: 'panel-test',
      },
    ])
    expect(JSON.stringify(filas)).not.toMatch(/AB12-CD34|GH78/)
    // Un replay nunca repite la bitácora de mejor esfuerzo de la reposición.
    expect(audit).not.toHaveBeenCalled()
  })

  it('🔴 si ese renglón no se guarda ⇒ `next` recibe el 503 «No se pudo mostrar el código. Intenta otra vez.» y nunca se responde', async () => {
    m(superficie.operarSobreDeGerente).mockResolvedValue({ activityIds: ['a2'], nuevoCodigo: NUEVO, replayed: true })
    salida.mockRejectedValueOnce(new Error('la base no contestó'))
    const { req, res, next } = llamada()
    await operate(req, res, next)
    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    const [error] = next.mock.calls[0]
    expect(error).toMatchObject({ statusCode: 503, message: 'No se pudo mostrar el código. Intenta otra vez.' })
    expect(JSON.stringify({ message: error.message, code: error.code, details: error.details })).not.toMatch(/AB12-CD34|GH78/)
  })

  it('🔴 por la ruta: el 503 llega al panel sin `nuevoCodigo`', async () => {
    m(superficie.operarSobreDeGerente).mockResolvedValue({ activityIds: ['a2'], nuevoCodigo: NUEVO, replayed: true })
    salida.mockRejectedValueOnce(new Error('la base no contestó'))
    const r = await request(app).post(`${B}/gc1/operations`).send(REPONER)
    expect(r.status).toBe(503)
    expect(r.body.message).toBe('No se pudo mostrar el código. Intenta otra vez.')
    expect(JSON.stringify(r.body)).not.toMatch(/nuevoCodigo|AB12-CD34/)
  })

  it('la primera reposición (replayed: false) ⇒ ningún REVEALED y su bitácora de siempre', async () => {
    m(superficie.operarSobreDeGerente).mockResolvedValue({ activityIds: ['a2'], nuevoCodigo: NUEVO, replayed: false })
    const { req, res, next } = llamada()
    await operate(req, res, next)
    expect(salida).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'GIFT_CARD_CODE_REPLACED', entityId: 'gc1' }))
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { activityIds: ['a2'], nuevoCodigo: NUEVO } })
  })

  it.each([
    ['ajuste', { operationKey: 'ajuste-0009-abc', tipo: 'AJUSTE', direccion: 'INCREMENT', amount: 10, reason: 'CASHIER_ERROR', note: 'x' }],
    ['bloqueo', { operationKey: 'bloquea-0009-abc', tipo: 'BLOQUEAR', reason: 'CHARGEBACK' }],
  ])('un replay sin código (%s) ⇒ ningún REVEALED ni bitácora', async (_caso, body) => {
    m(superficie.operarSobreDeGerente).mockResolvedValue({ activityIds: ['a3'], replayed: true })
    const { req, res, next } = llamada(body)
    await operate(req, res, next)
    expect(salida).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { activityIds: ['a3'] } })
  })
})

/** 1b S7 (Q16, P-2): el gerente reenvía o cambia el destino desde el panel; misma respuesta y misma bitácora que el POS. */
describe('reenviar desde el panel', () => {
  const RUTA = 'POST /dashboard/venues/:venueId/gift-cards/:giftCardId/resend'
  const GERENTE = { staffId: 'gerente-1', puedeVender: true, puedeGestionar: true }
  const RESULTADO = {
    giftCardId: 'gc1',
    deliveryStatus: 'PENDING',
    repuesta: false,
    ultimos4: 'JKMN',
    replay: false,
    destinoAnterior: null,
    destinoNuevo: null,
  }
  const reenvio = m(superficie.auditarReenvio)

  it('sin destino ⇒ reenviarTarjeta en SU negocio, como gerente; responde los cuatro campos, deja su bitácora y patea', async () => {
    m(reenviarTarjeta).mockResolvedValue(RESULTADO)
    const r = await request(app).post(`${B}/gc1/resend`).send({ operationKey: 'reenvia-0001-abc' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: true, data: { giftCardId: 'gc1', deliveryStatus: 'PENDING', repuesta: false, ultimos4: 'JKMN' } })
    expect(reenviarTarjeta).toHaveBeenCalledWith('v1', 'gc1', GERENTE, { operationKey: 'reenvia-0001-abc' })
    expect(cambiarDestinoDeTarjeta).not.toHaveBeenCalled()
    expect(reenvio).toHaveBeenCalledTimes(1)
    expect(reenvio).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'v1',
        staffId: 'gerente-1',
        giftCardId: 'gc1',
        operationKey: 'reenvia-0001-abc',
        ruta: RUTA,
        resultado: RESULTADO,
      }),
    )
    expect(entregarTarjetas).toHaveBeenCalledWith({ ids: ['gc1'] })
  })

  it.each([
    ['el destino actual', { deliveryChannel: 'WHATSAPP', recipientPhone: '5512345678' }],
    ['un correo nuevo', { deliveryChannel: 'EMAIL', recipientEmail: 'ana@gmail.com' }],
  ])('con destino (%s) ⇒ SIEMPRE cambiarDestinoDeTarjeta, como gerente; su bitácora y la patada (D3)', async (_caso, destino) => {
    const cambio = { ...RESULTADO, repuesta: true, ultimos4: 'WXYZ', destinoAnterior: '55•••••678', destinoNuevo: 'a•••@gmail.com' }
    m(cambiarDestinoDeTarjeta).mockResolvedValue(cambio)
    const r = await request(app)
      .post(`${B}/gc1/resend`)
      .send({ operationKey: 'reenvia-0002-abc', ...destino })
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual({ giftCardId: 'gc1', deliveryStatus: 'PENDING', repuesta: true, ultimos4: 'WXYZ' })
    expect(cambiarDestinoDeTarjeta).toHaveBeenCalledWith('v1', 'gc1', GERENTE, { operationKey: 'reenvia-0002-abc', destino })
    expect(reenviarTarjeta).not.toHaveBeenCalled()
    expect(reenvio).toHaveBeenCalledWith(expect.objectContaining({ giftCardId: 'gc1', ruta: RUTA, resultado: cambio }))
    expect(entregarTarjetas).toHaveBeenCalledWith({ ids: ['gc1'] })
  })

  it('🔴 un replay responde lo mismo y NO patea (la bitácora la descarta auditarReenvio)', async () => {
    m(reenviarTarjeta).mockResolvedValue({ ...RESULTADO, replay: true, deliveryStatus: 'SENT' })
    const r = await request(app).post(`${B}/gc1/resend`).send({ operationKey: 'reenvia-0001-abc' })
    expect(r.body.data).toEqual({ giftCardId: 'gc1', deliveryStatus: 'SENT', repuesta: false, ultimos4: 'JKMN' })
    expect(reenvio).toHaveBeenCalledWith(expect.objectContaining({ resultado: expect.objectContaining({ replay: true }) }))
    expect(entregarTarjetas).not.toHaveBeenCalled()
  })

  it('un rechazo de la tarjeta va a la bitácora del reenvío y se relanza con su code; no patea', async () => {
    const error = new GiftCardError('GIFT_CARD_ALREADY_USED', 'Esta tarjeta ya se usó: no se puede reponer.', 409)
    m(cambiarDestinoDeTarjeta).mockRejectedValue(error)
    const r = await request(app)
      .post(`${B}/gc1/resend`)
      .send({ operationKey: 'reenvia-0003-abc', deliveryChannel: 'EMAIL', recipientEmail: 'ana@gmail.com' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('GIFT_CARD_ALREADY_USED')
    expect(reenvio).toHaveBeenCalledWith(expect.objectContaining({ giftCardId: 'gc1', ruta: RUTA, rechazo: error }))
    expect(entregarTarjetas).not.toHaveBeenCalled()
  })

  it('una tarjeta de otro negocio llega igual que una que no existe: 404 GIFT_CARD_NOT_FOUND', async () => {
    m(reenviarTarjeta).mockRejectedValue(
      new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio.', 404),
    )
    const r = await request(app).post(`${B}/gcAjena/resend`).send({ operationKey: 'reenvia-0004-abc' })
    expect(r.status).toBe(404)
    expect(r.body.code).toBe('GIFT_CARD_NOT_FOUND')
    expect(m(reenviarTarjeta).mock.calls[0].slice(0, 2)).toEqual(['v1', 'gcAjena'])
  })

  it.each(['PRINTED', 'HANDED_TO_BUYER'])('a %s ⇒ 400 GIFT_CARD_DESTINATION_CHANNEL_INVALID sin tocar la tarjeta', async canal => {
    const r = await request(app).post(`${B}/gc1/resend`).send({ operationKey: 'reenvia-0005-abc', deliveryChannel: canal })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'GIFT_CARD_DESTINATION_CHANNEL_INVALID' })
    expect(reenviarTarjeta).not.toHaveBeenCalled()
    expect(cambiarDestinoDeTarjeta).not.toHaveBeenCalled()
    expect(entregarTarjetas).not.toHaveBeenCalled()
  })
})

describe('reportes para el contador', () => {
  it('resumen y antigüedad reciben los días del negocio tal cual', async () => {
    m(reportes.getGiftCardSummary).mockResolvedValue({ from: '2026-10-01' })
    m(reportes.getGiftCardLiabilityAging).mockResolvedValue({ at: '2026-10-14' })
    await request(app).get(`${B}/summary?from=2026-10-01&to=2026-10-14`)
    await request(app).get(`${B}/aging?at=2026-10-14`)
    expect(reportes.getGiftCardSummary).toHaveBeenCalledWith('v1', { from: '2026-10-01', to: '2026-10-14' })
    expect(reportes.getGiftCardLiabilityAging).toHaveBeenCalledWith('v1', '2026-10-14')
  })

  it('pendientes de revisión contable con su página', async () => {
    m(reportes.listPendingAccountingReview).mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 })
    await request(app).get(`${B}/pending-accounting?from=2026-10-01&to=2026-10-14&page=1`)
    expect(reportes.listPendingAccountingReview).toHaveBeenCalledWith('v1', {
      from: '2026-10-01',
      to: '2026-10-14',
      page: 1,
      pageSize: undefined,
    })
  })

  it('exportar saldos vivos entrega la respuesta al servicio, que escribe el CSV', async () => {
    m(reportes.streamGiftCardBalancesCsv).mockImplementation(async (_v: string, res: express.Response) => {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.end('Últimos 4\r\n')
    })
    const r = await request(app).get(`${B}/export.csv`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toMatch(/text\/csv/)
    expect(reportes.streamGiftCardBalancesCsv).toHaveBeenCalledWith('v1', expect.anything())
  })
})

describe('exportar CSV con el cliente ya ido (nota 7 del coordinador, C4 r1)', () => {
  /** Respuesta falsa: lo que importa es que el controller no le escriba nada a quien ya no está. */
  const respuesta = (estado: { headersSent: boolean; destroyed: boolean }) =>
    ({ ...estado, status: jest.fn().mockReturnThis(), json: jest.fn(), end: jest.fn(), destroy: jest.fn() }) as any
  const req = { params: { venueId: 'v1' } } as any

  it('el servicio regresa sin cabeceras porque el cliente se fue: el controller no escribe nada después', async () => {
    m(reportes.streamGiftCardBalancesCsv).mockResolvedValue(undefined)
    const res = respuesta({ headersSent: false, destroyed: true })
    const next = jest.fn()
    await exportCsv(req, res, next)
    expect([res.status, res.json, res.end, res.destroy, next].map(f => f.mock.calls.length)).toEqual([0, 0, 0, 0, 0])
  })

  it('lanza con la respuesta ya destruida: no intenta responder un error', async () => {
    m(reportes.streamGiftCardBalancesCsv).mockRejectedValue(new Error('base caída'))
    const res = respuesta({ headersSent: false, destroyed: true })
    const next = jest.fn()
    await exportCsv(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
    expect(res.destroy).not.toHaveBeenCalled()
  })

  it('lanza a media respuesta (cabeceras enviadas): corta la conexión para que el archivo no parezca completo, sin otro cuerpo', async () => {
    m(reportes.streamGiftCardBalancesCsv).mockRejectedValue(new Error('base caída'))
    const res = respuesta({ headersSent: true, destroyed: false })
    const next = jest.fn()
    await exportCsv(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
    expect(res.destroy).toHaveBeenCalledTimes(1)
  })

  it('lanza antes de escribir nada, con el cliente presente: el error va al manejador global', async () => {
    const error = new Error('base caída')
    m(reportes.streamGiftCardBalancesCsv).mockRejectedValue(error)
    const res = respuesta({ headersSent: false, destroyed: false })
    const next = jest.fn()
    await exportCsv(req, res, next)
    expect(next).toHaveBeenCalledWith(error)
  })
})
