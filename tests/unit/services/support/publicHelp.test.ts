import { Prisma } from '@prisma/client'
import { LUNA_SUPPORT_PRICING as pricing } from '@/config/supportWhatsapp'
import { mexicoDay, publicCallHold, publicDayKey, publicDaySpent, publicPhoneCaps } from '@/services/support/publicHelp.service'

const row = (spent: string, held = '0') => ({ spentUsd: new Prisma.Decimal(spent), heldUsd: new Prisma.Decimal(held) })
afterEach(() => {
  delete process.env.SUPPORT_PUBLIC_HELP_DAILY_USD
})

it('each public call holds the dearest cost of a request of up to 272,000 tokens: US$0.0685, never the long-context price', () => {
  expect(publicCallHold(pricing).toString()).toBe('0.0685')
})
it('the day is spent when what is settled, what is held and one more hold do not fit in US$1', () => {
  expect(publicDaySpent(null, pricing)).toBe(false)
  expect(publicDaySpent(row('0.9315'), pricing)).toBe(false)
  expect(publicDaySpent(row('0.9'), pricing)).toBe(false)
  expect(publicDaySpent(row('0.9', '0.0316'), pricing)).toBe(true)
  expect(publicDaySpent(row('0.9316'), pricing)).toBe(true)
  process.env.SUPPORT_PUBLIC_HELP_DAILY_USD = '0'
  expect(publicDaySpent(null, pricing)).toBe(true)
})
it('the day of public help is the day of Mexico City (its notice says «mañana»), and the hour window is the UTC hour', () => {
  expect(mexicoDay(new Date('2026-11-22T05:59:00Z')).toISOString()).toBe('2026-11-21T06:00:00.000Z')
  expect(mexicoDay(new Date('2026-11-22T06:00:00Z')).toISOString()).toBe('2026-11-22T06:00:00.000Z')
  expect(publicDayKey(new Date('2026-11-22T23:30:00Z'))).toBe('AI:PUBLIC_DAY:2026-11-22T06:00:00.000Z')
  const caps = publicPhoneCaps('rx', '+525500000000', new Date('2026-11-22T23:30:00Z'))
  expect(caps.map(c => [c.window, c.maximum, c.start.toISOString()])).toEqual([
    ['DAY', 20, '2026-11-22T06:00:00.000Z'],
    ['HOUR', 10, '2026-11-22T23:00:00.000Z'],
  ])
  // Per receiver and phone, never the phone itself.
  for (const cap of caps) expect(cap.key).toMatch(/^CONTROL:rx:[a-f0-9]{64}:PUBLIC_(DAY|HOUR):/)
})
