/**
 * La configuración de pagos dice DE DÓNDE sale (encargo e12dc4, tarjeta hz:87f4b879:D11, 13-nov-2026).
 *
 * El GET de configuración de pagos de un negocio devuelve la de su ORGANIZACIÓN cuando el negocio no tiene propia
 * (`getEffectivePaymentConfig`). Antes la respuesta no lo decía y las pantallas la editaban como si fuera del negocio:
 * guardar fallaba (PUT sobre una fila que no es del negocio) o, peor, alguien creía que cambiaba sólo ese negocio.
 * Ahora las dos lecturas (DASHBOARD y SUPERADMIN) agregan `configSource: 'venue' | 'organization'`, campo nuevo y
 * opcional: lo demás de la respuesta queda igual para los clientes que ya la leen.
 */
jest.mock('@/services/organization-payment-config.service', () => ({
  getEffectivePaymentConfig: jest.fn(),
}))

import { getEffectivePaymentConfig } from '@/services/organization-payment-config.service'
import * as dashboardService from '@/services/venuePaymentConfig.service'
import * as superadminService from '@/services/superadmin/venuePricing.service'

const mockedEffective = getEffectivePaymentConfig as jest.Mock

const configDelNegocio = { id: 'cfg-venue', venueId: 'v1', primaryAccountId: 'm1', secondaryAccountId: null, tertiaryAccountId: null }
const configDeLaOrganizacion = {
  id: 'cfg-org',
  organizationId: 'o1',
  primaryAccountId: 'm2',
  secondaryAccountId: 'm3',
  tertiaryAccountId: null,
}

describe.each([
  ['DASHBOARD (/dashboard/venues/:id/payment-config)', dashboardService.getVenuePaymentConfig],
  ['SUPERADMIN (/superadmin/venue-pricing/config/:id)', superadminService.getVenuePaymentConfig],
])('%s', (_nombre, leer) => {
  beforeEach(() => mockedEffective.mockReset())

  it('la heredada de la organización dice configSource «organization»', async () => {
    mockedEffective.mockResolvedValue({ config: configDeLaOrganizacion, source: 'organization' })
    const config = await leer('v1')
    expect(config).toMatchObject({ id: 'cfg-org', configSource: 'organization' })
  })

  it('la propia del negocio dice configSource «venue»', async () => {
    mockedEffective.mockResolvedValue({ config: configDelNegocio, source: 'venue' })
    const config = await leer('v1')
    expect(config).toMatchObject({ id: 'cfg-venue', configSource: 'venue' })
  })

  // Regresión: los campos de antes siguen iguales (apps y pantallas viejas los leen tal cual).
  it('conserva todos los campos que ya devolvía', async () => {
    mockedEffective.mockResolvedValue({ config: configDeLaOrganizacion, source: 'organization' })
    const config = await leer('v1')
    expect(config).toEqual({ ...configDeLaOrganizacion, configSource: 'organization' })
  })

  it('sin configuración en ningún nivel sigue devolviendo null', async () => {
    mockedEffective.mockResolvedValue(null)
    expect(await leer('v1')).toBeNull()
  })
})
