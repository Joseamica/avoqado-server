// tests/unit/controllers/mobile/settingsSinPlan.test.ts
import type { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/dashboard/tpv.dashboard.service', () => ({ getTpvSettings: jest.fn() }))

import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'

/**
 * 🔴 Codex r3 N2, contra el controlador REAL de `/settings` y el lector REAL del plan (sólo la base simulada): una rama del plan
 * falla al instante y otra se queda en la base. `/settings` sigue SIN plan, a propósito (un POS sin ajustes no cobra), y no
 * puede esperar a la rama lenta. La TPV (`terminal.tpv.controller.ts:423-442`) usa el mismo patrón y la cubre la prueba del
 * lector «sin la opción, se rinde al PRIMER fallo».
 */
const vaciar = async () => {
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
}
function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn((b: unknown) => ((r.body = b), r))
  return r as Response & { body: any }
}

it('🔴 una rama del plan falla YA y otra sigue en la base: /settings responde SIN plan, sin esperarla', async () => {
  let soltar!: (v: unknown) => void
  prismaMock.hybridContract.findFirst.mockRejectedValueOnce(new Error('base caída')) // la rama que falla primero
  prismaMock.capabilityGrant.findFirst.mockReturnValueOnce(new Promise(r => (soltar = r)) as any) // la que se queda viva
  prismaMock.capabilityGrant.groupBy.mockResolvedValue([] as any)
  prismaMock.venueFeature.findMany.mockResolvedValue([] as any)
  prismaMock.venue.findUnique.mockResolvedValue(null as any)
  prismaMock.terminal.findMany.mockResolvedValue([] as any)
  prismaMock.venueSettings.findUnique.mockResolvedValue(null as any)
  prismaMock.receiptLayout.findUnique.mockResolvedValue(null as any)
  const r = res()
  const hecho = getVenueTpvSettings({ params: { venueId: 'v1' }, headers: {} } as unknown as Request, r, jest.fn() as NextFunction)
  await vaciar()
  expect(r.json).toHaveBeenCalled() // ya respondió, con la rama del contrato todavía en la base
  expect(r.body.data).not.toHaveProperty('plan')
  soltar(null)
  await hecho
})
