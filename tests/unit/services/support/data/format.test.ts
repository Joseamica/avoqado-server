import { Prisma } from '@prisma/client'
import { template } from '@/services/support/data/check'

// format.test.ts
const t = template('America/Mexico_City'),
  at = new Date('2026-11-12T20:32:00Z')
it('pesos, never cents', () => {
  expect([t.money(850), t.money('1250'), t.money(new Prisma.Decimal('12345.6')), t.money(0)]).toEqual([
    '$850.00',
    '$1,250.00',
    '$12,345.60',
    '$0.00',
  ])
  expect([t.money(-150), t.money('-110.02'), t.money(new Prisma.Decimal('-0.004')), t.money(-0)]).toEqual([
    '−$150.00',
    '−$110.02',
    '$0.00',
    '$0.00',
  ]) // el panel sí enseña netos negativos
  expect(() => t.money('abc')).toThrow()
})
it('hour and dates of the venue', () => {
  expect([t.time(at), t.shortDay(at), t.date('2026-12-03T06:00:00Z')]).toEqual(['14:32', 'jue 12-nov', '3-dic-2026'])
  expect(template('America/Cancun').time(at)).toBe('15:32')
})
// lo que el encargo deja a criterio: conteo, terminación de tarjeta, medianoche y un día sin hora
it('counts, card endings, midnight and a bare day of the venue', () => {
  const t2 = template('America/Mexico_City')
  expect([t2.count(0), t2.count(58), t2.count(1234567)]).toEqual(['0', '58', '1,234,567'])
  expect(() => t2.count(-1)).toThrow()
  expect(() => t2.count(2.5)).toThrow()
  expect([t2.last4('4242'), t2.last4('411111******1111')]).toEqual(['4242', '1111'])
  expect(() => t2.last4('42')).toThrow()
  expect(t2.time(new Date('2026-11-13T06:05:00Z'))).toBe('00:05')
  expect([t2.shortDay(new Date('2026-11-15T18:00:00Z')), t2.date('2026-11-16')]).toEqual(['dom 15-nov', '16-nov-2026'])
  expect(() => t2.date('2026-02-30')).toThrow()
  expect(() => t2.date('2026-12-03T06:00:00')).toThrow() // sin zona, la hora la pondría el servidor
  expect(() => t2.time(new Date('nope'))).toThrow()
})
// Ronda de arreglos 1 · m7: una zona que cambia de horario (Tijuana regresa a la hora de invierno el 1-nov-2026)
it('the two 01:30 of the fall-back day in Tijuana', () => {
  const tj = template('America/Tijuana')
  const first = new Date('2026-11-01T08:30:00Z') // 01:30 PDT (UTC−7)
  const second = new Date('2026-11-01T09:30:00Z') // 01:30 PST (UTC−8), una hora después
  expect([tj.time(first), tj.time(second)]).toEqual(['01:30', '01:30'])
  expect([tj.shortDay(first), tj.shortDay(second), tj.date(second)]).toEqual(['dom 1-nov', 'dom 1-nov', '1-nov-2026'])
  expect(tj.time(new Date('2026-11-01T10:30:00Z'))).toBe('02:30')
})
