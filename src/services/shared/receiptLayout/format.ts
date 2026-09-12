import { formatInTimeZone } from 'date-fns-tz'

/** `$1,234.50` — miles con coma, dos decimales, signo delante. Sólo formatea: nunca redondea ni divide dinero. */
export function formatMoney(cents: number): string {
  const abs = Math.abs(Math.trunc(cents))
  const entero = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const decimales = String(abs % 100).padStart(2, '0')
  return `${cents < 0 ? '-' : ''}$${entero}.${decimales}`
}

/** El instante de la VENTA en la zona del venue (nunca la hora de impresión ni la del aparato). */
export function formatDateTime(iso: string, timezone: string): string {
  return formatInTimeZone(new Date(iso), timezone, 'dd/MM/yyyy HH:mm')
}

const UNIDADES = [
  '',
  'UN',
  'DOS',
  'TRES',
  'CUATRO',
  'CINCO',
  'SEIS',
  'SIETE',
  'OCHO',
  'NUEVE',
  'DIEZ',
  'ONCE',
  'DOCE',
  'TRECE',
  'CATORCE',
  'QUINCE',
  'DIECISÉIS',
  'DIECISIETE',
  'DIECIOCHO',
  'DIECINUEVE',
  'VEINTE',
  'VEINTIÚN',
  'VEINTIDÓS',
  'VEINTITRÉS',
  'VEINTICUATRO',
  'VEINTICINCO',
  'VEINTISÉIS',
  'VEINTISIETE',
  'VEINTIOCHO',
  'VEINTINUEVE',
]
const DECENAS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA']
const CENTENAS = [
  '',
  'CIENTO',
  'DOSCIENTOS',
  'TRESCIENTOS',
  'CUATROCIENTOS',
  'QUINIENTOS',
  'SEISCIENTOS',
  'SETECIENTOS',
  'OCHOCIENTOS',
  'NOVECIENTOS',
]

function menorQueMil(n: number): string {
  if (n === 0) return ''
  if (n === 100) return 'CIEN'
  const c = Math.floor(n / 100)
  const r = n % 100
  const partes: string[] = []
  if (c) partes.push(CENTENAS[c])
  if (r > 0 && r < 30) partes.push(UNIDADES[r])
  else if (r >= 30) {
    const d = Math.floor(r / 10)
    const u = r % 10
    partes.push(u ? `${DECENAS[d]} Y ${UNIDADES[u]}` : DECENAS[d])
  }
  return partes.join(' ')
}

/** «MIL DOSCIENTOS TREINTA Y CUATRO PESOS 50/100 M.N.» — lo que hoy imprime la PAX (`amountToWordsEs`). */
export function amountInWordsEs(cents: number): string {
  const abs = Math.abs(Math.trunc(cents))
  const pesos = Math.floor(abs / 100)
  const centavos = abs % 100
  let palabras: string
  let deMillones = false
  if (pesos === 0) palabras = 'CERO'
  else {
    const millones = Math.floor(pesos / 1_000_000)
    const miles = Math.floor((pesos % 1_000_000) / 1000)
    const resto = pesos % 1000
    const p: string[] = []
    if (millones === 1) p.push('UN MILLÓN')
    else if (millones > 1) p.push(`${menorQueMil(millones)} MILLONES`)
    if (miles === 1) p.push('MIL')
    else if (miles > 1) p.push(`${menorQueMil(miles)} MIL`)
    if (resto) p.push(menorQueMil(resto))
    palabras = p.join(' ')
    deMillones = millones > 0 && miles === 0 && resto === 0
  }
  const moneda = pesos === 1 ? 'PESO' : deMillones ? 'DE PESOS' : 'PESOS'
  return `${palabras} ${moneda} ${String(centavos).padStart(2, '0')}/100 M.N.`
}
