// tests/unit/controllers/dashboard/fiscalProfile.dashboard.controller.test.ts
//
// Datos fiscales del venue como RECEPTOR de las facturas de Avoqado.
//
// 🔴 El caso que más importa: el venueId SIEMPRE debe venir de req.params, nunca del
// body — un venue no debe poder escribir el perfil fiscal de otro venue, ni convertir
// el suyo en uno de ORGANIZATION. Ver describe('blindaje del venueId') abajo.

const mockGetBillingTaxProfileForCustomer = jest.fn()
const mockUpsertBillingTaxProfile = jest.fn()
const mockUploadConstancia = jest.fn()
const mockValidateBillingTaxProfile = jest.fn()

jest.mock('@/services/superadmin/platform-billing/billingTaxProfile.service', () => ({
  getBillingTaxProfileForCustomer: (...a: any[]) => mockGetBillingTaxProfileForCustomer(...a),
  upsertBillingTaxProfile: (...a: any[]) => mockUpsertBillingTaxProfile(...a),
  uploadConstancia: (...a: any[]) => mockUploadConstancia(...a),
  validateBillingTaxProfile: (...a: any[]) => mockValidateBillingTaxProfile(...a),
}))

// Real PlatformBillingError class (needed so `instanceof` checks in the controller work).
jest.mock('@/services/superadmin/platform-billing/platformEmisor.service', () => {
  class PlatformBillingError extends Error {
    code: string
    field?: string
    constructor(message: string, code = 'VALIDATION', field?: string) {
      super(message)
      this.name = 'PlatformBillingError'
      this.code = code
      this.field = field
    }
  }
  return { PlatformBillingError }
})

const mockActivityLogCreate = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    activityLog: { create: (...a: any[]) => mockActivityLogCreate(...a) },
  },
}))

import {
  getFiscalProfile,
  upsertFiscalProfile,
  uploadFiscalConstancia,
} from '../../../../src/controllers/dashboard/fiscalProfile.dashboard.controller'
import { PlatformBillingError } from '@/services/superadmin/platform-billing/platformEmisor.service'

// ==========================================
// HELPERS
// ==========================================

function mockRes() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

function mockNext() {
  return jest.fn()
}

const OWN_VENUE = 'venue-propio'
const OTHER_VENUE = 'venue-ajeno'

function putReq(overrides: Partial<any> = {}): any {
  return {
    params: { venueId: OWN_VENUE },
    body: {
      rfc: 'AAA010101AAA',
      razonSocial: 'Mi Negocio SA de CV',
      regimenFiscal: '601',
      codigoPostal: '64000',
      email: 'owner@example.com',
    },
    authContext: { userId: 'staff-1' },
    ...overrides,
  }
}

// ==========================================
// PUT /venues/:venueId/fiscal-profile — blindaje del venueId
// ==========================================

