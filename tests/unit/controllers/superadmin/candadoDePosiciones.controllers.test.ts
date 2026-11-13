/**
 * Tarifa al comercio, paso 1 — el candado en los controladores (12-nov-2026).
 *
 * 1. Asistente Blumon: la revisión previa del candado corre ANTES del paso 1 (consultar a Blumon) y, si pide confirmar, no
 *    se crea cuenta, ni se tocan terminales, ni se escribe la posición (Codex p12-r1 #6 / r2 #1).
 * 2. El controlador del DASHBOARD (`/dashboard/venues/:id/payment-config`) deja pasar el código y el detalle del candado (antes
 *    respondía 400 genérico y la pantalla no podía preguntar). Los demás errores siguen como antes.
 */
import type { NextFunction, Request, Response } from 'express'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

jest.mock('@/services/shared/candadoDePosiciones', () => ({
  ...jest.requireActual('@/services/shared/candadoDePosiciones'),
  exigirConfirmacionDePosiciones: jest.fn(),
}))
jest.mock('@/services/tpv/blumon-tpv.service', () => ({ createBlumonTpvService: jest.fn() }))
jest.mock('@/services/venuePaymentConfig.service', () => ({
  updateVenuePaymentConfig: jest.fn(),
  createVenuePaymentConfig: jest.fn(),
  deleteVenuePaymentConfig: jest.fn(),
}))

import { exigirConfirmacionDePosiciones, CONFIRMAR_POSICION, POSICION_DESACTUALIZADA } from '@/services/shared/candadoDePosiciones'
import { createBlumonTpvService } from '@/services/tpv/blumon-tpv.service'
import * as venuePaymentConfigService from '@/services/venuePaymentConfig.service'
import { fullSetupBlumonMerchant } from '@/controllers/superadmin/merchantAccount.controller'
import { updateVenuePaymentConfig } from '@/controllers/venuePaymentConfig.controller'

const mockedExigir = exigirConfirmacionDePosiciones as jest.Mock
const mockedBlumon = createBlumonTpvService as jest.Mock
const mockedPrisma = prisma as unknown as Record<string, Record<string, jest.Mock>>

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r as Response & { status: jest.Mock; json: jest.Mock }
}

describe('asistente Blumon: revisión previa del candado antes del paso 1', () => {
  beforeEach(() => {
    mockedPrisma.paymentProvider.findUnique.mockResolvedValue({ id: 'prov-blumon' })
    mockedPrisma.merchantAccount.findFirst.mockResolvedValue(null)
    mockedPrisma.venuePaymentConfig.findUnique.mockResolvedValue({ id: 'cfg-1' })
  })

  const req = {
    body: {
      serialNumber: '2841548417',
      brand: 'PAX',
      model: 'A910S',
      environment: 'SANDBOX',
      target: { type: 'venue', id: 'venue-1' },
      accountSlot: 'PRIMARY',
    },
    ip: '127.0.0.1',
    headers: {},
  } as unknown as Request

  it('si el candado pide confirmar, no consulta a Blumon ni escribe nada', async () => {
    const error = new BadRequestError('Confirma', CONFIRMAR_POSICION, { positions: [] })
    mockedExigir.mockRejectedValueOnce(error)
    const next = jest.fn() as unknown as NextFunction
    await fullSetupBlumonMerchant(req, res(), next)
    expect(next).toHaveBeenCalledWith(error)
    expect(mockedExigir).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ objetivo: { venueId: 'venue-1' }, siguiente: { PRIMARY: '__CUENTA_NUEVA__' }, soloRevisar: true }),
    )
    expect(mockedBlumon).not.toHaveBeenCalled()
    // full-testing D3: es una respuesta normal, no un error con stack
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('candado de posiciones'),
      expect.objectContaining({ code: CONFIRMAR_POSICION }),
    )
    expect(logger.error).not.toHaveBeenCalledWith('[Full Setup] Failed', expect.anything())
    expect(mockedPrisma.merchantAccount.create).not.toHaveBeenCalled()
    expect(mockedPrisma.venuePaymentConfig.update).not.toHaveBeenCalled()
    expect(mockedPrisma.terminal.update).not.toHaveBeenCalled()
  })

  it('sin configuración propia, la revisión ve que las otras posiciones dejan de heredarse', async () => {
    mockedPrisma.venuePaymentConfig.findUnique.mockResolvedValue(null)
    mockedExigir.mockRejectedValueOnce(new BadRequestError('Confirma', CONFIRMAR_POSICION))
    await fullSetupBlumonMerchant(req, res(), jest.fn())
    expect(mockedExigir.mock.calls[0][1].siguiente).toEqual({ PRIMARY: '__CUENTA_NUEVA__', SECONDARY: null, TERTIARY: null })
  })

  it('con `venuePricing` en la petición, la tarifa de esa posición cuenta como capturada (como hoy)', async () => {
    mockedExigir.mockRejectedValueOnce(new BadRequestError('x', CONFIRMAR_POSICION))
    await fullSetupBlumonMerchant({ ...req, body: { ...req.body, venuePricing: { debitRate: 2 } } } as Request, res(), jest.fn())
    expect(mockedExigir.mock.calls[0][1].tarifaCapturada).toEqual(['PRIMARY'])
  })

  it('una posición inválida se rechaza antes de todo', async () => {
    const next = jest.fn()
    await fullSetupBlumonMerchant({ ...req, body: { ...req.body, accountSlot: 'CUARTA' } } as Request, res(), next)
    expect(next.mock.calls[0][0]).toBeInstanceOf(BadRequestError)
    expect(mockedExigir).not.toHaveBeenCalled()
  })
})

