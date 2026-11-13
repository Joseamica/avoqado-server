/**
 * Organization Payment Config Superadmin Controller
 *
 * Manages organization-level payment configuration (merchant accounts + pricing)
 * that is inherited by all venues without their own config.
 *
 * Base path: /api/v1/dashboard/superadmin/organizations/:organizationId/payment-config
 */

import { Request, Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { AFILIACION_EN_VARIOS_SLOTS, mensajeDeSlotsRepetidos } from '@/services/shared/slotsDeAfiliacion'
import logger from '@/config/logger'
import { getOrganizationPaymentConfig, getOrganizationPricing, getVenueConfigSources } from '@/services/organization-payment-config.service'
import { exigirConfirmacionDePosiciones, leerConfirmaciones, tomarCandado } from '@/services/shared/candadoDePosiciones'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * GET /:orgId/payment-config
 * Get org payment config + pricing + venue inheritance summary.
 */
export async function getPaymentConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params

    const [config, pricing, venues] = await Promise.all([
      getOrganizationPaymentConfig(organizationId),
      getOrganizationPricing(organizationId),
      getVenueConfigSources(organizationId),
    ])

    return res.json({
      paymentConfig: config,
      pricingStructures: pricing,
      venueInheritance: venues,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /:orgId/payment-config
 * Set/update org payment config (merchant accounts).
 */
export async function setPaymentConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params
    const { primaryAccountId, secondaryAccountId, tertiaryAccountId, routingRules, preferredProcessor } = req.body

    // Verify organization exists
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    })
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' })
    }

    // Verify primary account exists and is active
    const primaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: primaryAccountId },
    })
    if (!primaryAccount || !primaryAccount.active) {
      return res.status(400).json({ error: 'Primary account not found or inactive' })
    }

    // Verify secondary/tertiary if provided
    if (secondaryAccountId) {
      const acc = await prisma.merchantAccount.findUnique({ where: { id: secondaryAccountId } })
      if (!acc || !acc.active) {
        return res.status(400).json({ error: 'Secondary account not found or inactive' })
      }
    }
    if (tertiaryAccountId) {
      const acc = await prisma.merchantAccount.findUnique({ where: { id: tertiaryAccountId } })
      if (!acc || !acc.active) {
        return res.status(400).json({ error: 'Tertiary account not found or inactive' })
      }
    }

    // Codex R12-2: una afiliación no puede ocupar dos slots (tampoco en la configuración de la organización).
    const repetidos = mensajeDeSlotsRepetidos({ primaryAccountId, secondaryAccountId, tertiaryAccountId })
    if (repetidos) {
      return res.status(400).json({ error: repetidos, code: AFILIACION_EN_VARIOS_SLOTS })
    }

    // Candado de posiciones (tarifa al comercio, paso 1): las cuentas de la organización las heredan sus negocios sin
    // configuración propia.
    const { config, positionChanges } = await prisma.$transaction(async tx => {
      const positionChanges = await exigirConfirmacionDePosiciones(tx, {
        objetivo: { organizationId },
        siguiente: { PRIMARY: primaryAccountId, SECONDARY: secondaryAccountId || null, TERTIARY: tertiaryAccountId || null },
        confirmaciones: req.body.positionConfirmations,
      })
      const config = await tx.organizationPaymentConfig.upsert({
        where: { organizationId },
        create: {
          organizationId,
          primaryAccountId,
          secondaryAccountId: secondaryAccountId || null,
          tertiaryAccountId: tertiaryAccountId || null,
          routingRules: routingRules || null,
          preferredProcessor: preferredProcessor || 'AUTO',
        },
        update: {
          primaryAccountId,
          secondaryAccountId: secondaryAccountId || null,
          tertiaryAccountId: tertiaryAccountId || null,
          routingRules: routingRules || null,
          preferredProcessor: preferredProcessor || 'AUTO',
        },
        include: {
          primaryAccount: { include: { provider: true } },
          secondaryAccount: { include: { provider: true } },
          tertiaryAccount: { include: { provider: true } },
        },
      })
      return { config, positionChanges }
    })

    logger.info(`Organization payment config set for org ${organizationId}`)
    void logAction({
      staffId: (req as any).authContext?.userId ?? null,
      organizationId,
      action: 'ORGANIZATION_PAYMENT_CONFIG_SET',
      entity: 'OrganizationPaymentConfig',
      entityId: config.id,
      data: { primaryAccountId, secondaryAccountId, tertiaryAccountId, positionChanges },
    })
    return res.json(Object.assign(config, { positionChanges }))
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /:orgId/payment-config
 * Remove org payment config.
 */
