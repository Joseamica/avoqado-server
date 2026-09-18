/**
 * S10 — «Activar cobros» (spec 2026-09-17 § 4.2).
 *
 * 🔴 El candado vive en el SERVICIO (`assertPaymentActivationAccess`), no aquí: es la misma
 * regla de `venueKyc.service.ts` — OWNER o ADMIN activo de ESE local, o SUPERADMIN — y no se
 * estrena un nombre de permiso, así que no hay nada que espejear en el dashboard.
 */
import { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { BadRequestError } from '../../errors/AppError'
import {
  assertPaymentActivationAccess,
  getPaymentActivation,
  updatePaymentActivationProfile,
} from '../../services/dashboard/paymentActivation.service'

export const paymentActivationProfileSchema = z.object({
  entity: z
    .object({
      entityType: z.string(),
      entitySubType: z.string().nullable().optional(),
      commercialName: z.string().trim().max(120).nullable().optional(),
    })
    .optional(),
  identity: z
    .object({
      legalFirstName: z.string().trim().min(1),
      legalLastName: z.string().trim().min(1),
      rfc: z.string().trim().nullable().optional(),
      curp: z.string().trim().nullable().optional(),
      birthdate: z.string().nullable().optional(),
      personalPhone: z.string().trim().nullable().optional(),
      legalAddress: z.string().trim().nullable().optional(),
      legalCity: z.string().trim().nullable().optional(),
      legalState: z.string().trim().nullable().optional(),
      legalCountry: z.string().trim().nullable().optional(),
      legalZipCode: z.string().trim().nullable().optional(),
    })
    .optional(),
  venueAddress: z
    .object({
      address: z.string().trim().min(1),
      city: z.string().trim().min(1),
      state: z.string().trim().min(1),
      zipCode: z.string().trim().min(1),
      country: z.string().trim().nullable().optional(),
    })
    .optional(),
  bank: z
    .object({
      clabe: z.string().trim(),
      accountHolder: z.string().trim().min(1),
      accountType: z.string().trim().nullable().optional(),
      // 🔴 `bankName` NO es adorno: es lo que `kycReview.service.ts:227` manda a la hoja de
      // Blumon. Zod descarta en silencio lo que no declara, así que sin esta línea el banco que
      // el `BankAccountStep` ya envía se perdía en la puerta y TODO local del alta corta llegaba
      // a la revisión con el banco vacío. Opcional a propósito: un banco fuera del catálogo del
      // dashboard no puede tumbar la captura de la CLABE — el servicio lo deriva de la propia
      // CLABE cuando falta.
      bankName: z.string().trim().max(120).nullable().optional(),
    })
    .optional(),
})

function actor(req: Request): { userId: string; role?: string } {
  const ctx = (req as unknown as { authContext?: { userId?: string; role?: string } }).authContext
  if (!ctx?.userId) throw new BadRequestError('Necesitas iniciar sesión')
  return { userId: ctx.userId, role: ctx.role }
}

export async function getActivation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId, role } = actor(req)
    await assertPaymentActivationAccess(req.params.venueId, userId, role)
    res.json({ success: true, data: await getPaymentActivation(req.params.venueId) })
  } catch (error) {
    next(error)
  }
}

export async function updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId, role } = actor(req)
    const { organizationId } = await assertPaymentActivationAccess(req.params.venueId, userId, role)
    const parsed = paymentActivationProfileSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('. '), 'INVALID_PAYMENT_ACTIVATION')
    }
    const data = await updatePaymentActivationProfile(req.params.venueId, organizationId, parsed.data, userId)
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
