/**
 * D30, auditoría de apps viejas (18-nov-2026): con el folio `ORD-0` + 12 cifras, buscar dígitos «en cualquier parte» traía la venta
 * …0120 y la …1200 al teclear «000012». El folio corto que se imprime son las ÚLTIMAS cifras: con sólo dígitos se busca por cómo
 * termina.
 */
import fs from 'fs'
import path from 'path'
import { filtroPorFolio } from '@/services/shared/filtroPorFolio'

/** Aplica el filtro a un folio, como lo haría Postgres (sin distinguir mayúsculas donde el filtro lo pide). */
function coincide(filtro: any, folio: string): boolean {
  if (filtro.OR) return filtro.OR.some((f: any) => coincide(f, folio))
  const c = filtro.orderNumber
  const [a, b] = c.mode === 'insensitive' ? [folio.toLowerCase(), String(c.contains ?? c.endsWith).toLowerCase()] : [folio, String(c.contains ?? c.endsWith)]
  return c.endsWith !== undefined ? a.endsWith(b) : a.includes(b)
}

describe('filtroPorFolio', () => {
  it('«000012» encuentra la orden 12 y NO la 120 ni la 1200 (el caso de la auditoría)', () => {
    const f = filtroPorFolio('000012')
    expect(coincide(f, 'ORD-0000000000012')).toBe(true)
    expect(coincide(f, 'ORD-0000000000120')).toBe(false)
    expect(coincide(f, 'ORD-0000000001200')).toBe(false)
    expect(coincide(f, 'ORD-0000001200000')).toBe(false)
  })

  it('el folio completo en dígitos y el de reloj de antes siguen saliendo por sus últimas cifras', () => {
    expect(coincide(filtroPorFolio('0000000000012'), 'ORD-0000000000012')).toBe(true)
    expect(coincide(filtroPorFolio('374538'), 'ORD-1794963374538')).toBe(true)
  })

  it('un folio viejo con sufijo (`-S2`, `-41-S2`) sale por las últimas cifras de su tronco', () => {
    expect(coincide(filtroPorFolio('374538'), 'ORD-1794963374538-S2')).toBe(true)
    expect(coincide(filtroPorFolio('374538'), 'ORD-1794963374538-41-S2')).toBe(true)
    expect(coincide(filtroPorFolio('000001'), 'ORD-0000000000001-S2')).toBe(true)
  })

  it('con letras se busca en cualquier parte, como siempre (folios de integraciones, «ORD-…»)', () => {
    expect(coincide(filtroPorFolio('rappi-77'), 'RAPPI-7781')).toBe(true)
    expect(coincide(filtroPorFolio('ORD-0000000000012'), 'ORD-0000000000012')).toBe(true)
    expect(coincide(filtroPorFolio(' WABCD '), 'WABCD')).toBe(true)
  })

  it.each(['services/mobile/transaction.mobile.service.ts', 'services/mobile/order.mobile.service.ts'])(
    '%s busca el folio con filtroPorFolio, no con `contains` a pelo',
    rel => {
      const fuente = fs.readFileSync(path.join(__dirname, '../../../../src', rel), 'utf-8')
      expect(fuente).toMatch(/filtroPorFolio\(/)
      expect(fuente).not.toMatch(/orderNumber:\s*\{\s*contains:\s*(searchTerm|input\.search)/)
    },
  )
})