describe('controlador del DASHBOARD de configuración de pagos: código y detalle del candado', () => {
  const req = { params: { venueId: 'venue-1', configId: 'cfg-1' }, body: { primaryAccountId: 'acc-2' } } as unknown as Request

  it('400 CONFIRMAR_POSICION llega con su código y su detalle', async () => {
    const details = { positions: [{ slot: 'PRIMARY' }] }
    ;(venuePaymentConfigService.updateVenuePaymentConfig as jest.Mock).mockRejectedValueOnce(
      new BadRequestError('Confirma la tarifa', CONFIRMAR_POSICION, details),
    )
    const r = res()
    await updateVenuePaymentConfig(req, r)
    expect(r.status).toHaveBeenCalledWith(400)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: CONFIRMAR_POSICION, details, error: 'Confirma la tarifa' }))
    // full-testing D3: aviso sin stack, nunca `error`
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Candado de posiciones'),
      expect.objectContaining({ code: CONFIRMAR_POSICION }),
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('409 POSICION_DESACTUALIZADA conserva su 409', async () => {
    ;(venuePaymentConfigService.updateVenuePaymentConfig as jest.Mock).mockRejectedValueOnce(
      new ConflictError('Recarga', POSICION_DESACTUALIZADA, {}),
    )
    const r = res()
    await updateVenuePaymentConfig(req, r)
    expect(r.status).toHaveBeenCalledWith(409)
  })

  it('cualquier otro error responde como antes (400 genérico, sin código)', async () => {
    ;(venuePaymentConfigService.updateVenuePaymentConfig as jest.Mock).mockRejectedValueOnce(new Error('Payment config not found'))
    const r = res()
    await updateVenuePaymentConfig(req, r)
    expect(r.status).toHaveBeenCalledWith(400)
    expect(r.json).toHaveBeenCalledWith({ success: false, error: 'Payment config not found' })
    expect(logger.error).toHaveBeenCalled() // un error de verdad sigue registrándose como error
  })

  it('una confirmación mal formada se rechaza en español', async () => {
    const r = res()
    await updateVenuePaymentConfig(
      { ...req, body: { positionConfirmations: { PRIMARY: { inheritingTerminals: 'dos' } } } } as unknown as Request,
      r,
    )
    expect(r.status).toHaveBeenCalledWith(400)
    expect(r.json.mock.calls[0][0].error).toMatch(/Confirmación de posiciones inválida/)
  })
})
