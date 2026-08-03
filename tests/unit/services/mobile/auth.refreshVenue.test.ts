/**
 * Renovar la sesión NO puede mudarla de local.
 *
 * El bug: `refreshAccessToken` tomaba siempre `staff.venues[0]`. Nadie tenía que
 * tocar nada — bastaba con dejar la app abierta hasta que expirara el access
 * token, y a partir de ahí el token decía un local y la app operaba en otro.
 *
 * Casi todo seguía "funcionando" porque el server lee el venue de la URL, así
 * que el desajuste era invisible. Menos en `sync/intents`, la única ruta que
 * compara la URL contra el token: respondía 403 en bucle, y los cobros hechos
 * sin red se quedaban atorados en el outbox sin subir NUNCA. Medido en un
 * dispositivo real: 23 rechazos seguidos en una sola sesión.
 */
import prisma from '../../../../src/utils/prismaClient'
import * as jwtService from '../../../../src/jwt.service'
import { refreshAccessToken } from '../../../../src/services/mobile/auth.mobile.service'

const prismaMock = prisma as any

const venue = (id: string) => ({
  venueId: id,
  role: 'WAITER',
  venue: { id, status: 'ACTIVE', organizationId: 'org_1', timezone: 'America/Mexico_City' },
})

// El staff trabaja en tres locales. El PRIMERO es el que el bug imponía siempre.
const STAFF = {
  id: 'staff_1',
  email: 'mesero@local.com',
  active: true,
  venues: [venue('venue_primero'), venue('venue_donde_trabaja'), venue('venue_tercero')],
}

/** El venueId que quedó sellado en el access token que se acaba de emitir. */
function venueDelTokenEmitido(): string {
  const call = (jwtService.generateAccessToken as jest.Mock).mock.calls.at(-1)!
  return call[2] as string
}

beforeEach(() => {
  jest.restoreAllMocks()
  prismaMock.staff.findUnique.mockReset()
  prismaMock.staff.findUnique.mockResolvedValue(STAFF)
  jest.spyOn(jwtService, 'generateAccessToken').mockReturnValue('access-nuevo')
  jest.spyOn(jwtService, 'generateRefreshToken').mockReturnValue('refresh-nuevo')
})

describe('refreshAccessToken — el venue de la sesión', () => {
  it('conserva el venue que traía el refresh token', () => {
    jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({
      sub: STAFF.id,
      tokenId: 't1',
      venueId: 'venue_donde_trabaja',
    } as any)

    return refreshAccessToken('cualquier-refresh').then(() => {
      expect(venueDelTokenEmitido()).toBe('venue_donde_trabaja')
    })
  })

  it('sella el venue en el NUEVO refresh token, para que no se pierda al siguiente ciclo', async () => {
    jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({
      sub: STAFF.id,
      tokenId: 't1',
      venueId: 'venue_donde_trabaja',
    } as any)

    await refreshAccessToken('cualquier-refresh')

    // Sin esto el venue se conserva UNA vez y se pierde en la renovación siguiente.
    const call = (jwtService.generateRefreshToken as jest.Mock).mock.calls.at(-1)!
    expect(call[3]).toBe('venue_donde_trabaja')
  })

  it('honra el venue que pide el cliente al CAMBIAR de local', async () => {
    jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({
      sub: STAFF.id,
      tokenId: 't1',
      venueId: 'venue_donde_trabaja',
    } as any)

    await refreshAccessToken('cualquier-refresh', 'venue_tercero')

    expect(venueDelTokenEmitido()).toBe('venue_tercero')
  })

  it('rechaza el cambio a un local donde el staff NO trabaja', async () => {
    jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({
      sub: STAFF.id,
      tokenId: 't1',
      venueId: 'venue_donde_trabaja',
    } as any)

    await expect(refreshAccessToken('cualquier-refresh', 'venue_de_otra_empresa')).rejects.toThrow(/acceso/i)
  })

  it('cae al primer venue sólo con tokens viejos, que no lo traen', async () => {
    // Compatibilidad: los refresh tokens emitidos antes de este cambio no llevan
    // venueId. Deben seguir funcionando, no reventar.
    jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({ sub: STAFF.id, tokenId: 't1' } as any)

    await refreshAccessToken('refresh-viejo')

    expect(venueDelTokenEmitido()).toBe('venue_primero')
  })

  it('ignora un venue que el staff ya NO tiene activo y no se queda sin sesión', async () => {
    // Lo echaron de ese local: el token viejo lo sigue nombrando, pero ya no
    // aparece en `venues`. Debe degradar al primero, no dejarlo sin entrar.
    jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({
      sub: STAFF.id,
      tokenId: 't1',
      venueId: 'venue_del_que_lo_sacaron',
    } as any)

    await refreshAccessToken('cualquier-refresh')

    expect(venueDelTokenEmitido()).toBe('venue_primero')
  })
})
