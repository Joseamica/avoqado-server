/**
 * S3 «Efectivo sin red en el turno correcto» — el aviso de una venta apartada (turno o caja ya cerrados) es DURABLE: lo manda el
 * trabajador de efectos del cobro (`AVISO_TURNO_CERRADO`), y `enviarAvisoDeVentaSinRed` LANZA mientras no conste la notificación
 * de cada OWNER/ADMIN activo, para que el trabajador lo reintente (Codex plan r3 #6 y r4 #3). También sale para el POS (ANDROID/iOS),
 * que no tiene serial de terminal: «Un aparato».
 */
jest.mock('@/services/dashboard/notification.service', () => ({ sendNotification: jest.fn(), getNotificationPreferences: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { getNotificationPreferences, sendNotification } from '@/services/dashboard/notification.service'
import { avisarVentaSinRed, enviarAvisoDeVentaSinRed } from '@/services/mobile/avisoDeVentaSinRed'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const LLAVE = 'ckvz8q2xk0000abcd1234efgh'
const DUENOS = [
  { id: 'sv-owner', staffId: 'owner-1' },
  { id: 'sv-admin', staffId: 'admin-1' },
]

let enviadas: any[]

beforeEach(() => {
  jest.clearAllMocks()
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
  prismaMock.activityLog.findFirst.mockResolvedValue(null)
  ;(getNotificationPreferences as jest.Mock).mockResolvedValue({ enabled: true })
})

describe('enviarAvisoDeVentaSinRed (el emisor del trabajador de efectos)', () => {
  it('sin serial (ANDROID/iOS) ⇒ «Un aparato», una notificación por persona', async () => {
    await enviarAvisoDeVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE, montoCents: 10000, orderId: 'order-1' })
    expect(enviadas.map(n => n.recipientId).sort()).toEqual(['admin-1', 'owner-1'])
    expect(enviadas[0].message).toMatch(/^Un aparato subió una venta por \$100\.00/)
  })

  it('una notificación que falla ⇒ LANZA (el trabajador reintenta); al reintentar sólo avisa a quien faltaba', async () => {
    ;(sendNotification as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('correo caído')
    })
    await expect(enviarAvisoDeVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE })).rejects.toThrow('AVISO_INCOMPLETO')
    expect(enviadas).toHaveLength(1)

    await enviarAvisoDeVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE })
    expect(enviadas.map(n => n.recipientId).sort()).toEqual(['admin-1', 'owner-1'])
  })

  it('dos ejecuciones ⇒ una notificación por persona', async () => {
    await enviarAvisoDeVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE })
    await enviarAvisoDeVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE })
    expect(enviadas).toHaveLength(2)
  })

  it('con la misma llave ya en curso ⇒ LANZA AVISO_EN_CURSO: el efecto queda pendiente, nunca hecho sin notificación', async () => {
    let soltar: () => void = () => {}
    ;(sendNotification as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          soltar = () => resolve({})
        }),
    )
    const primero = avisarVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE })
    await new Promise(resolve => setTimeout(resolve, 5))
    await expect(enviarAvisoDeVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE })).rejects.toThrow('AVISO_EN_CURSO')
    soltar()
    await primero
  })

  it('el negocio ya no existe ⇒ no hay a quién avisar: termina sin lanzar (no reintenta para siempre)', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(null)
    await expect(enviarAvisoDeVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE })).resolves.toBeUndefined()
    expect(enviadas).toHaveLength(0)
  })

  it('una falla de la base al leer los destinatarios ⇒ LANZA (se reintenta)', async () => {
    prismaMock.staffVenue.findMany.mockRejectedValueOnce(new Error('P1001'))
    await expect(enviarAvisoDeVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE })).rejects.toThrow()
  })

  it('horario de silencio (la notificación no se crea y el aviso está prendido) ⇒ LANZA: queda pendiente para después', async () => {
    ;(sendNotification as jest.Mock).mockResolvedValueOnce(null)
    await expect(enviarAvisoDeVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE })).rejects.toThrow('AVISO_INCOMPLETO')
  })

  it('la persona apagó este aviso (la notificación no se crea y está apagado) ⇒ se respeta: no lanza', async () => {
    ;(sendNotification as jest.Mock).mockResolvedValueOnce(null)
    ;(getNotificationPreferences as jest.Mock).mockResolvedValueOnce({ enabled: false })
    await expect(enviarAvisoDeVentaSinRed(VENUE, 'TURNO_CERRADO', { externalId: LLAVE })).resolves.toBeUndefined()
  })
})
