/**
 * D4 + D6 (5-nov-2026): UNA sola regla de «¿esta fila da acceso?» para todos los lectores.
 *
 * Antes la gracia de cobranza no contaba: una prueba vencida con el primer cobro fallido negaba el plan desde el día 0
 * aunque el servidor hubiera concedido días de gracia (D6), y una gracia vencida sobre un plan pagado seguía dando acceso
 * hasta que llegara el 4.º intento de Stripe.
 */
import { daAcceso, ventanaDeAccesoWhere } from '@/services/access/ventanaDeAcceso'

const AHORA = new Date('2026-11-20T12:00:00Z')
const antes = new Date('2026-11-19T12:00:00Z')
const despues = new Date('2026-11-21T12:00:00Z')

type Fila = { active: boolean; suspendedAt: Date | null; endDate: Date | null; gracePeriodEndsAt: Date | null }
const fila = (f: Partial<Fila> = {}): Fila => ({ active: true, suspendedAt: null, endDate: null, gracePeriodEndsAt: null, ...f })

describe('daAcceso — la tabla completa', () => {
  it.each<[string, Partial<Fila>, boolean]>([
    ['pagada, sin vencimiento ni gracia', {}, true],
    ['apagada', { active: false }, false],
    ['suspendida (aunque tenga gracia vigente)', { suspendedAt: antes, gracePeriodEndsAt: despues }, false],
    ['prueba o cortesía vigente', { endDate: despues }, true],
    ['prueba o cortesía vencida, sin gracia', { endDate: antes }, false],
    ['🔴 D6: prueba vencida + gracia vigente → SÍ (era el defecto)', { endDate: antes, gracePeriodEndsAt: despues }, true],
    ['prueba vencida + gracia vencida', { endDate: antes, gracePeriodEndsAt: antes }, false],
    [
      '🔴 v4: pagada con gracia vencida → SÍ (la gracia nunca quita acceso; lo corta el 4.º intento, como hoy)',
      { gracePeriodEndsAt: antes },
      true,
    ],
    [
      '🔴 los 4 días tras una prueba vencidos (vencimiento = fin de gracia, ya pasado) → NO',
      { endDate: antes, gracePeriodEndsAt: antes },
      false,
    ],
    ['pagada con gracia vigente', { gracePeriodEndsAt: despues }, true],
    ['una concesión vigente gana sobre una gracia vencida (cortesía de superadmin)', { endDate: despues, gracePeriodEndsAt: antes }, true],
    ['el vencimiento justo ahora todavía da acceso (igual que la regla de antes)', { endDate: AHORA }, true],
    ['la gracia justo ahora todavía da acceso', { endDate: antes, gracePeriodEndsAt: AHORA }, true],
  ])('%s', (_caso, f, esperado) => {
    expect(daAcceso(fila(f), AHORA)).toBe(esperado)
  })

  it('🔴 v4: NUNCA niega algo que la regla anterior concedía (la gracia sólo agrega acceso)', () => {
    const vieja = (f: Fila) => f.active && !f.suspendedAt && !(f.endDate && f.endDate < AHORA)
    for (const active of [true, false])
      for (const suspendedAt of [null, antes])
        for (const endDate of [null, antes, AHORA, despues])
          for (const gracePeriodEndsAt of [null, antes, AHORA, despues]) {
            const f = fila({ active, suspendedAt, endDate, gracePeriodEndsAt })
            if (vieja(f)) expect(daAcceso(f, AHORA)).toBe(true)
          }
  })

  it('REGRESIÓN: sin gracia contesta exactamente lo que contestaba isActiveWindow', () => {
    const vieja = (f: Fila) => f.active && !f.suspendedAt && !(f.endDate && f.endDate < AHORA)
    for (const active of [true, false])
      for (const suspendedAt of [null, antes])
        for (const endDate of [null, antes, AHORA, despues]) {
          const f = fila({ active, suspendedAt, endDate })
          expect(daAcceso(f, AHORA)).toBe(vieja(f))
        }
  })
})

/** Evalúa el `where` de Prisma que produce `ventanaDeAccesoWhere` sobre una fila en memoria (sólo los operadores que usa). */
function cumple(where: any, f: Record<string, any>): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'OR') return (v as any[]).some(w => cumple(w, f))
    if (k === 'AND') return (v as any[]).every(w => cumple(w, f))
    if (v === null) return f[k] === null
    if (typeof v === 'boolean') return f[k] === v
    if (v && typeof v === 'object' && 'gte' in v) return f[k] !== null && f[k].getTime() >= v.gte.getTime()
    throw new Error(`operador sin evaluar: ${k}`)
  })
}

describe('ventanaDeAccesoWhere — el mismo resultado que daAcceso, fila por fila', () => {
  it('coincide en las 2×2×4×4 combinaciones', () => {
    const where = ventanaDeAccesoWhere(AHORA)
    for (const active of [true, false])
      for (const suspendedAt of [null, antes])
        for (const endDate of [null, antes, AHORA, despues])
          for (const gracePeriodEndsAt of [null, antes, AHORA, despues]) {
            const f = fila({ active, suspendedAt, endDate, gracePeriodEndsAt })
            expect([JSON.stringify(f), cumple(where, f)]).toEqual([JSON.stringify(f), daAcceso(f, AHORA)])
          }
  })
})
