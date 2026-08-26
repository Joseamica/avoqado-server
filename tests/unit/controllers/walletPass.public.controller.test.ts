/**
 * El endpoint que entrega el .pkpass. Es público (el iPhone lo descarga sin sesión),
 * así que las dos cosas que se prueban aquí son las que lo hacen seguro y usable:
 *
 * 1. El tipo MIME. Con el equivocado, Safari lo baja como archivo suelto en vez de
 *    abrir Wallet, y el cliente se queda viendo algo que no sabe abrir. Es el fallo
 *    más común de esta integración y no aparece hasta probarlo en un iPhone real.
 * 2. El aislamiento entre negocios. El slug es público; sin filtrar el cliente por
 *    venue, un customerId ajeno emitiría una tarjeta con la marca equivocada.
 */
jest.mock('../../../src/services/wallet/applePassSigner.service', () => ({
  signPass: jest.fn().mockResolvedValue(Buffer.from('pkpass-de-mentira')),
  walletSigningAvailable: () => true,
}))

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../../src/config/env', () => ({
  env: { APPLE_PASS_TYPE_ID: 'pass.io.avoqado.loyalty', APPLE_TEAM_ID: 'TEAM123' },
}))

import { downloadApplePass } from '../../../src/controllers/public/walletPass.public.controller'
import { prismaMock } from '../../__helpers__/setup'

const VENUE = {
  id: 'v1',
  name: 'Testarudo Café',
  logo: null,
  primaryColor: '#7ADD2C',
  secondaryColor: null,
}

function fakeRes() {
  return { setHeader: jest.fn(), send: jest.fn(), status: jest.fn().mockReturnThis() } as any
}

function req(venueSlug: string, customerId: string) {
  return { params: { venueSlug, customerId } } as any
}

describe('downloadApplePass', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.walletPass.findFirst.mockResolvedValue({
      id: 'wp1',
      serialNumber: 'AVQ-S1',
      qrToken: 'q1',
      authToken: 'a1',
    } as any)
  })

  it('responde con el MIME que hace que el iPhone abra Wallet', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(VENUE as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1' } as any)
    const res = fakeRes()

    await downloadApplePass(req('testarudo', 'c1'), res, jest.fn())

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/vnd.apple.pkpass')
    expect(res.send).toHaveBeenCalledWith(expect.any(Buffer))
  })

  it('🔴 un cliente de OTRO negocio no obtiene pase, aunque el slug exista', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(VENUE as any)
    prismaMock.customer.findFirst.mockResolvedValue(null) // no pertenece a este venue
    const next = jest.fn()

    await downloadApplePass(req('testarudo', 'ajeno'), fakeRes(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Cliente no encontrado' }))
  })

  it('busca al cliente FILTRANDO por el venue, no sólo por id', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(VENUE as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1' } as any)

    await downloadApplePass(req('testarudo', 'c1'), fakeRes(), jest.fn())

    // Aislamiento de inquilinos: la regla dura del repo es que TODA query filtre
    // por venueId. Aquí además evita emitir con la marca de otro negocio.
    expect(prismaMock.customer.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1', venueId: 'v1' } }))
  })

  it('un slug que no existe da 404, no una tarjeta en blanco', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(null)
    const next = jest.fn()

    await downloadApplePass(req('no-existe', 'c1'), fakeRes(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Negocio no encontrado' }))
  })
})
