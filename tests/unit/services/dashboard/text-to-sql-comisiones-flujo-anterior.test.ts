/**
 * I2, hermanos en el camino de SQL libre y en la ayuda del asistente (revisión final, fase 3 «Pago al personal»).
 *
 * Desde octubre de 2026 las comisiones se pagan en el recibo de Pago al personal. El SQL libre del asistente no ve esos
 * recibos, pero sí veía `CommissionPayout` y `CommissionSummary.status`: a «¿cuánto pagué de comisiones?» podía contestar
 * con el flujo viejo ($0, «pendiente», «aprobado»). Ahora esas columnas de pago no se pueden consultar (el validador rechaza
 * la consulta y el esquema que ve el modelo ya no las anuncia), y la ayuda manda a «Pago al personal», no a «payouts».
 * Lo calculado (`CommissionCalculation`) se sigue consultando, y las dos herramientas deterministas siguen permitidas.
 */
process.env.OPENAI_API_KEY = 'test-api-key-for-unit-tests'

import textToSqlService from '@/services/dashboard/text-to-sql-assistant.service'
import { SqlAstParserService } from '@/services/dashboard/sql-ast-parser.service'
import { TableAccessControlService, UserRole } from '@/services/dashboard/table-access-control.service'

const venueId = 'venue-comisiones-1'
const parser = new SqlAstParserService()
const valida = (sql: string, userRole = UserRole.ADMIN) => parser.validateQuery(sql, { requiredVenueId: venueId, userRole })

describe('SQL libre: el estado de pago del flujo anterior ya no es una verdad consultable', () => {
  it.each([
    [
      'lo pagado en pagos viejos',
      `SELECT SUM("amount") FROM "CommissionPayout" WHERE "venueId" = '${venueId}' AND "status" = 'PAID'`,
      'amount',
    ],
    ['cuándo se pagó', `SELECT "paidAt" FROM "CommissionPayout" WHERE "venueId" = '${venueId}'`, 'paidAt'],
    ['todo el pago viejo', `SELECT cp.* FROM "CommissionPayout" cp WHERE cp."venueId" = '${venueId}'`, 'status'],
    ['resúmenes «pagados»', `SELECT "netAmount" FROM "CommissionSummary" WHERE "venueId" = '${venueId}' AND "status" = 'PAID'`, 'status'],
    ['quién aprobó', `SELECT "approvedAt" FROM "CommissionSummary" WHERE "venueId" = '${venueId}'`, 'approvedAt'],
  ])('rechaza %s', (_caso, sql, columna) => {
    const r = valida(sql)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ').toLowerCase()).toContain(columna.toLowerCase())
  })

  it('también para SUPERADMIN: es una frontera de significado, no de rol', () => {
    expect(valida(`SELECT "status" FROM "CommissionPayout" WHERE "venueId" = '${venueId}'`, UserRole.SUPERADMIN).valid).toBe(false)
  })

  it('lo CALCULADO se sigue consultando (regresión)', () => {
    expect(valida(`SELECT SUM("netCommission") FROM "CommissionCalculation" WHERE "venueId" = '${venueId}'`).valid).toBe(true)
  })

  it('las herramientas deterministas de comisiones siguen permitidas para ADMIN (regresión)', () => {
    expect(TableAccessControlService.validateAccess(['CommissionPayout', 'CommissionSummary', 'Staff'], UserRole.ADMIN).allowed).toBe(true)
  })

  it('el esquema que ve el modelo ya no anuncia esas columnas', () => {
    const contexto: string = (textToSqlService as any).schemaContext
    const seccion = (tabla: string) => contexto.split(`### ${tabla}`)[1]?.split('### ')[0] ?? ''
    expect(seccion('CommissionPayout')).not.toMatch(/\bamount \(|\bpaidAt\b|\bprocessedAt\b|- status:/)
    expect(seccion('CommissionSummary')).not.toMatch(/- status:|\bapprovedAt\b|\bapprovedById\b/)
    expect(seccion('CommissionCalculation')).toMatch(/netCommission/)
  })
})

describe('Ayuda del asistente: los pagos de comisiones se registran en «Pago al personal»', () => {
  const ayuda = (q: string) => (textToSqlService as any).getOperationalHelpResponse(q)

  it.each(['¿cómo configuro las comisiones?', '¿Dónde veo los pagos de comisiones?'])('«%s» manda a Pago al personal, no a payouts', q => {
    const r = ayuda(q)
    expect(r?.topic).toBe('commissions')
    expect(r?.response).toContain('`Pago al personal`')
    expect(JSON.stringify(r)).not.toMatch(/payout/i)
  })

  it('«¿Dónde veo mis pagos?» sigue yendo a Pagos (regresión)', () => {
    expect(ayuda('¿Dónde veo mis pagos?')?.topic).toBe('payments')
  })
})
