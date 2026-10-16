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
import { exportCsv } from '@/controllers/dashboard/giftCard.dashboard.controller'

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