describe('fiscalProfile.dashboard.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockActivityLogCreate.mockResolvedValue(undefined)
  })

  describe('PUT /venues/:venueId/fiscal-profile — blindaje del venueId', () => {
    beforeEach(() => {
      mockUpsertBillingTaxProfile.mockResolvedValue({ id: 'profile-1', rfc: 'AAA010101AAA', venueId: OWN_VENUE })
      mockValidateBillingTaxProfile.mockResolvedValue({
        profile: { id: 'profile-1', rfc: 'AAA010101AAA', venueId: OWN_VENUE },
        validation: { valid: true },
      })
    })

    it('IGNORA el venueId del body y usa SIEMPRE el del parámetro de ruta', async () => {
      const req = putReq({
        params: { venueId: OWN_VENUE },
        body: { ...putReq().body, venueId: OTHER_VENUE },
      })

      const res = mockRes()
      await upsertFiscalProfile(req, res, mockNext())

      expect(mockUpsertBillingTaxProfile).toHaveBeenCalledWith(expect.objectContaining({ venueId: OWN_VENUE }))
      // El venueId del body jamás debe llegar al servicio.
      const callArg = mockUpsertBillingTaxProfile.mock.calls[0][0]
      expect(callArg.venueId).not.toBe(OTHER_VENUE)
    })

    it('IGNORA customerType del body y fuerza VENUE', async () => {
      const req = putReq({
        params: { venueId: OWN_VENUE },
        body: {
          ...putReq().body,
          customerType: 'ORGANIZATION',
          organizationId: 'org-ajena',
        },
      })

      const res = mockRes()
      await upsertFiscalProfile(req, res, mockNext())

      expect(mockUpsertBillingTaxProfile).toHaveBeenCalledWith(expect.objectContaining({ customerType: 'VENUE' }))
      const callArg = mockUpsertBillingTaxProfile.mock.calls[0][0]
      expect(callArg.customerType).toBe('VENUE')
      // organizationId nunca se lee del body — el objeto pasado al servicio ni siquiera lo declara.
      expect(callArg.organizationId).toBeUndefined()
    })

    it('devuelve el veredicto de validación junto al perfil guardado', async () => {
      const validationResult = { valid: true, matches: { rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true } }
      mockValidateBillingTaxProfile.mockResolvedValue({
        profile: { id: 'profile-1', rfc: 'AAA010101AAA', venueId: OWN_VENUE },
        validation: validationResult,
      })

      const res = mockRes()
      await upsertFiscalProfile(putReq(), res, mockNext())

      expect(mockValidateBillingTaxProfile).toHaveBeenCalledWith('profile-1')
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ id: 'profile-1' }),
          validation: validationResult,
        }),
      )
    })

    it('un fallo de validación (validation null) NO impide responder 200 con el perfil', async () => {
      mockValidateBillingTaxProfile.mockResolvedValue({
        profile: { id: 'profile-1', rfc: 'AAA010101AAA', venueId: OWN_VENUE },
        validation: null,
      })

      const res = mockRes()
      await upsertFiscalProfile(putReq(), res, mockNext())

      expect(res.status).not.toHaveBeenCalledWith(expect.not.arrayContaining([200]))
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ id: 'profile-1' }),
          validation: null,
        }),
      )
    })

    it('escribe ActivityLog con el venueId del parámetro de ruta (no el del body)', async () => {
      const req = putReq({
        params: { venueId: OWN_VENUE },
        body: { ...putReq().body, venueId: OTHER_VENUE },
      })

      const res = mockRes()
      await upsertFiscalProfile(req, res, mockNext())

      expect(mockActivityLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ venueId: OWN_VENUE, action: 'VENUE_FISCAL_PROFILE_UPSERTED' }),
        }),
      )
    })

    it('pasa sólo los campos fiscales del body al servicio (no un spread crudo)', async () => {
      const req = putReq({
        params: { venueId: OWN_VENUE },
        body: {
          rfc: 'AAA010101AAA',
          razonSocial: 'Mi Negocio SA de CV',
          regimenFiscal: '601',
          codigoPostal: '64000',
          email: 'owner@example.com',
          // Campos que NUNCA deben llegar al servicio:
          venueId: OTHER_VENUE,
          customerType: 'ORGANIZATION',
          organizationId: 'org-ajena',
        },
      })

      const res = mockRes()
      await upsertFiscalProfile(req, res, mockNext())

      const callArg = mockUpsertBillingTaxProfile.mock.calls[0][0]
      expect(callArg).toEqual(
        expect.objectContaining({
          customerType: 'VENUE',
          venueId: OWN_VENUE,
          rfc: 'AAA010101AAA',
          razonSocial: 'Mi Negocio SA de CV',
          regimenFiscal: '601',
          codigoPostal: '64000',
          email: 'owner@example.com',
          performedById: 'staff-1',
        }),
      )
      expect(callArg.organizationId).toBeUndefined()
    })

    it('devuelve 422 cuando el servicio rechaza los datos (PlatformBillingError VALIDATION)', async () => {
      mockUpsertBillingTaxProfile.mockRejectedValue(new PlatformBillingError('RFC inválido', 'VALIDATION', 'rfc'))

      const res = mockRes()
      await upsertFiscalProfile(putReq(), res, mockNext())

      expect(res.status).toHaveBeenCalledWith(422)
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'RFC inválido', field: 'rfc' }))
      expect(mockValidateBillingTaxProfile).not.toHaveBeenCalled()
    })

    it('pasa errores inesperados a next() (500 vía error handler global)', async () => {
      mockUpsertBillingTaxProfile.mockRejectedValue(new Error('DB connection failed'))

      const res = mockRes()
      const next = mockNext()
      await upsertFiscalProfile(putReq(), res, next)

      expect(next).toHaveBeenCalledWith(expect.any(Error))
      expect(res.json).not.toHaveBeenCalled()
    })
  })

  // ==========================================
  // GET /venues/:venueId/fiscal-profile
  // ==========================================

  describe('GET /venues/:venueId/fiscal-profile', () => {
    function getReq(overrides: Partial<any> = {}): any {
      return { params: { venueId: OWN_VENUE }, ...overrides }
    }

    it('lee SIEMPRE con customerType VENUE y el venueId del parámetro de ruta', async () => {
      mockGetBillingTaxProfileForCustomer.mockResolvedValue({ id: 'profile-1', venueId: OWN_VENUE })

      const res = mockRes()
      await getFiscalProfile(getReq(), res, mockNext())

      expect(mockGetBillingTaxProfileForCustomer).toHaveBeenCalledWith('VENUE', OWN_VENUE)
      expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ id: 'profile-1' }) })
    })

    it('devuelve data: null cuando el venue todavía no tiene perfil (no truena)', async () => {
      mockGetBillingTaxProfileForCustomer.mockResolvedValue(null)

      const res = mockRes()
      await getFiscalProfile(getReq(), res, mockNext())

      expect(res.json).toHaveBeenCalledWith({ success: true, data: null })
    })

    it('pasa errores inesperados a next()', async () => {
      mockGetBillingTaxProfileForCustomer.mockRejectedValue(new Error('DB down'))

      const res = mockRes()
      const next = mockNext()
      await getFiscalProfile(getReq(), res, next)

      expect(next).toHaveBeenCalledWith(expect.any(Error))
    })
  })

  // ==========================================
  // POST /venues/:venueId/fiscal-profile/constancia
  // ==========================================

  describe('POST /venues/:venueId/fiscal-profile/constancia', () => {
    function constanciaReq(overrides: Partial<any> = {}): any {
      return {
        params: { venueId: OWN_VENUE },
        body: { fileBase64: 'AAAA', contentType: 'application/pdf' },
        authContext: { userId: 'staff-1' },
        ...overrides,
      }
    }

    it('resuelve el perfil existente por el venueId del parámetro de ruta, no del body', async () => {
      mockGetBillingTaxProfileForCustomer.mockResolvedValue({ id: 'profile-1', venueId: OWN_VENUE })
      mockUploadConstancia.mockResolvedValue({ id: 'profile-1', constanciaUrl: 'https://x/y.pdf' })

      const req = constanciaReq({ body: { ...constanciaReq().body, venueId: OTHER_VENUE } })
      const res = mockRes()
      await uploadFiscalConstancia(req, res, mockNext())

      expect(mockGetBillingTaxProfileForCustomer).toHaveBeenCalledWith('VENUE', OWN_VENUE)
      expect(mockUploadConstancia).toHaveBeenCalledWith('profile-1', 'AAAA', 'application/pdf')
      expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ id: 'profile-1' }) })
    })

    it('devuelve 404 cuando el venue todavía no tiene perfil fiscal guardado', async () => {
      mockGetBillingTaxProfileForCustomer.mockResolvedValue(null)

      const res = mockRes()
      await uploadFiscalConstancia(constanciaReq(), res, mockNext())

      expect(mockUploadConstancia).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(404)
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'NO_PROFILE' }))
    })
  })
})
