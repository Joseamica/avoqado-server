/**
 * Apagador del SDK propio (fase 3, bloque 2a, S4): `inHouseSdkEnabled` es una llave RESERVADA. Sólo viaja en la raíz de /config,
 * desde la columna `Terminal.inHouseSdkEnabled` y el freno. Lo que el aparato mande en `PUT /tpv/terminals/:serial/settings` no se
 * guarda (igual que `cashReconciliationEnabled`), y el lector compartido de ajustes guardados (`getTpvSettings`, que usan el
 * DASHBOARD, el SUPERADMIN y el POS móvil) no la devuelve aunque una ficha vieja ya la traiga en su JSON.
 */
import type { NextFunction, Request, Response } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'
import { updateTpvSettings } from '@/controllers/tpv/terminal.tpv.controller'
import { getTpvSettings } from '@/services/dashboard/tpv.dashboard.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const venueId = 'venue-sdk-propio'
const serialNumber = 'AVQD-9900000450'

function makeRes(): Response & { __status: number; __body: any } {
  const res: any = { __status: 0, __body: null }
  res.status = jest.fn((code: number) => {
    res.__status = code
    return res
  })
  res.json = jest.fn((body: any) => {
    res.__body = body
    return res
  })
  return res
}

describe('PUT /tpv/terminals/:serial/settings (el aparato)', () => {
  it('no guarda inHouseSdkEnabled, ni la que manda ni la que ya estaba guardada; lo demás sí', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: 'terminal-sdk-1',
      venueId,
      config: { settings: { showTipScreen: true, inHouseSdkEnabled: true } },
      configOverrides: { showTipScreen: true, inHouseSdkEnabled: true },
      venue: { organizationId: null },
    })
    prismaMock.terminal.update.mockResolvedValue({})

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await updateTpvSettings(
      {
        params: { serialNumber },
        body: { showTipScreen: false, inHouseSdkEnabled: true },
        authContext: { userId: 'staff-1', venueId, role: 'MANAGER' },
      } as unknown as Request,
      res,
      next,
    )

    expect(next).not.toHaveBeenCalled()
    expect(res.__status).toBe(200)
    const write = prismaMock.terminal.update.mock.calls[0][0].data
    expect(write.config.settings).not.toHaveProperty('inHouseSdkEnabled')
    expect(write.config.settings.showTipScreen).toBe(false)
    // Lo único distinto del default (`showTipScreen: true`) es la propina; la llave reservada no entra aunque ya estuviera.
    expect(write.configOverrides).toEqual({ showTipScreen: false })
    expect(res.__body.data).not.toHaveProperty('inHouseSdkEnabled')
    expect(res.__body.data.showTipScreen).toBe(false)
  })
})

describe('getTpvSettings (el lector compartido del DASHBOARD, el SUPERADMIN y el POS móvil)', () => {
  it('una ficha que ya trae inHouseSdkEnabled en su JSON ⇒ no la devuelve; lo demás igual', async () => {
    prismaMock.terminal.findUnique.mockResolvedValue({
      config: { settings: { showTipScreen: false, inHouseSdkEnabled: true } },
      configOverrides: null,
    })

    const ajustes = await getTpvSettings('terminal-sdk-2', { venueId })

    expect(ajustes).not.toHaveProperty('inHouseSdkEnabled')
    expect(ajustes.showTipScreen).toBe(false)
    expect(ajustes.trackPromoterLocationOverride).toBeNull()
  })
})
