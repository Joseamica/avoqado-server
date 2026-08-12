/**
 * Datos fiscales del venue como RECEPTOR de las facturas de Avoqado.
 *
 * Esta superficie NO emite CFDIs: por eso no pide ni acepta CSD (.cer/.key). El venue
 * sólo declara con qué datos quiere que Avoqado le facture. Emitir (autofactura) vive
 * en otro lado y sí requiere certificados.
 *
 * 🔴 El venueId SIEMPRE viene de req.params. Nunca del body: un venue no puede escribir
 * el perfil de otro, ni convertir el suyo en uno de ORGANIZATION.
 */
import { Request, Response, NextFunction } from 'express'
import {
  getBillingTaxProfileForCustomer,
  upsertBillingTaxProfile,
  uploadConstancia,
  validateBillingTaxProfile,
} from '@/services/superadmin/platform-billing/billingTaxProfile.service'
import { PlatformBillingError } from '@/services/superadmin/platform-billing/platformEmisor.service'
import prisma from '@/utils/prismaClient'

function handleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof PlatformBillingError) {
    const status = error.code === 'NO_CFDI' || error.code === 'NO_PROFILE' ? 404 : error.code === 'PROVIDER' ? 502 : 422
    res.status(status).json({ success: false, error: error.message, code: error.code, field: error.field })
    return
  }
  next(error as Error)
}

/** GET /api/v1/dashboard/venues/:venueId/fiscal-profile */
export async function getFiscalProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await getBillingTaxProfileForCustomer('VENUE', req.params.venueId)
    res.json({ success: true, data: profile })
  } catch (error) {
    handleError(error, res, next)
  }
}

/** PUT /api/v1/dashboard/venues/:venueId/fiscal-profile */
export async function upsertFiscalProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = (req as any).authContext
    const { venueId } = req.params

    // 🔴 Sólo se toman los campos fiscales del body. customerType/venueId/organizationId
    // se fijan aquí, no se leen del cliente.
    const saved = await upsertBillingTaxProfile({
      customerType: 'VENUE',
      venueId,
      rfc: req.body.rfc,
      razonSocial: req.body.razonSocial,
      regimenFiscal: req.body.regimenFiscal,
      codigoPostal: req.body.codigoPostal,
      defaultUsoCfdi: req.body.defaultUsoCfdi,
      email: req.body.email,
      performedById: userId,
    })

    await prisma.activityLog.create({
      data: {
        staffId: userId,
        venueId,
        action: 'VENUE_FISCAL_PROFILE_UPSERTED',
        entity: 'BillingTaxProfile',
        entityId: saved.id,
        data: { rfc: saved.rfc },
      },
    })

    const { profile, validation } = await validateBillingTaxProfile(saved.id)
    res.json({ success: true, data: profile, validation })
  } catch (error) {
    handleError(error, res, next)
  }
}

/** POST /api/v1/dashboard/venues/:venueId/fiscal-profile/constancia */
export async function uploadFiscalConstancia(req: Request, res: Response, next: NextFunction) {
  try {
    const existing = await getBillingTaxProfileForCustomer('VENUE', req.params.venueId)
    if (!existing) throw new PlatformBillingError('Primero guarda tus datos fiscales', 'NO_PROFILE')
    const updated = await uploadConstancia(existing.id, req.body.fileBase64, req.body.contentType)
    res.json({ success: true, data: updated })
  } catch (error) {
    handleError(error, res, next)
  }
}
