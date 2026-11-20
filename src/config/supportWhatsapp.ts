import { Prisma } from '@prisma/client'
import { z } from 'zod'
import logger from '@/config/logger'

export interface SupportPricing {
  model: string
  version: string
  maxInputTokens: number
  maxOutputTokens: number
  longContextAfter: number
  inputUsd: string
  outputUsd: string
  cachedUsd: string
  write30mUsd: string
  write12hUsd: string
}
export interface SupportAiConfig {
  apiKey: string
  monthlyLimitUsd: Prisma.Decimal
  pricing: SupportPricing
}
export const LUNA_SUPPORT_PRICING: SupportPricing = {
  model: 'gpt-6-luna',
  version: 'openai-luna-2026-11-08',
  maxInputTokens: 1_050_000,
  maxOutputTokens: 1000,
  longContextAfter: 272_000,
  inputUsd: '0.10',
  outputUsd: '0.50',
  cachedUsd: '0.01',
  write30mUsd: '0.125',
  write12hUsd: '0.25',
}
/**
 * T-F14 (ruling T-P1, 18-nov): el asistente de soporte tiene su PROPIO número de WhatsApp.
 * - SUPPORT_WHATSAPP_PHONE_NUMBER_ID: el id que Meta le da a ese número (no su teléfono). El soporte sólo escucha mensajes que
 *   llegan a él y sólo manda desde él. Sin él, el soporte queda apagado.
 * - Tiene que ser distinto del central (WHATSAPP_PHONE_NUMBER_ID, el que manda reservaciones, recibos y códigos a clientes
 *   finales) y del de ventas (WHATSAPP_SALES_PHONE_NUMBER_ID). Si es igual a cualquiera de los dos, aquí vale null y el soporte
 *   queda apagado: un cliente que contesta su reservación nunca recibe el aviso del asistente.
 * - SUPPORT_WHATSAPP_ACCESS_TOKEN (opcional): el token del usuario del sistema de Meta del soporte («avoqado-soporte»). Sin él,
 *   el soporte usa WHATSAPP_ACCESS_TOKEN. Ese usuario necesita la app, la cuenta de WhatsApp y la cuenta de mensajes del número.
 */
export function supportPhoneNumberId(): string | null {
  const id = process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID?.trim()
  const taken = [process.env.WHATSAPP_PHONE_NUMBER_ID, process.env.WHATSAPP_SALES_PHONE_NUMBER_ID].map(v => v?.trim())
  return id && !taken.includes(id) ? id : null
}
/**
 * T-F15: SUPPORT_WHATSAPP_DISPLAY_NUMBER, el número del soporte como lo ve la gente (p. ej. «+1 555 788 4728»), para la tarjeta
 * del panel con su liga `https://wa.me/<dígitos>`. Internacional: «+», dígitos, espacios y guiones, de 8 a 15 dígitos (wa.me pide
 * la lada del país). Ausente o inválido → null (un inválido se avisa una vez en el log, por su nombre).
 */
export function supportDisplayNumber(): { display: string; waMe: string } | null {
  const display = process.env.SUPPORT_WHATSAPP_DISPLAY_NUMBER?.trim() ?? ''
  const digits = display.replace(/\D/g, '')
  if (/^\+\d[\d -]*\d$/.test(display) && digits.length >= 8 && digits.length <= 15) return { display, waMe: `https://wa.me/${digits}` }
  if (display) invalidSetting('SUPPORT_WHATSAPP_DISPLAY_NUMBER')
  return null
}
export const supportWhatsappAccessToken = (): string =>
  process.env.SUPPORT_WHATSAPP_ACCESS_TOKEN?.trim() || process.env.WHATSAPP_ACCESS_TOKEN?.trim() || ''
export function isSupportWhatsappEnabled(): boolean {
  return (
    process.env.SUPPORT_WHATSAPP_ENABLED === 'true' &&
    !!supportPhoneNumberId() &&
    /^[a-f0-9]{64}$/i.test(process.env.SUPPORT_WHATSAPP_ENC_KEY ?? '')
  )
}
/**
 * SUPPORT_WHATSAPP_FREE_TEXT_ENABLED: producción la necesita en `true`. Sin texto libre, el número propio del soporte sólo atiende
 * AYUDA (y lo que sigue en esa plática); cualquier otro mensaje sin plática abierta queda registrado como ignorado (T-F15).
 */
