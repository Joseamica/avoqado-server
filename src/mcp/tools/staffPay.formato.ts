// src/mcp/tools/staffPay.formato.ts — el ÚNICO formato de las herramientas de pago al personal (fase 3, B13 ronda 1, R3): pesos,
// listas, montos con signo y fechas civiles. Sólo para MOSTRAR: las sumas van con `Prisma.Decimal`, nunca con estos textos.

/** «1,500.00» (pesos 1:1, dos decimales). */
export const pesos = (s: string | number) => Number(s).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** Un total que puede ser negativo: «−$40.00» (con el signo de menos) o «$40.00»; nunca «$-40.00». */
export const conSigno = (s: string) => `${Number(s) < 0 ? '−' : ''}$${pesos(Math.abs(Number(s)))}`
/** Una diferencia por liquidar, siempre con su signo y su moneda: «+$40.00 MXN» o «-$40.00 MXN». */
export const diferencia = (s: string, moneda: string) => `${Number(s) < 0 ? '-' : '+'}$${pesos(Math.abs(Number(s)))} ${moneda}`
/** «a, b y c». */
export const lista = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`)

/** `YYYY-MM-DD` (fecha local) como fecha UTC: sólo para darle formato, nunca como instante. */
const diaUTC = (f: string) => {
  const [y, m, d] = f.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
/** «20 oct 2026». */
export const diaLegible = (f: string) =>
  diaUTC(f).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
/** «de septiembre de 2026» si es el mes completo; si no, «del 1 sep 2026 al 15 sep 2026». */
export const periodoLegible = (p: { start: string; end: string }) =>
  p.start.endsWith('-01') &&
  p.start.slice(0, 7) === p.end.slice(0, 7) &&
  diaUTC(p.end).getUTCMonth() !== new Date(diaUTC(p.end).getTime() + 86_400_000).getUTCMonth()
    ? `de ${diaUTC(p.start).toLocaleDateString('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`
    : `del ${diaLegible(p.start)} al ${diaLegible(p.end)}`
