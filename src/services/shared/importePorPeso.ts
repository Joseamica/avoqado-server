/**
 * El importe de un renglón POR PESO, en centavos (Parte 2 de las deudas del tope, 1-nov-2026).
 *
 * ANDROID, WINDOWS e iOS —las versiones en uso— cobran `round(kg × centavos/kg)` en Double, ties hacia arriba
 * (`CartItem.lineBeforeDiscountCents`, `WeightCapture.lineTotalCents`). El SERVIDOR copia ESA cuenta, no la «exacta»: la
 * exacta dejaba peor a las apps viejas (0.102 kg × $182.50 × 3 → 3 ¢ de diferencia). JS hace la misma multiplicación IEEE.
 */
import type { RequestHandler } from 'express'
import { enrichContext, getContext } from '@/observability/executionContext'
import { versionAlMenos } from '@/services/dashboard/receiptLayout/readiness.service'

export const importePorPesoCents = (precioPesos: number, kg: number): number => Math.round(kg * Math.round(precioPesos * 100))

/** La cuenta que usaba el SERVIDOR hasta el 1-nov (y la TPV todavía): pesos × kg × 100. Las ventas viejas la guardaron. */
export const importePorPesoViejoCents = (precioPesos: number, kg: number): number => Math.round(precioPesos * kg * 100)

/**
 * iOS 1.15.0–1.15.1 sacaban los centavos por kilo con `Int(precio × 100)`, que TRUNCA ($128.45 ⇒ 12844 ¢): su renglón por peso
 * cuadra con la cuenta vieja. iOS 1.15.2 (`1fe8f56`) ya redondea. Sin versión legible, iOS se queda con la vieja (= hasta hoy).
 * Se puede QUITAR cuando no quede flota iOS < 1.15.2 (30-oct: 2 aparatos, Mindform y Barbacoa Don Tino).
 */
export function esIosConPrecioTruncado(plataforma: unknown, version: unknown): boolean {
  if (typeof plataforma !== 'string' || plataforma.trim().toUpperCase() !== 'IOS') return false
  return !versionAlMenos(typeof version === 'string' ? version : null, '1.15.2')
}

/**
 * Qué cuenta toca a la petición en curso, decidida en UN lugar para todos los escritores (venta, cola, rondas de mesa, vales,
 * cobro con saldo): la TPV (lo que entra por `/tpv`, también su cola: `marcarRutaDeLaTpv`) y iOS < 1.15.2 siguen con la vieja; lo demás, la de las apps.
 * Sin contexto (scripts, pruebas) la de las apps: hoy sólo las tablets llegan a estos escritores sin pasar por la TPV.
 */
export function cuentaDePesoDeLaPeticion(): 'apps' | 'vieja' {
  const ctx = getContext()
  if (!ctx) return 'apps'
  if (ctx.rutaDeLaTpv) return 'vieja'
  return esIosConPrecioTruncado(ctx.cliente?.plataforma, ctx.cliente?.version) ? 'vieja' : 'apps'
}

/**
 * Marca la petición como de la TPV. Va en el montaje `router.use('/tpv', …)`: Express decide qué entra ahí (mayúsculas, prefijo
 * configurado, URL absoluta), así que la marca no depende de cómo venga escrita la URL (Codex parte2 r2 #1).
 */
export const marcarRutaDeLaTpv: RequestHandler = (_req, _res, next) => {
  enrichContext({ rutaDeLaTpv: true })
  next()
}

/** El importe por peso con la cuenta de la petición en curso (`cuentaDePesoDeLaPeticion`). */
export const importePorPesoDeLaPeticionCents = (precioPesos: number, kg: number): number =>
  (cuentaDePesoDeLaPeticion() === 'vieja' ? importePorPesoViejoCents : importePorPesoCents)(precioPesos, kg)
