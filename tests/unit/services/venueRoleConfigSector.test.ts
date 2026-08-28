/**
 * Los nombres de rol que sirve el endpoint de configuracion deben salir del GIRO del negocio
 * cuando el venue no ha personalizado nada.
 *
 * 🔴 El bug que originó estas pruebas (visto capturando la guía de equipo, 27-ago-2026):
 * `getVenueRoleConfigs` leía el venue con `select: { id: true }` y rellenaba los roles no
 * configurados con `DEFAULT_ROLE_DISPLAY_NAMES`, una lista fija de restaurante. Una ESTÉTICA
 * veía a su especialista como «Mesero» y una TIENDA también.
 *
 * 🔴 Y lo peor: como el servidor devuelve SIEMPRE una fila por rol, el dashboard las trata
 * como «override del venue» y ganan sobre cualquier default que el front intente aplicar.
 * El escalón «default del giro» era inalcanzable — arreglarlo en el dashboard no bastaba.
 *
 * `SECTOR_ROLE_DEFAULTS` ya existía en `utils/roleDisplay.ts`; sólo nadie lo conectaba aquí.
 */
import { StaffRole } from '@prisma/client'

import { getVenueRoleConfigs } from '@/services/dashboard/venueRoleConfig.dashboard.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueRoleConfig: { findMany: jest.fn() },
  },
}))

const venueMock = prisma.venue.findUnique as jest.Mock
const cfgMock = prisma.venueRoleConfig.findMany as jest.Mock

function conGiro(type: string | null) {
  venueMock.mockResolvedValue({ id: 'v1', type })
  cfgMock.mockResolvedValue([])
}
const nombre = (cfgs: Array<{ role: string; displayName: string }>, role: StaffRole) =>
  cfgs.find(c => c.role === role)!.displayName

beforeEach(() => jest.clearAllMocks())

describe('los nombres de rol siguen el giro del negocio', () => {
  it('una estética NO llama «Mesero» a su gente', async () => {
    conGiro('SALON')
    const cfgs = await getVenueRoleConfigs('v1')
    expect(nombre(cfgs, StaffRole.WAITER)).toBe('Especialista')
  })

  it('una tienda dice «Vendedor»', async () => {
    conGiro('RETAIL_STORE')
    expect(nombre(await getVenueRoleConfigs('v1'), StaffRole.WAITER)).toBe('Vendedor')
  })

  it('un restaurante sigue igual — este cambio no le toca nada', async () => {
    conGiro('RESTAURANT')
    const cfgs = await getVenueRoleConfigs('v1')
    expect(nombre(cfgs, StaffRole.WAITER)).toBe('Mesero')
    expect(nombre(cfgs, StaffRole.KITCHEN)).toBe('Cocina')
  })

  it('🔴 los 3 tipos que existen en VenueType y NO en BusinessType no revientan', async () => {
    // TELECOMUNICACIONES, HOTEL_RESTAURANT y FITNESS_STUDIO sólo existen en VenueType:
    // pasárselos a getBusinessCategory() sin cuidado tira la consulta entera.
    for (const t of ['TELECOMUNICACIONES', 'HOTEL_RESTAURANT', 'FITNESS_STUDIO']) {
      conGiro(t)
      const cfgs = await getVenueRoleConfigs('v1')
      expect(cfgs).toHaveLength(Object.values(StaffRole).length)
      expect(nombre(cfgs, StaffRole.WAITER)).toBeTruthy()
    }
  })

  it('un gimnasio es SERVICIOS, no comida', async () => {
    conGiro('FITNESS_STUDIO')
    expect(nombre(await getVenueRoleConfigs('v1'), StaffRole.WAITER)).toBe('Especialista')
  })

  it('sin giro no revienta: cae al default de siempre', async () => {
    conGiro(null)
    expect(nombre(await getVenueRoleConfigs('v1'), StaffRole.WAITER)).toBe('Mesero')
  })

  it('lo que el venue personalizó SIGUE ganando sobre el giro', async () => {
    venueMock.mockResolvedValue({ id: 'v1', type: 'SALON' })
    cfgMock.mockResolvedValue([
      { role: StaffRole.WAITER, displayName: 'Estilista', description: null, icon: null, color: null, isActive: true, sortOrder: 5 },
    ])
    expect(nombre(await getVenueRoleConfigs('v1'), StaffRole.WAITER)).toBe('Estilista')
  })

  it('los roles administrativos NO cambian con el giro', async () => {
    conGiro('SALON')
    const cfgs = await getVenueRoleConfigs('v1')
    expect(nombre(cfgs, StaffRole.OWNER)).toBe('Propietario')
    expect(nombre(cfgs, StaffRole.MANAGER)).toBe('Gerente')
  })
})
