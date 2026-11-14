/**
 * D10 (14-nov-2026): el asistente Blumon del SUPERADMIN, en un negocio (u organización) SIN configuración de pagos propia y
 * con la posición Secundaria o Terciaria, intentaba crearla con la cuenta principal vacía (`primaryAccountId: ''`). La llave
 * foránea la rechazaba (P2003): no quedaba nada roto, pero el asistente tronaba con un error genérico DESPUÉS de consultar a
 * Blumon y de crear la cuenta. Ahora responde 400 en español ANTES de todo, igual que el asistente de AngelPay
 * (`angelpayFullSetup.service.ts`), y la transacción vuelve a revisarlo por si la configuración desapareció en medio.
 */
import type { Request, Response } from 'express'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/superadmin/credencialesDeBlumon', () => ({
  credencialesDeBlumon: jest.fn(),
}))
jest.mock('@/services/shared/candadoDePosiciones', () => ({
  ...jest.requireActual('@/services/shared/candadoDePosiciones'),
  exigirConfirmacionDePosiciones: jest.fn(),
  tomarCandado: jest.fn(),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { credencialesDeBlumon } from '@/services/superadmin/credencialesDeBlumon'
import { exigirConfirmacionDePosiciones } from '@/services/shared/candadoDePosiciones'
import { fullSetupBlumonMerchant } from '@/controllers/superadmin/merchantAccount.controller'

const mockedBlumon = credencialesDeBlumon as jest.Mock
const mockedExigir = exigirConfirmacionDePosiciones as jest.Mock
const db = prisma as unknown as Record<string, Record<string, jest.Mock>>

const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as unknown as Response

async function correr(target: { type: 'venue' | 'organization'; id: string }, accountSlot: string) {
  let error: any
  const body = { serialNumber: 'D10-SERIAL', brand: 'PAX', model: 'A910S', environment: 'SANDBOX', target, accountSlot }
  await fullSetupBlumonMerchant(
    { body, params: {}, query: {}, ip: '127.0.0.1', headers: {}, user: { uid: 'sa' } } as unknown as Request,
    res(),
    (e?: unknown) => (error = e),
  )
  return error
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedBlumon.mockResolvedValue({ posId: 'pos-1', serialNumber: 'D10-SERIAL', dukptKeysAvailable: false, credentials: {} })
  mockedExigir.mockResolvedValue([])
  db.paymentProvider.findUnique.mockResolvedValue({ id: 'prov-blumon' })
  db.merchantAccount.findFirst.mockResolvedValue({ id: 'ma-1', displayName: 'Blumon PAX' })
  db.venuePaymentConfig.findUnique.mockResolvedValue(null)
  db.organizationPaymentConfig.findUnique.mockResolvedValue(null)
})

describe('asistente Blumon: sin configuración propia, la primera cuenta va en la Principal', () => {
  it.each(['SECONDARY', 'TERTIARY'])('negocio sin configuración + %s ⇒ 400 en español antes de consultar a Blumon', async slot => {
    const error = await correr({ type: 'venue', id: 'venue-1' }, slot)

    expect(error.statusCode).toBe(400)
    expect(error.message).toBe(
      'Este negocio todavía no tiene cuentas de cobro propias: la primera cuenta tiene que ir en la posición «Principal».',
    )
    expect(mockedBlumon).not.toHaveBeenCalled()
    expect(mockedExigir).not.toHaveBeenCalled()
    expect(db.venuePaymentConfig.create).not.toHaveBeenCalled()
  })

  it('organización sin configuración + Secundaria ⇒ el mismo 400, dicho para la organización', async () => {
    const error = await correr({ type: 'organization', id: 'org-1' }, 'SECONDARY')

    expect(error.statusCode).toBe(400)
    expect(error.message).toMatch(/^Esta organización todavía no tiene cuentas de cobro propias/)
    expect(mockedBlumon).not.toHaveBeenCalled()
    expect(db.organizationPaymentConfig.create).not.toHaveBeenCalled()
  })

  // La cuenta de Blumon del paso 2 ya existe a esta altura y se queda sin posición, igual que cuando el candado rechaza
  // (Codex p12-r2 #1; Codex D10 r1): el reintento la reutiliza. Aquí se garantiza que la configuración no se escribe.
  it('si la configuración desaparece entre la revisión y la escritura, la transacción responde el mismo 400 sin escribir la configuración', async () => {
    db.venuePaymentConfig.findUnique.mockResolvedValueOnce({ id: 'cfg-1' }).mockResolvedValueOnce(null)

    const error = await correr({ type: 'venue', id: 'venue-1' }, 'SECONDARY')

    expect(error.statusCode).toBe(400)
    expect(error.message).toMatch(/posición «Principal»/)
    expect(db.venuePaymentConfig.create).not.toHaveBeenCalled()
    expect(db.venuePaymentConfig.update).not.toHaveBeenCalled()
    expect(mockedExigir).toHaveBeenCalledTimes(1) // sólo la revisión previa; la de la transacción no llega
  })

  // Regresión: lo que ya funcionaba sigue igual.
  it('negocio sin configuración + Principal ⇒ la crea con esa cuenta como principal (como hoy)', async () => {
    await correr({ type: 'venue', id: 'venue-1' }, 'PRIMARY')

    expect(mockedBlumon).toHaveBeenCalled()
    expect(db.venuePaymentConfig.create).toHaveBeenCalledWith({ data: { venueId: 'venue-1', primaryAccountId: 'ma-1' } })
  })

  it('organización sin configuración + Principal ⇒ la crea con esa cuenta como principal (como hoy)', async () => {
    await correr({ type: 'organization', id: 'org-1' }, 'PRIMARY')

    expect(db.organizationPaymentConfig.create).toHaveBeenCalledWith({
      data: { organizationId: 'org-1', primaryAccountId: 'ma-1' },
    })
  })

  it('negocio CON configuración + Secundaria ⇒ sólo llena esa posición (como hoy)', async () => {
    db.venuePaymentConfig.findUnique.mockResolvedValue({ id: 'cfg-1' })

    await correr({ type: 'venue', id: 'venue-1' }, 'SECONDARY')

    expect(mockedBlumon).toHaveBeenCalled()
    expect(db.venuePaymentConfig.update).toHaveBeenCalledWith({
      where: { venueId: 'venue-1' },
      data: { secondaryAccountId: 'ma-1' },
    })
    expect(db.venuePaymentConfig.create).not.toHaveBeenCalled()
  })
})
