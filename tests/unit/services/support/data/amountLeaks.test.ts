import { Prisma } from '@prisma/client'
import { amountLeaks } from '@tests/__helpers__/supportData'

// The log sweep has teeth (Codex plan r1 #2): a log with { netSales: 12345.6 } does not contain «$12,345.60», so it looks for
// the ORIGINAL amounts and not for the printed strings.
it.each([
  [{ netSales: 12345.6 }],
  [{ nested: [{ total: new Prisma.Decimal('12345.60') }] }],
  ['net 12345.60'],
  ['12345.6'],
  ['$12,345.60'],
  [[12345.6]],
])('detects %j', logged => expect(amountLeaks([logged], [12345.6])).toEqual(['12345.6']))
it.each([
  [{ transactionCount: 58, venueId: 'cmvenue0000000000000000001' }],
  ['capability sales_today, ANSWERED, 412 ms'],
  [{ count: 12345 }],
  [{ total: 12345.61 }],
])('lets %j through', logged => expect(amountLeaks([logged], [12345.6])).toEqual([]))

it('a negative amount leaks as its number and as its digits; an Error message is read too; cycles do not hang', () => {
  const cyclic: Record<string, unknown> = { a: 1 }
  cyclic.self = cyclic
  expect(amountLeaks([{ total: -150 }], [-150])).toEqual(['-150'])
  expect(amountLeaks(['refund 150.00'], [-150])).toEqual(['-150'])
  expect(amountLeaks([new Error('total 12,345.60 did not match')], [12345.6])).toEqual(['12345.6'])
  expect(amountLeaks([cyclic], [12345.6])).toEqual([])
})
