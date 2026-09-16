/**
 * Codex R12-2: una afiliación ocupa UN solo slot de la configuración de pagos. Los tres escritores (superadmin del venue,
 * servicio del venue, organización) rechazan la configuración RESULTANTE con una cuenta repetida; el CHECK de la base
 * (`payment_config_slots_distintos`) es el respaldo contra dos ediciones concurrentes (probado en integración).
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { mensajeDeSlotsRepetidos, slotsRepetidos, AFILIACION_EN_VARIOS_SLOTS } from '@/services/shared/slotsDeAfiliacion'
import {
  updateVenuePaymentConfig as superadminUpdate,
  createVenuePaymentConfig as superadminCreate,
} from '@/services/superadmin/venuePricing.service'
import { updateVenuePaymentConfig, createVenuePaymentConfig } from '@/services/venuePaymentConfig.service'

describe('slotsDeAfiliacion (puro)', () => {
  it('detecta cada par repetido en orden fijo y deja pasar la configuración válida (los nulos no chocan entre sí)', () => {
    expect(slotsRepetidos({ primaryAccountId: 'M1', secondaryAccountId: 'M2', tertiaryAccountId: null })).toEqual([])
    expect(slotsRepetidos({ primaryAccountId: 'M1', secondaryAccountId: null, tertiaryAccountId: null })).toEqual([])
    expect(slotsRepetidos({ primaryAccountId: 'M2', secondaryAccountId: 'M2' })).toEqual([['PRIMARY', 'SECONDARY']])
    expect(slotsRepetidos({ primaryAccountId: 'M2', tertiaryAccountId: 'M2' })).toEqual([['PRIMARY', 'TERTIARY']])
    expect(slotsRepetidos({ primaryAccountId: 'M1', secondaryAccountId: 'M2', tertiaryAccountId: 'M2' })).toEqual([
      ['SECONDARY', 'TERTIARY'],
    ])
    expect(slotsRepetidos({ primaryAccountId: 'M2', secondaryAccountId: 'M2', tertiaryAccountId: 'M2' })).toHaveLength(3)
    expect(mensajeDeSlotsRepetidos({ primaryAccountId: 'M2', secondaryAccountId: 'M2' })).toMatch(/PRIMARY y SECONDARY/)
    expect(mensajeDeSlotsRepetidos({ primaryAccountId: 'M1', secondaryAccountId: 'M2' })).toBeNull()
  })
})

describe('los escritores de configuración rechazan una afiliación en dos slots', () => {
  const cuenta = { id: 'M2', active: true, providerId: 'prov', provider: { code: 'ANGELPAY' } }
  beforeEach(() => {
    ;(prismaMock as any).merchantAccount.findUnique.mockReset().mockResolvedValue(cuenta)
    ;(prismaMock as any).venuePaymentConfig.update.mockReset().mockResolvedValue({})
    ;(prismaMock as any).venuePaymentConfig.create.mockReset().mockResolvedValue({})
  })

  it('superadmin · edición PARCIAL que deja la misma cuenta en PRIMARY y SECONDARY (la existente tenía M2 en SECONDARY; la petición mueve M2 a PRIMARY y manda M2 también en SECONDARY): 400 con código y NO escribe', async () => {
    ;(prismaMock as any).venue.findUnique.mockResolvedValue({ id: 'v1', paymentConfig: null })
    ;(prismaMock as any).venuePaymentConfig.findUnique.mockResolvedValue({
      venueId: 'v1',
      primaryAccountId: 'M1',
      secondaryAccountId: 'M2',
      tertiaryAccountId: null,
    })
    await expect(superadminUpdate('v1', { primaryAccountId: 'M2', secondaryAccountId: 'M2' } as any)).rejects.toMatchObject({
      code: AFILIACION_EN_VARIOS_SLOTS,
    })
    expect((prismaMock as any).venuePaymentConfig.update).not.toHaveBeenCalled()
  })

  it('superadmin · alta con la misma cuenta en dos slots: 400 con código y NO crea', async () => {
    ;(prismaMock as any).venue.findUnique.mockResolvedValue({ id: 'v1', paymentConfig: null })
    await expect(superadminCreate({ venueId: 'v1', primaryAccountId: 'M2', tertiaryAccountId: 'M2' } as any)).rejects.toMatchObject({
      code: AFILIACION_EN_VARIOS_SLOTS,
    })
    expect((prismaMock as any).venuePaymentConfig.create).not.toHaveBeenCalled()
  })

  it('servicio del venue · la edición parcial se juzga sobre la configuración RESULTANTE (la existente tenía M2 en TERTIARY; la petición manda M2 en SECONDARY sin tocar TERTIARY): rechaza', async () => {
    ;(prismaMock as any).venuePaymentConfig.findUnique.mockResolvedValue({
      id: 'cfg',
      primaryAccountId: 'M1',
      secondaryAccountId: null,
      tertiaryAccountId: 'M2',
    })
    await expect(updateVenuePaymentConfig('cfg', { secondaryAccountId: 'M2' } as any)).rejects.toMatchObject({
      code: AFILIACION_EN_VARIOS_SLOTS,
    })
    expect((prismaMock as any).venuePaymentConfig.update).not.toHaveBeenCalled()
  })

  it('servicio del venue · alta con la misma cuenta en PRIMARY y SECONDARY: rechaza', async () => {
    ;(prismaMock as any).venue.findUnique.mockResolvedValue({ id: 'v1' })
    ;(prismaMock as any).venuePaymentConfig.findUnique.mockResolvedValue(null)
    await expect(
      createVenuePaymentConfig({ venueId: 'v1', primaryAccountId: 'M2', secondaryAccountId: 'M2' } as any),
    ).rejects.toMatchObject({ code: AFILIACION_EN_VARIOS_SLOTS })
    expect((prismaMock as any).venuePaymentConfig.create).not.toHaveBeenCalled()
  })

  it('organización · el controlador rechaza con 400 y código sin escribir', async () => {
    const { setPaymentConfig } = await import('@/controllers/dashboard/organization-payment.superadmin.controller')
    ;(prismaMock as any).organization.findUnique.mockResolvedValue({ id: 'org' })
    ;(prismaMock as any).organizationPaymentConfig.upsert.mockReset()
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
    const req: any = {
      params: { organizationId: 'org' },
      body: { primaryAccountId: 'M2', secondaryAccountId: 'M2' },
      authContext: { userId: 'u' },
    }
    await setPaymentConfig(req, res, jest.fn())
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: AFILIACION_EN_VARIOS_SLOTS }))
    expect((prismaMock as any).organizationPaymentConfig.upsert).not.toHaveBeenCalled()
  })
})
