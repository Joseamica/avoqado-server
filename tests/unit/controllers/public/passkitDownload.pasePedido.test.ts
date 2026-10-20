/**
 * La actualización que pide Apple (`GET …/passes/{passType}/{serial}`) tiene que devolver la tarjeta con EL MISMO serial
 * que pidió. Si devuelve otro, el iPhone la rechaza («Requested serial number X, received serial number Y») y la tarjeta
 * se queda congelada sin que nada truene en nuestro lado.
 *
 * Caso real (17-oct-2026): al juntar un cliente duplicado de Testarudo, su pase viejo pasó al cliente que se quedó, que
 * ya tenía uno propio. La descarga armaba «el pase del cliente» (`issueApplePass`, uno cualquiera) en vez del pedido.
 */
jest.mock('../../../../src/services/wallet/applePassSigner.service', () => ({
  signPass: jest.fn().mockResolvedValue(Buffer.from('pkpass-de-mentira')),
  walletSigningAvailable: () => true,
}))

jest.mock('../../../../src/services/wallet/cardDesign.service', () => ({
  getCardDesign: jest.fn().mockResolvedValue({
    backgroundColor: '#000000',
    textColor: '#FFFFFF',
    labelColor: '#CCCCCC',
    stampFilledColor: '#7ADD2C',
  }),
}))

jest.mock('../../../../src/services/wallet/stampLedger.service', () => ({
  getStampCardStatus: jest.fn().mockResolvedValue({ stampsEarned: 2, stampsRequired: 7, rewardLabel: 'Café gratis' }),
}))

jest.mock('../../../../src/config/env', () => ({
  env: { APPLE_PASS_TYPE_ID: 'pass.io.avoqado.credencial', APPLE_TEAM_ID: 'TEAM123', BASE_URL: 'https://api.avoqado.io' },
}))

import { downloadUpdatedPassHandler } from '../../../../src/controllers/public/passkit.public.controller'
import { signPass } from '../../../../src/services/wallet/applePassSigner.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = { id: 'v1', name: 'Testarudo Café', logo: null, primaryColor: '#7ADD2C', secondaryColor: null }

// El pase que pide el iPhone: el que la fusión movió al cliente que se quedó.
const PASE_PEDIDO = { id: 'wp-viejo', serialNumber: 'AVQ-X', authToken: 'tok-x', qrToken: 'qr-x', venueId: 'v1', customerId: 'c1' }
// El otro pase ACTIVO del mismo cliente (el suyo de siempre).
const OTRO_PASE = { id: 'wp-propio', serialNumber: 'AVQ-Y', authToken: 'tok-y', qrToken: 'qr-y', venueId: 'v1', customerId: 'c1' }

function fakeRes() {
  return { setHeader: jest.fn(), send: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() } as any
}

function peticion(serialNumber: string, token: string) {
  return { params: { serialNumber }, headers: { authorization: `ApplePass ${token}` } } as any
}

describe('descarga de la tarjeta actualizada (Apple PassKit)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venue.findFirst.mockResolvedValue(VENUE as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1' } as any)
    // 1.ª lectura: el pase pedido (por serial). Cualquier otra: «el pase del cliente», que es el OTRO.
    prismaMock.walletPass.findFirst.mockImplementation(((args: any) =>
      Promise.resolve(args?.where?.serialNumber === 'AVQ-X' ? PASE_PEDIDO : OTRO_PASE)) as any)
  })

  it('P1 devuelve la tarjeta con el MISMO serial, token y QR que pidió el iPhone, aunque el cliente tenga otra tarjeta', async () => {
    const res = fakeRes()

    await downloadUpdatedPassHandler(peticion('AVQ-X', 'tok-x'), res)

    expect(res.send).toHaveBeenCalled()
    const passJson = (signPass as jest.Mock).mock.calls[0][0]
    expect(passJson.serialNumber).toBe('AVQ-X')
    expect(passJson.authenticationToken).toBe('tok-x')
    expect(JSON.stringify(passJson)).toContain('qr-x')
    expect(JSON.stringify(passJson)).not.toContain('qr-y')
  })

  it('sigue mostrando el avance REAL del cliente (los sellos de hoy)', async () => {
    const res = fakeRes()

    await downloadUpdatedPassHandler(peticion('AVQ-X', 'tok-x'), res)

    const opciones = (signPass as jest.Mock).mock.calls[0][1]
    expect(opciones.stamps).toEqual({ earned: 2, required: 7 })
  })

  it('un token equivocado sigue siendo 401 y no arma nada', async () => {
    const res = fakeRes()

    await downloadUpdatedPassHandler(peticion('AVQ-X', 'tok-otro'), res)

    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(signPass).not.toHaveBeenCalled()
  })
})