export function isSupportFreeTextEnabled(): boolean {
  return process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED === 'true'
}
/** Modo híbrido (entender → redactar → juez). Sin texto libre no hay híbrido: depende de él. */
export function isSupportHybridEnabled(): boolean {
  return process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED === 'true' && isSupportFreeTextEnabled()
}
export interface SupportHandoffConfig {
  /** SUPPORT_HANDOFF_EMAIL_TO: obligatoria; sin ella no hay aviso por correo. */
  to: string
  /** SUPPORT_HANDOFF_WHATSAPP: el número desde el que escribe la persona del equipo. */
  whatsappDisplay: string
  phoneDailyCap: number
  dailyCap: number
  /** Hora de America/Mexico_City a la que sale el reporte semanal. */
  weeklyHour: number
}
const HANDOFF_WHATSAPP_DEFAULT = '+52 56 4007 0001'
const warned = new Set<string>()
/** A set value that is not valid: logged once per process by its name, never its value (it may be an email or what customers are told). */
function invalidSetting(variable: string) {
  if (warned.has(variable)) return
  warned.add(variable)
  logger.warn('Support handoff setting invalid; its default applies', { variable, code: 'SUPPORT_HANDOFF_CONFIG_INVALID' })
}
/** Entero escrito con dígitos y dentro del rango; cualquier otra cosa usa su valor por defecto (vacío = no puesto). */
function boundedInt(variable: string, min: number, max: number, fallback: number): number {
  const text = process.env[variable]?.trim() ?? ''
  const value = /^\d{1,4}$/.test(text) ? Number(text) : NaN
  if (value >= min && value <= max) return value
  if (text) invalidSetting(variable)
  return fallback
}
/** Pasar a una persona: null salvo con el soporte prendido (en su número), el modo híbrido y un correo de destino válido. */
export function getSupportHandoffConfig(): SupportHandoffConfig | null {
  const to = process.env.SUPPORT_HANDOFF_EMAIL_TO?.trim() ?? ''
  if (!isSupportWhatsappEnabled() || !isSupportHybridEnabled()) return null
  if (!z.string().email().safeParse(to).success) {
    // Without a valid address the handoff stays off, as today.
    if (to) invalidSetting('SUPPORT_HANDOFF_EMAIL_TO')
    return null
  }
  const display = process.env.SUPPORT_HANDOFF_WHATSAPP?.trim() ?? ''
  const shown = /^\+?\d[\d ()-]{5,22}\d$/.test(display)
  if (display && !shown) invalidSetting('SUPPORT_HANDOFF_WHATSAPP')
  return {
    to,
    whatsappDisplay: shown ? display : HANDOFF_WHATSAPP_DEFAULT,
    phoneDailyCap: boundedInt('SUPPORT_HANDOFF_PHONE_DAILY_CAP', 1, 50, 3),
    dailyCap: boundedInt('SUPPORT_HANDOFF_DAILY_CAP', 1, 500, 20),
    weeklyHour: boundedInt('SUPPORT_WEEKLY_REPORT_HOUR', 0, 23, 9),
  }
}
export interface SupportDataConfig {
  /** SUPPORT_DATA_DAILY_CAP: lecturas por persona y día. */
  dailyCap: number
  /** SUPPORT_DATA_FRESH_MINUTES, en ms. */
  freshMs: number
  /** SUPPORT_DATA_ROWS. */
  rows: number
  /** SUPPORT_DATA_OPEN_ORDERS_DAYS. */
  openOrdersDays: number
  /** SUPPORT_DATA_QUERY_TIMEOUT_SECONDS (5 a 30), en ms. */
  queryTimeoutMs: number
  /** SUPPORT_DATA_DEPOSIT_GROUPS: tope de grupos de «lo que cae esta semana». */
  depositGroups: number
  /** SUPPORT_DATA_DEPOSIT_TIMEOUT_SECONDS, en ms: statement_timeout de esa lectura. A lo más `queryTimeoutMs − 4 s` (C6 r1). */
  depositTimeoutMs: number
}
/**
 * El mínimo de SUPPORT_DATA_QUERY_TIMEOUT_SECONDS. Por encima del tope de Stripe de «estado del plan» (C5, `STRIPE_TIMEOUT_MS`, 3 s):
 * con menos, la lectura se cortaría antes que Stripe y la persona recibiría «No pude leer ese dato» en vez del plan sin fecha. Lo
 * amarra `tests/unit/services/support/config.test.ts`.
 */
