import prisma from '../../../../src/utils/prismaClient'
import * as rc from '../../../../src/services/delivery-channels/providers/rappi/rappi.connect'

// `depsDesdeEnv` importa el env y `rappi.client` de forma perezosa; aquí se sustituyen para no cargar el env real.
// (El objeto vive DENTRO de la fábrica: el servicio compartido de intents importa el env al cargarse, antes que este archivo.)
jest.mock('@/config/env', () => ({ env: {} }))
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.client', () => ({
  clientIdRappi: jest.fn(),
  getRappiEnvironment: jest.fn(),
}))

import { env } from '@/config/env'
import * as rappiClient from '../../../../src/services/delivery-channels/providers/rappi/rappi.client'

const mockEnv = env as { RAPPI_CONNECT_SIGNING_KEY?: string }
const mockClient = rappiClient as unknown as { clientIdRappi: jest.Mock; getRappiEnvironment: jest.Mock }

const deps = { llave: 'k'.repeat(40), ambiente: 'SANDBOX' as const, clientId: 'cid' }
const ident = { id: 'i1', environment: 'SANDBOX', venueId: 'v1', clientId: 'cid' }

describe('rappi.connect', () => {
  it('una firma sólo vale para SU propósito', () => {
    const f = rc.firmar(deps, 'i1', 'start')
    expect(rc.leerFirma(deps, f, 'start')).toBe('i1')
    expect(rc.leerFirma(deps, f, 'callback')).toBeNull()
    expect(rc.leerFirma(deps, f.slice(0, -2) + 'xx', 'start')).toBeNull()
    expect(rc.leerFirma(deps, 42, 'start')).toBeNull()
  })

  it('el verifier es estable por intent, distinto entre intents, y de 43+ caracteres', () => {
    expect(rc.verifierDe(deps, 'i1')).toBe(rc.verifierDe(deps, 'i1'))
    expect(rc.verifierDe(deps, 'i1')).not.toBe(rc.verifierDe(deps, 'i2'))
    expect(rc.verifierDe(deps, 'i1')).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
  })

  it('el id_token cifrado sólo abre en SU fila', () => {
    const sobre = rc.cifrarIdToken(deps, ident, 'idt')
    expect(rc.descifrarIdToken(deps, { ...ident, merchantTokenEnvelope: sobre })).toBe('idt')
    expect(rc.descifrarIdToken(deps, { ...ident, venueId: 'otro', merchantTokenEnvelope: sobre })).toBeNull()
    expect(rc.descifrarIdToken({ ...deps, llave: 'z'.repeat(40) }, { ...ident, merchantTokenEnvelope: sobre })).toBeNull()
  })

  it('crea el intent como RAPPI y devuelve el enlace firmado para start', async () => {
    ;(prisma.deliveryConnectIntent.create as jest.Mock).mockResolvedValue({ id: 'i9' })
    const r = await rc.crearIntentRappi(deps, { venueId: 'v1', staffId: 's1' })
    expect((prisma.deliveryConnectIntent.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
      provider: 'RAPPI',
      environment: 'SANDBOX',
      clientId: 'cid',
      venueId: 'v1',
      staffId: 's1',
    })
    expect(rc.leerFirma(deps, r.firmado, 'start')).toBe('i9')
  })

  it('un intent de Uber no pasa la revalidación de Rappi', async () => {
    const motivo = await rc.revalidarRappi(deps, {
      id: 'u1',
      provider: 'UBER_EATS',
      environment: 'SANDBOX',
      clientId: 'cid',
      expiresAt: new Date(Date.now() + 60_000),
      state: 'CREATED',
    } as never)
    expect(motivo).toBe('WRONG_PROVIDER')
  })

  describe('depsDesdeEnv', () => {
    beforeEach(() => {
      mockEnv.RAPPI_CONNECT_SIGNING_KEY = 'k'.repeat(40)
      mockClient.clientIdRappi.mockReset().mockReturnValue('cid')
      mockClient.getRappiEnvironment.mockReset().mockReturnValue('SANDBOX')
    })

    it('arma las dependencias con llave, ambiente y clientId', async () => {
      await expect(rc.depsDesdeEnv()).resolves.toEqual({ llave: 'k'.repeat(40), ambiente: 'SANDBOX', clientId: 'cid' })
    })

    it.each([
      ['sin llave', undefined],
      ['llave vacía', '   '],
      ['llave de menos de 32 caracteres', 'k'.repeat(31)],
    ])('%s ⇒ RAPPI_CONNECT_NOT_CONFIGURED', async (_n, llave) => {
      mockEnv.RAPPI_CONNECT_SIGNING_KEY = llave
      await expect(rc.depsDesdeEnv()).rejects.toMatchObject({ statusCode: 500, code: 'RAPPI_CONNECT_NOT_CONFIGURED' })
    })

    it('sin credenciales de Rappi (clientIdRappi lanza) ⇒ RAPPI_CONNECT_NOT_CONFIGURED', async () => {
      mockClient.clientIdRappi.mockImplementation(() => {
        throw new Error('Faltan credenciales')
      })
      await expect(rc.depsDesdeEnv()).rejects.toMatchObject({ statusCode: 500, code: 'RAPPI_CONNECT_NOT_CONFIGURED' })
    })
  })
})
