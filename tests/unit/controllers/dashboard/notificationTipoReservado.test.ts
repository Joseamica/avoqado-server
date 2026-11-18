/**
 * Plan Básico (revisión de Task 6, ronda 2, punto 1): los tres envíos del dashboard (`notifications:send`, MANAGER+) no
 * aceptan el tipo reservado para la preferencia de los avisos sin cobro: un solo envío al dueño crearía sola su fila [IN_APP]
 * y callaría «Tu prueba termina» / «Tu prueba terminó». 400 en español y no se manda nada.
 */
import { createNotification, sendBulkNotification, sendVenueNotification } from '@/controllers/dashboard/notification.dashboard.controller'
import * as notificationService from '@/services/dashboard/notification.dashboard.service'
import { MENSAJE_TIPO_RESERVADO } from '@/services/notifications/avisosSinCobro'

jest.mock('@/services/dashboard/notification.dashboard.service', () => ({
  createNotification: jest.fn(),
  sendBulkNotification: jest.fn(),
  sendVenueNotification: jest.fn(async () => []),
}))

const DUENO = 'cdueno0000000000000000000'
const req = (body: object, params: object = {}) =>
  ({
    body,
    params,
    headers: {},
    authContext: { userId: DUENO, venueId: 'cminegocio000000000000000', role: 'OWNER' },
    resolvedRole: 'OWNER',
  }) as any

async function correr(handler: any, r: any) {
  let listo!: () => void
  const termino = new Promise<void>(resolve => (listo = resolve))
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => (listo(), res)) }
  const next = jest.fn((_e?: unknown) => listo())
  handler(r, res, next)
  await termino
  return next.mock.calls[0]?.[0] as (Error & { statusCode?: number }) | undefined
}

const aviso = { type: 'SUBSCRIPTION_CANCELLED', title: 'Hola', message: 'Prueba' }

describe('envíos del dashboard: el tipo reservado de los avisos sin cobro se rechaza', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    ['POST /notifications', createNotification, req({ ...aviso, recipientId: DUENO })],
    ['POST /notifications/bulk', sendBulkNotification, req({ ...aviso, recipientIds: [DUENO] })],
    ['POST /notifications/venue/:venueId', sendVenueNotification, req(aviso, { venueId: 'cminegocio000000000000000' })],
  ])('%s → 400 en español, sin mandar nada', async (_ruta, handler, r) => {
    const error = await correr(handler, r)
    expect(error?.statusCode).toBe(400)
    expect(error?.message).toBe(MENSAJE_TIPO_RESERVADO)
    expect(notificationService.createNotification).not.toHaveBeenCalled()
    expect(notificationService.sendBulkNotification).not.toHaveBeenCalled()
    expect(notificationService.sendVenueNotification).not.toHaveBeenCalled()
  })
})
