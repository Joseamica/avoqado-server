import { amountInWordsEs, formatDateTime, formatMoney } from '@/services/shared/receiptLayout/format'

describe('formatMoney — $1,234.50, sin aritmética', () => {
  it('formatea centavos enteros', () => {
    expect(formatMoney(123450)).toBe('$1,234.50')
    expect(formatMoney(5)).toBe('$0.05')
    expect(formatMoney(0)).toBe('$0.00')
    expect(formatMoney(100000000)).toBe('$1,000,000.00')
  })
  it('un negativo lleva el signo delante del $', () => {
    expect(formatMoney(-500)).toBe('-$5.00')
  })
})

describe('formatDateTime — dd/MM/yyyy HH:mm en la zona del venue', () => {
  it('el mismo instante sale distinto en CDMX y en Tijuana', () => {
    expect(formatDateTime('2026-09-02T18:05:00.000Z', 'America/Mexico_City')).toBe('02/09/2026 12:05')
    expect(formatDateTime('2026-09-02T18:05:00.000Z', 'America/Tijuana')).toBe('02/09/2026 11:05')
  })
})

describe('amountInWordsEs — formato de voucher mexicano', () => {
  it.each([
    [123450, 'MIL DOSCIENTOS TREINTA Y CUATRO PESOS 50/100 M.N.'],
    [100, 'UN PESO 00/100 M.N.'],
    [0, 'CERO PESOS 00/100 M.N.'],
    [10000, 'CIEN PESOS 00/100 M.N.'],
    [10100, 'CIENTO UN PESOS 00/100 M.N.'],
    [2100000, 'VEINTIÚN MIL PESOS 00/100 M.N.'],
    [100000000, 'UN MILLÓN DE PESOS 00/100 M.N.'],
    [250075, 'DOS MIL QUINIENTOS PESOS 75/100 M.N.'],
  ])('%i → %s', (cents, words) => {
    expect(amountInWordsEs(cents)).toBe(words)
  })
})
