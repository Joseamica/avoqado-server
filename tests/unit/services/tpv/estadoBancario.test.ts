/**
 * Codex R13-4: la clasificación EXPLÍCITA del estado bancario de un evento de AngelPay — aprobado legible, rechazo legible,
 * ausente (legacy) e inválido (presente pero ilegible) — en un solo sitio para el receptor y el backfill.
 */
import { clasificarEstadoBancario, eventoAprobadoSql, MOTIVO_ESTADO_INVALIDO } from '@/services/tpv/estadoBancario'

describe('clasificarEstadoBancario (Codex R13-4)', () => {
  it.each([['approved'], ['APPROVED'], ['  Approved  ']])('«%s» es APROBADO (legible, tolerante a mayúsculas y espacios)', s => {
    expect(clasificarEstadoBancario(s)).toBe('APROBADO')
  })
  it.each([['declined'], ['DECLINED'], ['error'], ['approvedx'], [' rejected ']])(
    '«%s» es RECHAZADO (legible, distinto de approved)',
    s => {
      expect(clasificarEstadoBancario(s)).toBe('RECHAZADO')
    },
  )
  it('undefined (el campo NO viene) es AUSENTE: la única compatibilidad legacy', () => {
    expect(clasificarEstadoBancario(undefined)).toBe('AUSENTE')
  })
  // Codex R14-3: `{"status": null}` CONTIENE el campo y no demuestra aprobación — es INVALIDO, no la excepción de ausencia.
  it.each([[null], [123], [0], [true], [{}], [[]], [['approved']], [''], ['   '], ['\n\t']])(
    '%p es INVALIDO (presente pero ilegible: nunca aprobación demostrada)',
    s => {
      expect(clasificarEstadoBancario(s)).toBe('INVALIDO')
    },
  )
  // Codex R14-3: la normalización es la de `String.prototype.trim` (tabulador, NBSP, BOM…), la MISMA que expresa el SQL.
  it.each([['\tapproved\u00a0'], ['\ufeffAPPROVED\n'], ['\u2003approved\u3000']])('%p es APROBADO (espacios Unicode como trim())', s => {
    expect(clasificarEstadoBancario(s)).toBe('APROBADO')
  })
  it.each([
    ['NBSP', '\u00a0'],
    ['tabulador + BOM', '\t\ufeff'],
  ])('sólo %s (espacios Unicode) es INVALIDO', (_nombre, s) => {
    expect(clasificarEstadoBancario(s)).toBe('INVALIDO')
  })
  it('el motivo del estado inválido es INVALID_STATUS', () => {
    expect(MOTIVO_ESTADO_INVALIDO).toBe('INVALID_STATUS')
  })
})

// Fase 1 del SDK propio (Tarea 4): el alias del evento va CRUDO en el SQL; sólo se acepta un identificador simple.
describe('eventoAprobadoSql', () => {
  it('eventoAprobadoSql rechaza un alias con comillas', () => expect(() => eventoAprobadoSql('e"; --')).toThrow())
  it.each([['E'], ['1e'], [''], ['e.x']])('rechaza el alias %p', alias => expect(() => eventoAprobadoSql(alias)).toThrow())
  it('con un alias válido nombra sus columnas y las dos ramas (AngelPay y la VENTA de Blumon)', () => {
    const { sql } = eventoAprobadoSql('i')
    expect(sql).toContain(`i."type" = 'send_transaction'`)
    expect(sql).toContain(`i."type" = 'VENTA' AND i."eventId" LIKE 'blumon-tpv-%' AND i."payload"->>'codeResponse' = '00'`)
  })
})
