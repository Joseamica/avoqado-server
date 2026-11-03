/** PUT /superadmin/billing/tax-profiles: lo que el SAT rechazó no se guardó, así que tampoco se registra. */
jest.mock('@/services/superadmin/platform-billing/billingTaxProfile.service', () => ({
  ...jest.requireActual('@/services/superadmin/platform-billing/billingTaxProfile.service'),
  saveBillingTaxProfileIfSatAccepts: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import type { NextFunction, Request, Response } from 'express'
import { saveBillingTaxProfileIfSatAccepts } from '@/services/superadmin/platform-billing/billingTaxProfile.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { upsertTaxProfile } from '@/controllers/superadmin/platformBilling.controller'

const save = saveBillingTaxProfileIfSatAccepts as jest.Mock
const log = logAction as jest.Mock

async function put(body: object) {
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response
  const next = jest.fn() as unknown as NextFunction
  await upsertTaxProfile({ body, authContext: { userId: 'staff1' } } as unknown as Request, res, next)
  return { json: (res.json as jest.Mock).mock.calls[0]?.[0], next }
}

const PERFIL = { id: 'v1', venueId: 'venue1', customerType: 'VENUE', rfc: 'BUE010101AAA' }
const RECHAZO = { valid: false, errors: [{ field: 'rfc', message: 'El RFC no existe' }] }

describe('upsertTaxProfile', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 el SAT rechaza: contesta el perfil como estaba con su veredicto, y no registra nada', async () => {
    save.mockResolvedValue({ saved: false, profile: PERFIL, validation: RECHAZO })

    const { json } = await put({ customerType: 'VENUE' })

    expect(json).toEqual({ success: true, data: PERFIL, validation: RECHAZO })
    expect(log).not.toHaveBeenCalled()
  })

  it('🔴 un externo rechazado que no existía contesta `data: null`', async () => {
    save.mockResolvedValue({ saved: false, profile: null, validation: RECHAZO })

    const { json } = await put({ customerType: 'STANDALONE' })

    expect(json).toEqual({ success: true, data: null, validation: RECHAZO })
    expect(log).not.toHaveBeenCalled()
  })

  it('lo guardado se registra, con quién lo hizo', async () => {
    save.mockResolvedValue({ saved: true, profile: PERFIL, validation: { valid: true, errors: [] } })

    const { json } = await put({ customerType: 'VENUE' })

    expect(json.data).toBe(PERFIL)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ performedById: 'staff1' }))
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'staff1', venueId: 'venue1', action: 'PLATFORM_TAXPROFILE_UPSERTED', entityId: 'v1' }),
    )
  })

  it('el SAT no contestó: se guarda, se registra y contesta `validation: null`', async () => {
    save.mockResolvedValue({ saved: true, profile: PERFIL, validation: null })

    const { json } = await put({ customerType: 'VENUE' })

    expect(json).toEqual({ success: true, data: PERFIL, validation: null })
    expect(log).toHaveBeenCalledTimes(1)
  })
})