export async function deletePaymentConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params

    const existing = await prisma.organizationPaymentConfig.findUnique({
      where: { organizationId },
    })
    if (!existing) {
      return res.status(404).json({ error: 'Organization payment config not found' })
    }

    // Candado: sus negocios sin configuración propia se quedan sin cuentas heredadas.
    const positionChanges = await prisma.$transaction(async tx => {
      const cambios = await exigirConfirmacionDePosiciones(tx, {
        objetivo: { organizationId },
        siguiente: { PRIMARY: null, SECONDARY: null, TERTIARY: null },
        confirmaciones: leerConfirmaciones(req.body?.positionConfirmations),
      })
      await tx.organizationPaymentConfig.delete({ where: { organizationId } })
      return cambios
    })

    logger.info(`Organization payment config deleted for org ${organizationId}`)
    void logAction({
      staffId: (req as any).authContext?.userId ?? null,
      organizationId,
      action: 'ORGANIZATION_PAYMENT_CONFIG_DELETED',
      entity: 'OrganizationPaymentConfig',
      entityId: existing.id,
      data: { positionChanges },
    })
    return res.json({ success: true, positionChanges })
  } catch (error) {
    next(error)
  }
}

/** Escala con que Postgres guarda cada número de la tarifa de organización: así se compara «¿cambió algo?» (D18). */
const ESCALA = {
  debitRate: 4,
  creditRate: 4,
  amexRate: 4,
  internationalRate: 4,
  taxRate: 4,
  fixedFeePerTransaction: 4,
  monthlyServiceFee: 2,
  minimumMonthlyVolume: 2,
  volumePenalty: 2,
} as const

/** Cargos opcionales: el endpoint guarda `0` como null (`|| null`), así que una fila vieja con 0 es lo mismo que null. */
const OPCIONALES = new Set<keyof typeof ESCALA>(['fixedFeePerTransaction', 'monthlyServiceFee', 'minimumMonthlyVolume', 'volumePenalty'])

function mismoNumero(a: unknown, b: unknown, escala: number, opcional = false): boolean {
  const cero = (v: unknown) => v != null && new Prisma.Decimal(String(v)).isZero()
  if (opcional && cero(a)) a = null
  if (opcional && cero(b)) b = null
  if (a == null || b == null) return a == null && b == null
  return new Prisma.Decimal(String(a)).toDecimalPlaces(escala).equals(new Prisma.Decimal(String(b)).toDecimalPlaces(escala))
}

/**
 * PUT /:orgId/payment-config/pricing
 * Set/update org pricing structure.
 *
 * D18 (13-nov-2026): antes cerraba la vigente y creaba otra en CADA llamada, aunque fuera idéntica (el Wizard de Pagos la
 * llamaba en cada «Guardar»), sin bitácora, y la nueva perdía lo que la pantalla no manda (IVA, mínimos, contrato, notas).
 * Ahora: lo que no se manda se conserva de la vigente; si queda idéntica a la vigente no se escribe nada; si cambia, se
 * cierra y se crea como siempre y queda en la bitácora. Va en el candado de posiciones de la organización: dos guardados a la
 * vez se forman (no quedan dos vigentes) y la huella que confirma el candado no cambia a media confirmación.
 */
