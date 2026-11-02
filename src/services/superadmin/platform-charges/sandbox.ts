/**
 * «Por cobrar» — modo de prueba del flujo (spec 2026-11-02-por-cobrar-superadmin §6, «Modo de prueba»).
 *
 * `PLATFORM_CHARGES_SANDBOX=true` hace que TODA llamada a Facturapi de este flujo vaya con `sandbox: true`. Sin esa variable, el
 * flujo siempre es real. Sólo el servidor de QA la lleva.
 *
 * 🔴 `sandbox: true` NO garantiza nada por sí solo: `resolveFacturapiKey` usa primero la llave guardada del emisor, aunque se pida
 * sandbox, y entonces se timbraría de verdad creyendo que es una prueba. Por eso, con la variable puesta, el flujo se NIEGA a
 * trabajar si el servidor es de producción o si el emisor trae su llave guardada.
 *
 * Vive en su propio módulo (sin dependencias del flujo) para que `platformCfdi.service.ts` y `invoice.service.ts` lo compartan sin
 * importarse entre sí.
 */
import type { PlatformEmisor } from '@prisma/client'
import { PlatformBillingError } from '@/services/superadmin/platform-billing/platformEmisor.service'

/**
 * `true` sólo con `PLATFORM_CHARGES_SANDBOX=true` (exactamente ese valor); lanza si además `NODE_ENV` es `production` o el emisor
 * trae `providerKeyEnc`. Se lee de `process.env` en cada llamada, no al cargar el módulo.
 */
export function chargesSandbox(emisor: Pick<PlatformEmisor, 'providerKeyEnc'>): boolean {
  if (process.env.PLATFORM_CHARGES_SANDBOX !== 'true') return false
  if (process.env.NODE_ENV === 'production') {
    throw new PlatformBillingError(
      'PLATFORM_CHARGES_SANDBOX está activa en un servidor de producción; «Por cobrar» se niega a facturar. Quita esa variable del servidor.',
      'VALIDATION',
    )
  }
  if (emisor.providerKeyEnc) {
    throw new PlatformBillingError(
      'PLATFORM_CHARGES_SANDBOX está activa pero el emisor trae su llave de Facturapi guardada, y con ella se timbraría de verdad aunque sea una prueba; «Por cobrar» se niega a facturar. Usa un emisor sin llave guardada.',
      'VALIDATION',
    )
  }
  return true
}
