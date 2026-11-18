/**
 * Plan Básico (revisión de Task 6, ronda 2): la preferencia de los avisos sin cobro (`TIPO_AVISOS_SIN_COBRO`) no puede
 * quedar apagada sin una decisión del dueño.
 * (1) Ningún aviso de ese tipo se manda: si se mandara, `getUserNotificationPreferences` crearía sola una fila [IN_APP].
 * (2) Toda fila nueva de ese tipo nace con correo, salvo canales explícitos: el default del esquema es [IN_APP] y el
 *     dashboard manda cambios parciales (sólo `enabled`).
 */
jest.mock('../../../../src/communication/sockets', () => ({ __esModule: true, default: { broadcastToVenue: jest.fn() } }))
jest.mock('../../../../src/utils/prismaClient', () => {
  const notificationPreference = { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), upsert: jest.fn() }
  return {
    __esModule: true,
    default: {
      notificationPreference,
      staff: { findUnique: jest.fn() },
      venue: { findUnique: jest.fn() },
      notification: { create: jest.fn() },
      $transaction: jest.fn(async (cb: any) => cb({ notificationPreference })),
    },
  }
})

import { NotificationChannel, NotificationType } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import {
  createNotification,
  getUserNotificationPreferences,
  updateManyNotificationPreferences,
  updateNotificationPreferences,
} from '../../../../src/services/dashboard/notification.dashboard.service'
import { updateNotificationPreference } from '../../../../src/services/dashboard/notification.service'
import { canalesAlCrear, MENSAJE_TIPO_RESERVADO, TIPO_AVISOS_SIN_COBRO } from '../../../../src/services/notifications/avisosSinCobro'
import { TIPO_AVISOS_SIN_COBRO as DESDE_BILLING } from '../../../../src/services/billing/avisosDelBasico'

const pref = prisma.notificationPreference as unknown as Record<'findFirst' | 'create' | 'update' | 'upsert', jest.Mock>
const CON_CORREO = [NotificationChannel.IN_APP, NotificationChannel.EMAIL]

beforeEach(() => {
  jest.clearAllMocks()
  pref.findFirst.mockResolvedValue(null)
  pref.create.mockImplementation(async ({ data }: any) => ({ id: 'p1', ...data }))
  pref.upsert.mockImplementation(async ({ create }: any) => ({ id: 'p1', ...create }))
})

describe('avisos sin cobro: el tipo reservado', () => {
  it('es SUBSCRIPTION_CANCELLED, el mismo que leen los avisos del Básico', () => {
    expect(TIPO_AVISOS_SIN_COBRO).toBe(NotificationType.SUBSCRIPTION_CANCELLED)
    expect(DESDE_BILLING).toBe(TIPO_AVISOS_SIN_COBRO)
  })

  it('🔴 (1) createNotification lo rechaza ANTES de leer o crear la preferencia (no nace la fila [IN_APP] que apagaría los avisos)', async () => {
    await expect(
      createNotification({ recipientId: 's1', venueId: 'v1', type: TIPO_AVISOS_SIN_COBRO, title: 't', message: 'm' } as never),
    ).rejects.toMatchObject({ statusCode: 400, message: MENSAJE_TIPO_RESERVADO })
    expect(pref.findFirst).not.toHaveBeenCalled()
    expect(pref.create).not.toHaveBeenCalled()
    expect(prisma.notification.create).not.toHaveBeenCalled()
  })
})

describe('avisos sin cobro: toda fila nueva nace con correo', () => {
  it('🔴 (2) getUserNotificationPreferences la crea con [IN_APP, EMAIL]; otros tipos siguen con [IN_APP]', async () => {
    await getUserNotificationPreferences('s1', 'v1', TIPO_AVISOS_SIN_COBRO)
    expect(pref.create.mock.calls[0][0].data.channels).toEqual(CON_CORREO)

    await getUserNotificationPreferences('s1', 'v1', NotificationType.NEW_ORDER)
    expect(pref.create.mock.calls[1][0].data.channels).toEqual([NotificationChannel.IN_APP])
  })

  it('🔴 (2) un interruptor que sólo manda `enabled` (updateNotificationPreferences) no apaga el correo', async () => {
    await updateNotificationPreferences('s1', 'v1', TIPO_AVISOS_SIN_COBRO, { enabled: true })
    expect(pref.create.mock.calls[0][0].data).toMatchObject({ type: TIPO_AVISOS_SIN_COBRO, enabled: true, channels: CON_CORREO })
  })

  it('con canales explícitos (la baja en un clic) se respetan: sólo IN_APP = apagado', async () => {
    await updateNotificationPreferences('s1', 'v1', TIPO_AVISOS_SIN_COBRO, { channels: [NotificationChannel.IN_APP] })
    expect(pref.create.mock.calls[0][0].data.channels).toEqual([NotificationChannel.IN_APP])
  })

  it('el cambio masivo del dashboard (updateManyNotificationPreferences) también nace con correo', async () => {
    await updateManyNotificationPreferences('s1', 'v1', [
      { type: TIPO_AVISOS_SIN_COBRO, enabled: true },
      { type: NotificationType.NEW_ORDER, enabled: true },
    ])
    expect(pref.create.mock.calls[0][0].data.channels).toEqual(CON_CORREO)
    expect(pref.create.mock.calls[1][0].data).not.toHaveProperty('channels')
  })

  it('updateNotificationPreference (upsert de notification.service) también nace con correo y no toca la actualización', async () => {
    await updateNotificationPreference('s1', 'v1', TIPO_AVISOS_SIN_COBRO, { enabled: true })
    const args = pref.upsert.mock.calls[0][0]
    expect(args.create.channels).toEqual(CON_CORREO)
    expect(args.update).toEqual({ enabled: true })
  })

  it('una fila que ya existe no se toca por el default (sólo al crear)', async () => {
    pref.findFirst.mockResolvedValue({ id: 'p0', channels: [NotificationChannel.IN_APP] })
    pref.update.mockResolvedValue({})
    await updateNotificationPreferences('s1', 'v1', TIPO_AVISOS_SIN_COBRO, { enabled: true })
    expect(pref.update).toHaveBeenCalledWith({ where: { id: 'p0' }, data: { enabled: true } })
  })

  it('canalesAlCrear: otros tipos sin canales → undefined (el default del esquema de siempre)', () => {
    expect(canalesAlCrear(NotificationType.NEW_ORDER)).toBeUndefined()
    expect(canalesAlCrear(TIPO_AVISOS_SIN_COBRO)).toEqual(CON_CORREO)
  })
})
