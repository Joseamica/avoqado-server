/**
 * Avisarle al teléfono de un cliente que su tarjeta cambió.
 *
 * 🔴 Lo que se prueba aquí es lo que hace que las tarjetas NO se queden congeladas, y
 * lo que se rompe en silencio: un aviso mal dirigido no da error, sólo no llega. El
 * cliente sigue viendo su saldo viejo y nadie se entera hasta que reclama.
 */
jest.mock('@/services/wallet/apnsClient', () => ({
  sendSilentPush: jest.fn().mockResolvedValue({ ok: true }),
  apnsAvailable: jest.fn().mockReturnValue(true),
}))

import { notifyPassUpdated } from '../../../../src/services/wallet/notifyPassUpdated.service'
import { sendSilentPush, apnsAvailable } from '@/services/wallet/apnsClient'
import { prismaMock } from '../../../__helpers__/setup'

const REGISTROS = [
  { id: 'r1', pushToken: 'tok-iphone', deviceLibraryIdentifier: 'dev-1' },
  { id: 'r2', pushToken: 'tok-ipad', deviceLibraryIdentifier: 'dev-2' },
]

describe('notifyPassUpdated', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(apnsAvailable as jest.Mock).mockReturnValue(true)
    ;(sendSilentPush as jest.Mock).mockResolvedValue({ ok: true })
    prismaMock.walletPassRegistration.findMany.mockResolvedValue(REGISTROS as any)
    prismaMock.walletPassRegistration.deleteMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.walletPass.update.mockResolvedValue({} as any)
  })

  it('🔴 avisa a TODOS los aparatos donde vive esa tarjeta', async () => {
    // El mismo cliente puede tenerla en su iPhone y en su iPad. Avisar sólo a uno deja
    // el otro mostrando un saldo viejo — y es el que va a enseñar en la caja.
    const r = await notifyPassUpdated('wp1')

    expect(r.notified).toBe(2)
    expect(sendSilentPush).toHaveBeenCalledTimes(2)
  })

  it('🔴 toca la tarjeta para que el aparato vea que cambió', async () => {
    // El aparato pregunta "¿qué cambió desde tal fecha?". Si el pase no se marca como
    // modificado, contesta 204 y el push no sirve de nada: el teléfono despierta,
    // pregunta, y se vuelve a dormir con el saldo viejo.
    await notifyPassUpdated('wp1')

    expect(prismaMock.walletPass.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'wp1' } }))
  })

  it('🔴 un aparato que ya no tiene la tarjeta se BORRA del registro', async () => {
    // Apple contesta 410 cuando el token murió (borraron el pase, cambiaron de
    // teléfono). Sin limpiarlo, se le sigue mandando avisos para siempre — y Apple
    // penaliza a quien insiste contra tokens muertos.
    ;(sendSilentPush as jest.Mock).mockResolvedValueOnce({ ok: false, gone: true }).mockResolvedValueOnce({ ok: true })

    await notifyPassUpdated('wp1')

    expect(prismaMock.walletPassRegistration.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['r1'] } }) }),
    )
  })

  it('🔴 sin certificado configurado NO revienta: sólo no avisa', async () => {
    // Esto se llama desde el cobro. Si un servidor sin certificados de Apple hiciera
    // fallar el sellado, un negocio que ni siquiera usa tarjetas digitales no podría
    // cobrar.
    ;(apnsAvailable as jest.Mock).mockReturnValue(false)

    const r = await notifyPassUpdated('wp1')

    expect(r.notified).toBe(0)
    expect(sendSilentPush).not.toHaveBeenCalled()
  })

  it('🔴 un fallo de red no propaga', async () => {
    // Mismo motivo: el aviso es un extra, el cobro es el negocio.
    ;(sendSilentPush as jest.Mock).mockRejectedValue(new Error('APNs no responde'))

    await expect(notifyPassUpdated('wp1')).resolves.toEqual(expect.objectContaining({ notified: 0 }))
  })

  it('una tarjeta que nadie agregó a su cartera no manda nada', async () => {
    prismaMock.walletPassRegistration.findMany.mockResolvedValue([] as any)

    const r = await notifyPassUpdated('wp1')

    expect(r.notified).toBe(0)
    expect(sendSilentPush).not.toHaveBeenCalled()
  })
})
