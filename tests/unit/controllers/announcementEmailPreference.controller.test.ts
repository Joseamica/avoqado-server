/**
 * La preferencia «Anuncios de Avoqado por correo» con un cuerpo inválido responde 400 en español, no 500 con el JSON de
 * Zod en inglés (full-testing WARN 6).
 */
jest.mock('../../../src/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/services/announcements/announcementEmailPreference.service', () => ({
  isAnnouncementEmailOn: jest.fn(),
  setAnnouncementEmailOn: jest.fn(),
}))

import { updateAnnouncementEmailPreference } from '../../../src/controllers/dashboard/notification.dashboard.controller'
import { setAnnouncementEmailOn } from '../../../src/services/announcements/announcementEmailPreference.service'

const llamar = async (body: unknown) => {
  const req = { body, authContext: { userId: 'ana' } } as any
  const res = { json: jest.fn() } as any
  const next = jest.fn()
  await updateAnnouncementEmailPreference(req, res, next)
  return { res, next }
}

describe('PUT preferencia de anuncios por correo', () => {
  beforeEach(() => jest.clearAllMocks())

  it('un enabled que no es booleano responde 400 en español y no guarda', async () => {
    const { next } = await llamar({ enabled: 'si' })
    const error = next.mock.calls[0][0]
    expect(error.statusCode).toBe(400)
    expect(error.message).toBe('«enabled» debe ser verdadero o falso')
    expect(setAnnouncementEmailOn).not.toHaveBeenCalled()
  })

  it('con un booleano guarda', async () => {
    const { res } = await llamar({ enabled: false })
    expect(setAnnouncementEmailOn).toHaveBeenCalledWith('ana', false)
    expect(res.json).toHaveBeenCalled()
  })
})
