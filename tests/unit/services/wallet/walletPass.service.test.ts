/**
 * Emisión del pase. Dos cosas se prueban aquí y las dos duelen en producción:
 *
 * 1. Que emitir dos veces NO deje al cliente con dos tarjetas del mismo negocio en
 *    su cartera. La gente toca "agregar" más de una vez — es la queja número uno
 *    de estos productos.
 * 2. Que los tokens sean largos y distintos. El del QR identifica al cliente ante
 *    la caja: uno corto o predecible es una tarjeta de otro que se puede adivinar.
 */
import { issueApplePass, findPassByQrToken } from '../../../../src/services/wallet/walletPass.service'
import { prismaMock } from '../../../__helpers__/setup'

describe('issueApplePass', () => {
  beforeEach(() => jest.clearAllMocks())

  it('reusa el pase que el cliente ya tiene en vez de crear otro', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue({
      id: 'wp-1',
      serialNumber: 'AVQ-S1',
      qrToken: 'q1',
      authToken: 'a1',
    } as any)

    const result = await issueApplePass('venue-1', 'cust-1')

    expect(result.id).toBe('wp-1')
    expect(result.serialNumber).toBe('AVQ-S1')
    // Sin esto, cada toque de "agregar a mi cartera" apila una tarjeta más.
    expect(prismaMock.walletPass.create).not.toHaveBeenCalled()
  })

  it('busca sólo pases ACTIVOS de ESE venue y ESA plataforma', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(null)
    prismaMock.walletPass.create.mockImplementation(async (args: any) => args.data)

    await issueApplePass('venue-1', 'cust-1')

    // Un filtro flojo aquí devuelve el pase de Google como si fuera el de Apple,
    // o revive uno desactivado a propósito.
    expect(prismaMock.walletPass.findFirst).toHaveBeenCalledWith({
      where: { venueId: 'venue-1', customerId: 'cust-1', platform: 'APPLE', active: true },
    })
  })

  it('genera tokens distintos para cada pase nuevo', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(null)
    prismaMock.walletPass.create.mockImplementation(async (args: any) => args.data)

    const a = await issueApplePass('venue-1', 'cust-1')
    const b = await issueApplePass('venue-1', 'cust-2')

    expect(a.qrToken).not.toBe(b.qrToken)
    expect(a.authToken).not.toBe(b.authToken)
    expect(a.serialNumber).not.toBe(b.serialNumber)
    // El token del QR y el de autenticación son secretos DISTINTOS: si se reusa
    // el mismo, quien vea el código de barras se queda con la llave del pase.
    expect(a.qrToken).not.toBe(a.authToken)
  })

  it('los tokens son largos: un QR adivinable es una tarjeta robada', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(null)
    prismaMock.walletPass.create.mockImplementation(async (args: any) => args.data)

    const { qrToken, authToken } = await issueApplePass('venue-1', 'cust-1')

    expect(qrToken.length).toBeGreaterThanOrEqual(32)
    expect(authToken.length).toBeGreaterThanOrEqual(32)
  })
})

describe('findPassByQrToken', () => {
  it('no resuelve un pase desactivado', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(null)

    await findPassByQrToken('token-de-un-pase-viejo')

    // Desactivar un pase tiene que dejarlo inservible para sellar. Si el filtro
    // `active` se cae, un pase revocado sigue funcionando en la caja.
    expect(prismaMock.walletPass.findFirst).toHaveBeenCalledWith({
      where: { qrToken: 'token-de-un-pase-viejo', active: true },
    })
  })
})
