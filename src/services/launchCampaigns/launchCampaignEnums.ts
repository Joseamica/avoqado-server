/**
 * Los valores de los enums nuevos de `LaunchCampaign`, como CONSTANTES DE CADENA.
 *
 * 🔴 POR QUÉ NO SE IMPORTAN DE `@prisma/client` COMO VALORES, y no es preferencia de estilo:
 * medido el 2026-09-17 en este árbol, dentro de Jest `require('@prisma/client')` devuelve una
 * copia del cliente generado a la que le FALTAN los enums nuevos (`LaunchCampaignStatus`,
 * `OnboardingPlanActivationStatus`…), mientras `require('.prisma/client')` sí los trae. En
 * `node` a secas los dos los traen, así que producción está bien y sólo las pruebas ven el
 * hueco — que es el peor de los dos mundos: `LaunchCampaignStatus.DRAFT` vale `undefined`,
 * el `where` sale sin filtro de estado y **ninguna prueba lo grita**: pasa por otro motivo.
 *
 * La defensa es no depender del objeto en tiempo de ejecución. Los TIPOS sí se importan
 * (`import type`), así que si alguien cambia el enum en el schema, el `satisfies` de abajo
 * deja de compilar y hay que actualizar esta lista.
 */
import type { LaunchCampaignRedemptionStatus, LaunchCampaignStatus, OnboardingPlanActivationStatus } from '@prisma/client'

export const CAMPAIGN_STATUS = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  ENDED: 'ENDED',
} as const satisfies Record<LaunchCampaignStatus, LaunchCampaignStatus>

export const REDEMPTION_STATUS = {
  RESERVED: 'RESERVED',
  APPLIED: 'APPLIED',
  RELEASED: 'RELEASED',
} as const satisfies Record<LaunchCampaignRedemptionStatus, LaunchCampaignRedemptionStatus>

export const PLAN_ACTIVATION_STATUS = {
  NONE: 'NONE',
  IN_PROGRESS: 'IN_PROGRESS',
  ACTIVE: 'ACTIVE',
  DECLINED: 'DECLINED',
} as const satisfies Record<OnboardingPlanActivationStatus, OnboardingPlanActivationStatus>

export const CAMPAIGN_STATUS_VALUES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'] as const
export const CAMPAIGN_VERTICAL_VALUES = ['ALL', 'FOOD_SERVICE', 'RETAIL', 'SERVICES', 'HOSPITALITY', 'ENTERTAINMENT'] as const
export const CAMPAIGN_CHANNEL_VALUES = ['GOOGLE_ADS', 'META', 'OPENAI_ADS', 'MULTI', 'OTHER'] as const
export const REDEMPTION_STATUS_VALUES = ['RESERVED', 'APPLIED', 'RELEASED'] as const
