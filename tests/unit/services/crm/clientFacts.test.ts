/**
 * The shape of the SQL of «Clientes»' facts (plan C1, task 2). What only Postgres answers lives in
 * `tests/integration/crm/clientes-legible.integration.test.ts`; these pin two traps a green integration run would not
 * catch on another day: an enum value bound as text (`"OrderSource" = text` fails in Postgres) and a fact read from a
 * column that does not prove a device (`Order.terminalId`, `lastHeartbeat`).
 */
import {
  altaPendienteSql,
  clientFactsLateral,
  concesionComercialSql,
  pagoPorAvoqadoSql,
  ventanaDeAccesoSql,
} from '@/services/crm/clientFacts'

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
  // C1b: Payment.method, Payment.source, Payment.fundsFlow and the codes of «Ingreso»
  'CREDIT_CARD',
  'DEBIT_CARD',
  'DIGITAL_WALLET',
  'CASH',
  'DASHBOARD_TEST',
  'DELIVERY_PLATFORM',
  'AVOQADO_PROCESSED',
  'CASH_DRAWER',
  'MENSUALIDAD',
  'TRANSACCIONES',
  'AMBOS',
  'NINGUNO',
  'TARJETA_OTRA_TERMINAL',
  'SOLO_EFECTIVO',
]

describe('clientFacts SQL', () => {
  const all = [
    clientFactsLateral(NOW),
    altaPendienteSql(),
    ventanaDeAccesoSql('vf', NOW),
    concesionComercialSql('v', NOW, 'PRO'),
    pagoPorAvoqadoSql('p'),
  ]

  it('los valores de enum van como literales SQL, nunca como bind de texto (igual que REAL_VENUE_SQL)', () => {
    for (const sql of all) {
      for (const value of sql.values) expect(ENUM_VALUES).not.toContain(value)
    }
    const lateral = clientFactsLateral(NOW).sql
    expect(lateral).toContain(`o2."source" IN ('AVOQADO_ANDROID', 'AVOQADO_IOS')`)
    expect(lateral).toContain(`t."type" IN ('TPV_ANDROID', 'TPV_IOS')`)
    expect(lateral).toContain(`o2."paymentStatus" IN ('PAID', 'PARTIAL')`)
    // C1b: the card of the terminal and the online charge processed by Avoqado.
    const avoqado = pagoPorAvoqadoSql('p').sql
    expect(avoqado).toContain(`p."method" IN ('CREDIT_CARD', 'DEBIT_CARD', 'DIGITAL_WALLET')`)
    expect(avoqado).toContain(`p."fundsFlow" IS NOT DISTINCT FROM 'AVOQADO_PROCESSED'`)
    expect(avoqado).toContain(`p."source" <> 'DASHBOARD_TEST'`)
    expect(lateral).toContain(`p."source" NOT IN ('DELIVERY_PLATFORM', 'DASHBOARD_TEST')`)
  })

  it('C1b: «tarjeta por Avoqado» nunca se decide por processor (la TPV escribe «TBD») ni por el terminalId del cobro', () => {
    const avoqado = pagoPorAvoqadoSql('p').sql
    expect(avoqado).not.toContain('processor')
    expect(avoqado).not.toContain('terminalId')
    // Null-safe: NOT (…) of a payment without fundsFlow must be true or false, never NULL (that would drop the row).
    expect(avoqado).not.toMatch(/"fundsFlow" = 'AVOQADO_PROCESSED'/)
    expect(() => pagoPorAvoqadoSql('p; DROP')).toThrow()
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
      // Any spelling: quoted or not, with or without a table or alias in front (`"Order"."terminalId"`, `o2.terminalId`…).
      for (const use of sql.match(/(?:"?\w+"?\.)?"?terminalId\b"?/gi) ?? []) expect(use).toBe('p."terminalId"')
    }
    // The regex does find the one legitimate read (it is not vacuous).
    expect(clientFactsLateral(NOW).sql.match(/(?:"?\w+"?\.)?"?terminalId\b"?/gi)).toEqual(['p."terminalId"'])
  })

  it('un alias que no es un identificador no entra al texto', () => {
    expect(() => ventanaDeAccesoSql('vf; DROP TABLE x', NOW)).toThrow()
    expect(() => concesionComercialSql('v"', NOW, 'PREMIUM')).toThrow()
  })
})
