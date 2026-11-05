/**
 * Cierre de la ventana de un anuncio (Task 15b, codex r3 #7): el aparato guarda el cierre sin red y lo manda después
 * con `{ staffId }` de quien cerró. Si para entonces la sesión es de otra persona (el `AuthInterceptor` cambió el token
 * a media petición), el servidor responde 409 y NO registra nada: el cierre no se le apunta a quien no cerró.
 * Sin cuerpo (apps viejas) se registra como siempre.
 */
jest.mock('../../../src/services/announcements/announcementRead.service', () => ({
  recordDismiss: jest.fn(),
}))

import { dismiss } from '../../../src/controllers/shared/announcement.read.controller'
import { recordDismiss } from '../../../src/services/announcements/announcementRead.service'

const llamar = async (body: unknown) => {
  const req = { params: { id: 'a1' }, body, authContext: { userId: 'ana', venueId: 'v1' } } as any
  const res = { json: jest.fn() } as any
  const next = jest.fn()
  await dismiss(req, res, next)
  return { res, next }
}

describe('dismiss de un anuncio', () => {
  beforeEach(() => jest.clearAllMocks())

  it('con staffId ajeno responde 409 y no registra', async () => {
    const { res, next } = await llamar({ staffId: 'beatriz' })
    expect(recordDismiss).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
    expect(next.mock.calls[0][0].statusCode).toBe(409)
  })

  it('sin cuerpo funciona como hoy', async () => {
    const { res, next } = await llamar(undefined)
    expect(recordDismiss).toHaveBeenCalledWith('a1', 'ana', 'v1')
    expect(res.json).toHaveBeenCalledWith({ success: true })
    expect(next).not.toHaveBeenCalled()
  })

  it('con el staffId de la sesión registra', async () => {
    const { res } = await llamar({ staffId: 'ana' })
    expect(recordDismiss).toHaveBeenCalledWith('a1', 'ana', 'v1')
    expect(res.json).toHaveBeenCalledWith({ success: true })
  })
})