export async function setPricing(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params
    const b = req.body

    // Verify organization exists
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    })
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' })
    }

    const effectiveDate = new Date(b.effectiveFrom)

    const { pricing, previousId } = await prisma.$transaction(async tx => {
      await tomarCandado(tx, { organizationId })
      // La que rige HOY, con la regla del cobro (`getEffectivePricingForSlot`): de ella se conserva lo que no se manda y sólo
      // contra ella hay «sin cambios» (Codex r2 #4: una activa programada para mañana no cuenta como vigente).
      const ahora = new Date()
      const vigente = await tx.organizationPricingStructure.findFirst({
        where: {
          organizationId,
          accountType: b.accountType,
          active: true,
          effectiveFrom: { lte: ahora },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: ahora } }],
        },
        orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
      })
      const activas = await tx.organizationPricingStructure.count({ where: { organizationId, accountType: b.accountType, active: true } })
      const opcional = <T>(enviado: T | undefined, actual: T | null | undefined) =>
        enviado !== undefined ? enviado || null : (actual ?? null)
      const datos = {
        debitRate: b.debitRate,
        creditRate: b.creditRate,
        amexRate: b.amexRate,
        internationalRate: b.internationalRate,
        includesTax: b.includesTax !== undefined ? b.includesTax : (vigente?.includesTax ?? null),
        taxRate: b.taxRate !== undefined ? b.taxRate : vigente?.taxRate, // sin vigente: el default de la columna (0.16)
        fixedFeePerTransaction: opcional(b.fixedFeePerTransaction, vigente?.fixedFeePerTransaction),
        monthlyServiceFee: opcional(b.monthlyServiceFee, vigente?.monthlyServiceFee),
        minimumMonthlyVolume: opcional(b.minimumMonthlyVolume, vigente?.minimumMonthlyVolume),
        volumePenalty: opcional(b.volumePenalty, vigente?.volumePenalty),
        // Codex r2 #5: si no se manda, se conserva el fin que tenía la vigente (antes la sustituta nacía sin vencimiento).
        effectiveTo: b.effectiveTo !== undefined ? (b.effectiveTo ? new Date(b.effectiveTo) : null) : (vigente?.effectiveTo ?? null),
        contractReference: opcional(b.contractReference, vigente?.contractReference),
        notes: opcional(b.notes, vigente?.notes),
      }

      const sinCambios =
        activas === 1 &&
        vigente !== null &&
        // Codex r3 H5: sólo «aplicar ya» (con 5 min de margen por el reloj del navegador). Una fecha futura pedida a propósito
        // se escribe como siempre.
        effectiveDate.getTime() <= ahora.getTime() + 5 * 60_000 &&
        (Object.keys(ESCALA) as (keyof typeof ESCALA)[]).every(k => mismoNumero(datos[k], vigente[k], ESCALA[k], OPCIONALES.has(k))) &&
        datos.includesTax === vigente.includesTax &&
        datos.contractReference === vigente.contractReference &&
        datos.notes === vigente.notes &&
        (datos.effectiveTo?.getTime() ?? null) === (vigente.effectiveTo?.getTime() ?? null)
      if (sinCambios) return { pricing: vigente, previousId: undefined }

      // Deactivate previous pricing for same accountType
      await tx.organizationPricingStructure.updateMany({
        where: { organizationId, accountType: b.accountType, active: true },
        data: { active: false, effectiveTo: effectiveDate },
      })
      const creada = await tx.organizationPricingStructure.create({
        data: { organizationId, accountType: b.accountType, ...datos, effectiveFrom: effectiveDate, active: true },
      })
      return { pricing: creada, previousId: vigente?.id ?? null }
    })

    if (previousId === undefined) {
      logger.info(`Organization pricing unchanged for org ${organizationId}, accountType ${b.accountType}: nothing written`)
      return res.json(pricing)
    }

    logger.info(`Organization pricing set for org ${organizationId}, accountType ${b.accountType}`)
    void logAction({
      staffId: (req as any).authContext?.userId ?? null,
      organizationId,
      action: 'ORGANIZATION_PRICING_SET',
      entity: 'OrganizationPricingStructure',
      entityId: pricing.id,
      data: {
        accountType: b.accountType,
        previousId,
        debitRate: String(pricing.debitRate),
        creditRate: String(pricing.creditRate),
        amexRate: String(pricing.amexRate),
        internationalRate: String(pricing.internationalRate),
        includesTax: pricing.includesTax,
        taxRate: String(pricing.taxRate),
      },
      ipAddress: req.ip,
      userAgent: req.headers?.['user-agent'],
    })
    return res.json(pricing)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /:orgId/payment-config/pricing/:pricingId
 * Remove (deactivate) a pricing structure.
 */
export async function deletePricing(req: Request, res: Response, next: NextFunction) {
  try {
    const { pricingId } = req.params

    const existing = await prisma.organizationPricingStructure.findUnique({
      where: { id: pricingId },
    })
    if (!existing) {
      return res.status(404).json({ error: 'Pricing structure not found' })
    }

    await prisma.organizationPricingStructure.update({
      where: { id: pricingId },
      data: { active: false, effectiveTo: new Date() },
    })

    logger.info(`Organization pricing ${pricingId} deactivated`)
    return res.json({ success: true })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /:orgId/payment-config/venues
 * Venue inheritance status list.
 */
export async function getVenueInheritance(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params
    const sources = await getVenueConfigSources(organizationId)
    return res.json(sources)
  } catch (error) {
    next(error)
  }
}
