import prisma from '@/utils/prismaClient'

export { prisma }

/** Wrap any data in the MCP text-content shape every tool returns. */
export function text(data: unknown): { content: { type: 'text'; text: string }[] } {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text: body }] }
}

/** Format a Decimal/number as MXN money for human-readable output. */
export function formatMoney(amount: number | { toString(): string }): string {
  const n = Number(amount)
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n)
}

/** Human label for which DB this process is pointed at (logged on startup, stderr). */
export function describeDbTarget(): string {
  const url = process.env.DATABASE_URL ?? ''
  if (/localhost|127\.0\.0\.1/.test(url)) return 'LOCAL'
  if (/staging|stg/.test(url)) return 'STAGING'
  if (url) return 'REMOTE/PROD (⚠️ live data)'
  return 'UNKNOWN (DATABASE_URL not set)'
}
