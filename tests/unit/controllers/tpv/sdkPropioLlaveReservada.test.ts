/**
 * Apagador del SDK propio (fase 3, bloque 2a, S4): `inHouseSdkEnabled` es una llave RESERVADA. Sólo viaja en la raíz de /config,
 * desde la columna `Terminal.inHouseSdkEnabled` y el freno. Lo que el aparato mande en `PUT /tpv/terminals/:serial/settings` no se
 * guarda (igual que `cashReconciliationEnabled`), y el lector compartido de ajustes guardados (`getTpvSettings`, que usan el
 * DASHBOARD, el SUPERADMIN y el POS móvil) no la devuelve aunque una ficha vieja ya la traiga en su JSON.
 */
import type { NextFunction, Request, Response } from 'express'

import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { updateTpvSettings } from '@/controllers/tpv/terminal.tpv.controller'
import { getTpvSettings, updateTpvSettings as guardarAjustes } from '@/services/dashboard/tpv.dashboard.service'
import { configSinLlaveReservada } from '@/lib/llaveReservadaSdkPropio'

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

/** Un cuerpo JSON con `__proto__`: la llave llegaría como propiedad HEREDADA de las excepciones calculadas (Codex r3, S4-c). */
const conProto = () => JSON.parse('{"showTipScreen": false, "__proto__": {"inHouseSdkEnabled": true}}')

describe('ronda 3 · las excepciones (configOverrides) se escriben como copia propia, sin la llave ni heredada', () => {
  it('PUT del aparato con `__proto__` en el cuerpo', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: 'terminal-sdk-3',
      venueId,
      config: { settings: { showTipScreen: true } },
      configOverrides: null,
      venue: { organizationId: null },
    })
    prismaMock.terminal.update.mockResolvedValue({})
    const res = makeRes()
    await updateTpvSettings(
      { params: { serialNumber }, body: conProto(), authContext: { userId: 'staff-1', venueId, role: 'MANAGER' } } as unknown as Request,
      res,
      jest.fn() as NextFunction,
    )
    const write = prismaMock.terminal.update.mock.calls[0][0].data
    expect(write.configOverrides).not.toHaveProperty('inHouseSdkEnabled')
    expect(write.configOverrides.showTipScreen).toBe(false)
  })

  it('updateTpvSettings del servicio (DASHBOARD, SUPERADMIN y POS móvil) con `__proto__` en el cuerpo', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 't1', venueId }]),
      terminal: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ venueId, config: { settings: {} }, configOverrides: null, venue: { organizationId: null } }),
        update: jest.fn().mockResolvedValue({}),
      },
      organizationAttendanceConfig: { findUnique: jest.fn().mockResolvedValue(null) },
    }
    prismaMock.$transaction.mockImplementation((cb: any) => cb(tx))

    await guardarAjustes('t1', conProto(), { venueId })

    const write = tx.terminal.update.mock.calls[0][0].data
    expect(write.configOverrides).not.toHaveProperty('inHouseSdkEnabled')
    expect(write.configOverrides.showTipScreen).toBe(false)
  })
})

describe('ronda 3 · configSinLlaveReservada', () => {
  it('quita la llave de la RAÍZ y de settings, y deja todo lo demás', () => {
    expect(
      configSinLlaveReservada({ inHouseSdkEnabled: true, otra: 1, settings: { inHouseSdkEnabled: true, showTipScreen: false } }),
    ).toEqual({
      otra: 1,
      settings: { showTipScreen: false },
    })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['un arreglo', [1, 2]],
    ['Prisma.JsonNull', Prisma.JsonNull],
  ])('con %s regresa lo mismo que recibió', (_caso, config) => {
    expect(configSinLlaveReservada(config)).toBe(config)
  })
})
