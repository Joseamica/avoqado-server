// src/services/customer-display/canonicalHash.ts
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'

/**
 * La serialización estable y la huella corta de TODA la pantalla del cliente: la ficha (F0-A) y las tres huellas del
 * poll (F0-B). Una sola, para que una huella nunca dependa de qué módulo la calculó.
 *
 * 🔴 Las fechas, los decimales y los bigint se serializan por su VALOR. Un `Date` es un objeto sin llaves propias:
 * recorrido como objeto sale `{}`, y dos `updatedAt` distintos darían la MISMA huella — la tablet nunca se enteraría.
 */
export function canonicalJson(valor: unknown): string {
  if (valor instanceof Date) return JSON.stringify(Number.isNaN(valor.getTime()) ? null : valor.toISOString())
  if (Prisma.Decimal.isDecimal(valor)) return JSON.stringify((valor as Prisma.Decimal).toString())
  if (typeof valor === 'bigint') return JSON.stringify(valor.toString())
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor) ?? 'null'
  if (Array.isArray(valor)) return `[${valor.map(canonicalJson).join(',')}]`
  const entradas = Object.entries(valor as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** 32 hex del sha256 de la serialización canónica. El largo es el que F0-A ya entrega: no se cambia. */
export function fingerprintOf(valor: unknown): string {
  return createHash('sha256').update(canonicalJson(valor)).digest('hex').slice(0, 32)
}
