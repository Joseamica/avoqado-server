import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import {
  getActivePlatformEmisor,
  upsertPlatformEmisorLegal,
  provisionPlatformEmisor,
  setPlatformEmisorProviderManual,
  uploadPlatformEmisorCsd,
  PlatformBillingError,
} from '@/services/superadmin/platform-billing/platformEmisor.service'
import {
  upsertBillingTaxProfile,
  getBillingTaxProfileById,
  getBillingTaxProfileForCustomer,
  attachConstancia,
  searchBillingCustomers,
} from '@/services/superadmin/platform-billing/billingTaxProfile.service'
import {
  issuePlatformCfdi,
  listPlatformCfdis,
  getPlatformCfdi,
  cancelPlatformCfdi,
  fetchPlatformCfdiArtifact,
  registerPlatformPayment,
  listPlatformCfdiPayments,
  sendPlatformCfdiEmail,
} from '@/services/superadmin/platform-billing/platformCfdi.service'
import type { BillingCustomerKind } from '@/services/superadmin/platform-billing/types'

/** Map a typed PlatformBillingError to an HTTP status; otherwise defer to the global handler. */
function handleBillingError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof PlatformBillingError) {
    const status = error.code === 'NO_CFDI' ? 404 : error.code === 'PROVIDER' ? 502 : 422
    res.status(status).json({ success: false, error: error.message, code: error.code })
    return
  }
  next(error as Error)
}

// ── Emisor (Avoqado) ────────────────────────────────────────────────────────

/** GET /api/v1/superadmin/billing/emisor */
export async function getEmisor(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await getActivePlatformEmisor() })
  } catch (error) {
    next(error)
  }
}

/** PUT /api/v1/superadmin/billing/emisor */
export async function upsertEmisor(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = (req as any).authContext
    const emisor = await upsertPlatformEmisorLegal(req.body, userId)
    await prisma.activityLog.create({
      data: {
        staffId: userId,
        action: 'PLATFORM_EMISOR_UPSERTED',
        entity: 'PlatformEmisor',
        entityId: emisor.id,
        data: { rfc: emisor.rfc },
      },
    })
    res.json({ success: true, data: emisor })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/billing/emisor/provision — provision in Facturapi OR bind an existing org/key. */
export async function provisionEmisor(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = (req as any).authContext
    const emisor = await getActivePlatformEmisor()
    if (!emisor) throw new PlatformBillingError('Primero captura los datos del emisor', 'NO_EMISOR')

    const { providerOrgId, liveKey } = req.body as { providerOrgId?: string; liveKey?: string }
    const updated =
      providerOrgId && liveKey
        ? await setPlatformEmisorProviderManual(emisor.id, providerOrgId, liveKey)
        : await provisionPlatformEmisor(emisor.id)

    await prisma.activityLog.create({
      data: {
        staffId: userId,
        action: 'PLATFORM_EMISOR_PROVISIONED',
        entity: 'PlatformEmisor',
        entityId: updated.id,
        data: { manual: Boolean(providerOrgId && liveKey), providerOrgId: updated.providerOrgId },
      },
    })
    res.json({ success: true, data: updated })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/billing/emisor/csd */
export async function uploadCsd(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = (req as any).authContext
    const emisor = await getActivePlatformEmisor()
    if (!emisor) throw new PlatformBillingError('Primero captura los datos del emisor', 'NO_EMISOR')
    const updated = await uploadPlatformEmisorCsd(emisor.id, req.body)
    await prisma.activityLog.create({
      data: {
        staffId: userId,
        action: 'PLATFORM_CSD_UPLOADED',
        entity: 'PlatformEmisor',
        entityId: updated.id,
        data: { csdExpiresAt: updated.csdExpiresAt },
      },
    })
    res.json({ success: true, data: updated })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

// ── Receptores (tax profiles) ────────────────────────────────────────────────

/** GET /api/v1/superadmin/billing/customers?type=&q= */
export async function searchCustomers(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, q } = req.query as { type?: BillingCustomerKind; q?: string }
    res.json({ success: true, data: await searchBillingCustomers(type, q) })
  } catch (error) {
    next(error)
  }
}

/** GET /api/v1/superadmin/billing/customers/:type/:id/tax-profile — resolve a profile for an org/venue. */
export async function getTaxProfileForCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, id } = req.params as { type: BillingCustomerKind; id: string }
    res.json({ success: true, data: await getBillingTaxProfileForCustomer(type, id) })
  } catch (error) {
    next(error)
  }
}

/** PUT /api/v1/superadmin/billing/tax-profiles — upsert a receptor profile (org / venue / standalone). */
export async function upsertTaxProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = (req as any).authContext
    const profile = await upsertBillingTaxProfile({ ...req.body, performedById: userId })
    await prisma.activityLog.create({
      data: {
        staffId: userId,
        venueId: profile.venueId,
        action: 'PLATFORM_TAXPROFILE_UPSERTED',
        entity: 'BillingTaxProfile',
        entityId: profile.id,
        data: { customerType: profile.customerType, rfc: profile.rfc },
      },
    })
    res.json({ success: true, data: profile })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/billing/tax-profiles/:id/constancia */
