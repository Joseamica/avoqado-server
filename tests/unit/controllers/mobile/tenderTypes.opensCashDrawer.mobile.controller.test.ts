/**
 * `GET /mobile/venues/:venueId/tender-types` — el campo `opensCashDrawer`.
 *
 * El POS lo usa SÓLO para decidir si abre el cajón al cobrar con ese tipo (un vale de
 * despensa que se guarda en caja sí; Uber Eats no). Nunca lo devuelve al server: la
 * semántica de dinero la sigue resolviendo el server desde la revisión del tender, así que
 * no contradice la regla de «no mandar semántica de dinero que el cliente pueda devolver».
 * Es aditivo: los POS viejos lo ignoran.
 */

import type { NextFunction, Request, Response } from 'express'

import { listTenderTypesForPos } from '@/controllers/mobile/tenderType.mobile.controller'
import * as tenderService from '@/services/dashboard/tenderType.dashboard.service'

jest.mock('@/services/dashboard/tenderType.dashboard.service', () => ({
  listTenderTypes: jest.fn(),
}))

const listMock = tenderService.listTenderTypes as unknown as jest.Mock

function row(over: Record<string, unknown>) {
  return {
    id: 't',
    revision: 1,
    name: 'X',
    isSystem: false,
    baseMethod: 'OTHER',
    captureTip: true,
    posSection: 'PRIMARY',
    displayOrder: 0,
    active: true,
    showOnPos: true,
    countsAsPhysicalCash: false,
    commissionPercent: '30.00',
    satFormaPago: '99',
    ...over,
  }
}

async function call() {
  const res = { json: jest.fn() } as unknown as Response
  const next = jest.fn() as NextFunction
  await listTenderTypesForPos({ params: { venueId: 'venue-1' } } as unknown as Request, res, next)
  expect(next).not.toHaveBeenCalled()
  return (res.json as jest.Mock).mock.calls[0][0].tenderTypes as Array<Record<string, unknown>>
}

describe('listTenderTypesForPos — opensCashDrawer', () => {
  beforeEach(() => listMock.mockReset())

  it('manda opensCashDrawer = countsAsPhysicalCash de cada tipo', async () => {
    listMock.mockResolvedValue([
      row({ id: 'cash', isSystem: true, baseMethod: 'CASH', countsAsPhysicalCash: true }),
      row({ id: 'vale', countsAsPhysicalCash: true }),
      row({ id: 'uber', countsAsPhysicalCash: false }),
    ])
    const out = await call()
    expect(out.map(t => [t.id, t.opensCashDrawer])).toEqual([
      ['cash', true],
      ['vale', true],
      ['uber', false],
    ])
  })

  it('un valor ausente o nulo se manda como false, nunca undefined', async () => {
    listMock.mockResolvedValue([row({ id: 'x', countsAsPhysicalCash: null })])
    const out = await call()
    expect(out[0].opensCashDrawer).toBe(false)
  })

  // Regresión: la forma de siempre se conserva y la semántica de dinero sigue sin viajar.
  it('conserva los campos de siempre y no filtra comisión ni forma SAT', async () => {
    listMock.mockResolvedValue([row({ id: 'uber', name: 'Uber Eats' })])
    const [t] = await call()
    expect(t).toEqual({
      id: 'uber',
      revision: 1,
      name: 'Uber Eats',
      isSystem: false,
      baseMethod: 'OTHER',
      captureTip: true,
      posSection: 'PRIMARY',
      displayOrder: 0,
      opensCashDrawer: false,
    })
  })

  it('sigue ocultando los inactivos y los que no se muestran en el POS', async () => {
    listMock.mockResolvedValue([row({ id: 'off', active: false }), row({ id: 'hidden', showOnPos: false }), row({ id: 'ok' })])
    const out = await call()
    expect(out.map(t => t.id)).toEqual(['ok'])
  })
})