export const SUPPORT_DATA_QUERY_TIMEOUT_MIN_SECONDS = 5
/** La B (datos de la cuenta): null salvo con el soporte prendido, el modo híbrido y SUPPORT_DATA_ENABLED. Un número inválido usa su default. */
export function getSupportDataConfig(): SupportDataConfig | null {
  if (!isSupportWhatsappEnabled() || !isSupportHybridEnabled() || process.env.SUPPORT_DATA_ENABLED !== 'true') return null
  const queryTimeoutMs = boundedInt('SUPPORT_DATA_QUERY_TIMEOUT_SECONDS', SUPPORT_DATA_QUERY_TIMEOUT_MIN_SECONDS, 30, 8) * 1000
  return {
    dailyCap: boundedInt('SUPPORT_DATA_DAILY_CAP', 1, 500, 60),
    freshMs: boundedInt('SUPPORT_DATA_FRESH_MINUTES', 1, 60, 10) * 60_000,
    rows: boundedInt('SUPPORT_DATA_ROWS', 1, 5, 5),
    openOrdersDays: boundedInt('SUPPORT_DATA_OPEN_ORDERS_DAYS', 1, 31, 7),
    queryTimeoutMs,
    depositGroups: boundedInt('SUPPORT_DATA_DEPOSIT_GROUPS', 1, 9999, 2000),
    // C6 r1: la base corta esa lectura antes de que `within` conteste (al tope de la lectura), así su transacción nunca retiene una
    // conexión del pool cuando la persona ya recibió «No pude leer ese dato». Con el mínimo de lectura (5 s), 1 s.
    depositTimeoutMs: Math.min(boundedInt('SUPPORT_DATA_DEPOSIT_TIMEOUT_SECONDS', 1, 30, 3) * 1000, queryTimeoutMs - 4_000),
  }
}
export const isSupportDataEnabled = (): boolean => getSupportDataConfig() !== null
export function getSupportAiConfig(): SupportAiConfig | null {
  const limit = process.env.SUPPORT_AI_MONTHLY_USD_LIMIT ?? '0'
  if (
    !isSupportWhatsappEnabled() ||
    process.env.SUPPORT_AI_ENABLED !== 'true' ||
    process.env.SUPPORT_AI_MODEL !== LUNA_SUPPORT_PRICING.model ||
    process.env.SUPPORT_AI_PRICING_VERSION !== LUNA_SUPPORT_PRICING.version ||
    !process.env.SUPPORT_OPENAI_API_KEY?.trim() ||
    !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/.test(limit)
  )
    return null
  const monthlyLimitUsd = new Prisma.Decimal(limit)
  return monthlyLimitUsd.gt(0)
    ? { apiKey: process.env.SUPPORT_OPENAI_API_KEY.trim(), monthlyLimitUsd, pricing: LUNA_SUPPORT_PRICING }
    : null
}
const ceilUsd = (value: Prisma.Decimal) => value.toDecimalPlaces(8, Prisma.Decimal.ROUND_CEIL)
export function maximumSupportCost(pricing: SupportPricing): Prisma.Decimal {
  // Cache writes and long-context rates can exceed uncached-input pricing.
  const inputRate = Prisma.Decimal.max(pricing.inputUsd, pricing.cachedUsd, pricing.write30mUsd, pricing.write12hUsd)
  const long = pricing.maxInputTokens > pricing.longContextAfter
  return ceilUsd(
    inputRate
      .mul(pricing.maxInputTokens)
      .mul(long ? '2' : '1')
      .plus(new Prisma.Decimal(pricing.outputUsd).mul(pricing.maxOutputTokens).mul(long ? '1.5' : '1'))
      .div('1000000'),
  )
}
export function parseSupportUsage(usage: unknown, pricing: SupportPricing) {
  const tokens = z.number().int().nonnegative()
  const parsed = z
    .object({
      input_tokens: tokens.max(pricing.maxInputTokens),
      output_tokens: tokens.max(pricing.maxOutputTokens),
      input_tokens_details: z.object({
        cached_tokens: tokens,
        cache_write_tokens: tokens,
        cache_write_tokens_details: z.object({ ttl_30m_tokens: tokens, ttl_12h_tokens: tokens }).nullish(),
      }),
    })
    .safeParse(usage)
  if (!parsed.success) return null
  const { input_tokens: input, input_tokens_details: details } = parsed.data
  const cached = details.cached_tokens,
    writes = details.cache_write_tokens
  const split = details.cache_write_tokens_details
  if (cached + writes > input || (split && split.ttl_30m_tokens + split.ttl_12h_tokens !== writes)) return null
  return parsed.data
}
export function observedSupportCost(usage: unknown, pricing: SupportPricing): Prisma.Decimal | null {
  const parsed = parseSupportUsage(usage, pricing)
  if (!parsed) return null
  const { input_tokens: input, output_tokens: output, input_tokens_details: details } = parsed
  const cached = details.cached_tokens,
    writes = details.cache_write_tokens,
    split = details.cache_write_tokens_details,
    // Without the 30m/12h split (the Responses API omits it on long prompts) every write is charged at the dearest rate.
    shortWrites = split ? split.ttl_30m_tokens : 0,
    longWrites = split ? split.ttl_12h_tokens : writes
  const long = input > pricing.longContextAfter
  const inputCost = new Prisma.Decimal(pricing.inputUsd)
    .mul(input - cached - writes)
    .plus(new Prisma.Decimal(pricing.cachedUsd).mul(cached))
    .plus(new Prisma.Decimal(pricing.write30mUsd).mul(shortWrites))
    .plus(new Prisma.Decimal(pricing.write12hUsd).mul(longWrites))
    .mul(long ? '2' : '1')
  return ceilUsd(inputCost.plus(new Prisma.Decimal(pricing.outputUsd).mul(output).mul(long ? '1.5' : '1')).div('1000000'))
}
