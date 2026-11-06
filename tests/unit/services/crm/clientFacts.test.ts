/**
 * The shape of the SQL of «Clientes»' facts (plan C1, task 2). What only Postgres answers lives in
 * `tests/integration/crm/clientes-legible.integration.test.ts`; these pin two traps a green integration run would not
 * catch on another day: an enum value bound as text (`"OrderSource" = text` fails in Postgres) and a fact read from a
 * column that does not prove a device (`Order.terminalId`, `lastHeartbeat`).
 */
import { altaPendienteSql, clientFactsLateral, concesionComercialSql, ventanaDeAccesoSql } from '@/services/crm/clientFacts'

const NOW = new Date('2026-11-06T18:00:00.000Z')
const ENUM_VALUES = [
  // Order.source
  'TPV',
  'AVOQADO_ANDROID',
  'AVOQADO_IOS',
  // Order.paymentStatus
  'PAID',
  'PARTIAL',
  // Terminal.type
  'TPV_ANDROID',
  'TPV_IOS',
  // Payment.status and Payment.source
  'COMPLETED',
  'APP',
  // plan codes and tiers
  'PLAN_PRO',
  'PLAN_PREMIUM',
  'PRO',
  'PREMIUM',
]

describe('clientFacts SQL', () => {
  const all = [clientFactsLateral(NOW), altaPendienteSql(), ventanaDeAccesoSql('vf', NOW), concesionComercialSql('v', NOW, 'PRO')]

  it('los valores de enum van como literales SQL, nunca como bind de texto (igual que REAL_VENUE_SQL)', () => {
    for (const sql of all) {
      for (const value of sql.values) expect(ENUM_VALUES).not.toContain(value)
    }
    const lateral = clientFactsLateral(NOW).sql
    expect(lateral).toContain(`o2."source" IN ('AVOQADO_ANDROID', 'AVOQADO_IOS')`)
    expect(lateral).toContain(`t."type" IN ('TPV_ANDROID', 'TPV_IOS')`)
    expect(lateral).toContain(`o2."paymentStatus" IN ('PAID', 'PARTIAL')`)
  })

  it('las fechas viajan con utcTs, nunca como Date pelona', () => {
    for (const sql of all) {
      const dateBinds = sql.values.filter(value => value instanceof Date).length
      expect(sql.sql.match(/\? AT TIME ZONE 'UTC'\)/g) ?? []).toHaveLength(dateBinds)
    }
  })

  it('altaPendienteSql y clientFactsLateral no tocan "Order"."terminalId" ni "lastHeartbeat"', () => {
    for (const sql of [clientFactsLateral(NOW).sql, altaPendienteSql().sql]) {
      expect(sql).not.toContain('lastHeartbeat')
      // The only terminal column read is the one of the PAYMENT (alias `p`), which says where the card was processed.
      for (const use of sql.match(/\w+\."terminalId"/g) ?? []) expect(use).toBe('p."terminalId"')
    }
  })

  it('un alias que no es un identificador no entra al texto', () => {
    expect(() => ventanaDeAccesoSql('vf; DROP TABLE x', NOW)).toThrow()
    expect(() => concesionComercialSql('v"', NOW, 'PREMIUM')).toThrow()
  })
})