export async function attachConstanciaController(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await attachConstancia(req.params.id, req.body.constanciaUrl)
    res.json({ success: true, data: profile })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

// ── Facturas (CFDIs) ─────────────────────────────────────────────────────────

/** POST /api/v1/superadmin/billing/invoices — issue + stamp an income CFDI (PUE/PPD). */
export async function issueInvoice(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = (req as any).authContext
    const cfdi = await issuePlatformCfdi({
      ...req.body,
      idempotencyKey: req.body.idempotencyKey ?? randomUUID(),
      performedById: userId,
    })
    await prisma.activityLog.create({
      data: {
        staffId: userId,
        venueId: cfdi.venueId,
        action: 'PLATFORM_CFDI_ISSUED',
        entity: 'PlatformCfdi',
        entityId: cfdi.id,
        data: { uuid: cfdi.uuid, totalCents: cfdi.totalCents, metodoPago: cfdi.metodoPago, formaPago: cfdi.formaPago },
      },
    })
    res.status(201).json({ success: true, data: cfdi })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** GET /api/v1/superadmin/billing/invoices?status=&type=&organizationId=&venueId=&page=&pageSize= */
export async function listInvoices(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, type, organizationId, venueId, page, pageSize } = req.query as Record<string, string | undefined>
    const result = await listPlatformCfdis({
      status,
      type,
      organizationId,
      venueId,
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 20,
    })
    res.json({ success: true, data: result.rows, meta: { total: result.total, page: result.page, pageSize: result.pageSize } })
  } catch (error) {
    next(error)
  }
}

/** GET /api/v1/superadmin/billing/invoices/:id */
export async function getInvoice(req: Request, res: Response, next: NextFunction) {
  try {
    const cfdi = await getPlatformCfdi(req.params.id)
    if (!cfdi) {
      res.status(404).json({ success: false, error: 'CFDI no encontrado' })
      return
    }
    // Income CFDIs include their payment complements (REPs) for the detail view.
    const payments = cfdi.type === 'INGRESO' ? await listPlatformCfdiPayments(cfdi.id) : []
    res.json({ success: true, data: { ...cfdi, payments } })
  } catch (error) {
    next(error)
  }
}

/** POST /api/v1/superadmin/billing/invoices/:id/payments — register a payment → stamp a REP (PPD only). */
export async function registerPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = (req as any).authContext
    const { paymentDate, formaPago, amountCents, idempotencyKey } = req.body as {
      paymentDate: string
      formaPago: string
      amountCents?: number
      idempotencyKey?: string
    }
    const rep = await registerPlatformPayment({
      platformCfdiId: req.params.id,
      paymentDate,
      formaPago,
      amountCents,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      performedById: userId,
    })
    await prisma.activityLog.create({
      data: {
        staffId: userId,
        venueId: rep.venueId,
        action: 'PLATFORM_PAYMENT_RECEIVED',
        entity: 'PlatformCfdi',
        entityId: rep.id,
        data: { parentId: rep.parentPlatformCfdiId, uuid: rep.uuid },
      },
    })
    res.status(201).json({ success: true, data: rep })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/billing/invoices/:id/email — (re)enviar el CFDI por correo al receptor. */
export async function sendInvoiceEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = (req as any).authContext
    const { email } = req.body as { email?: string }
    const cfdi = await sendPlatformCfdiEmail(req.params.id, email)
    await prisma.activityLog.create({
      data: {
        staffId: userId,
        venueId: cfdi.venueId,
        action: 'PLATFORM_CFDI_EMAILED',
        entity: 'PlatformCfdi',
        entityId: cfdi.id,
        data: { email: email ?? null },
      },
    })
    res.json({ success: true, data: cfdi })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/billing/invoices/:id/cancel */
export async function cancelInvoice(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = (req as any).authContext
    const { motivo, substituteUuid } = req.body as { motivo: '01' | '02' | '03' | '04'; substituteUuid?: string }
    const cfdi = await cancelPlatformCfdi(req.params.id, motivo, substituteUuid)
    await prisma.activityLog.create({
      data: {
        staffId: userId,
        venueId: cfdi.venueId,
        action: 'PLATFORM_CFDI_CANCELLED',
        entity: 'PlatformCfdi',
        entityId: cfdi.id,
        data: { motivo, substituteUuid: substituteUuid ?? null },
      },
    })
    res.json({ success: true, data: cfdi })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** GET /api/v1/superadmin/billing/invoices/:id/pdf | /xml */
function downloadArtifact(kind: 'pdf' | 'xml') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buffer, filename, contentType } = await fetchPlatformCfdiArtifact(req.params.id, kind)
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(buffer)
    } catch (error) {
      handleBillingError(error, res, next)
    }
  }
}

export const downloadPdf = downloadArtifact('pdf')
export const downloadXml = downloadArtifact('xml')

// Re-export for routes that read a profile by its own id.
export async function getTaxProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await getBillingTaxProfileById(req.params.id)
    if (!profile) {
      res.status(404).json({ success: false, error: 'Perfil fiscal no encontrado' })
      return
    }
    res.json({ success: true, data: profile })
  } catch (error) {
    next(error)
  }
}
