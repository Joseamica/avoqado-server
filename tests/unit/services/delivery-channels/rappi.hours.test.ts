/**
 * Nuestro horario → el de Rappi.
 *
 * Importa más que en Uber: la documentación de Rappi dice que una tienda SIN horario
 * configurado opera 24/7 — el escenario exacto que el horario de delivery existe para evitar.
 */
import {
  aFranjasDeTienda,
  aHorarioRappi,
  esPracticamente24x7,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.hours'
import type { HorarioSemanal } from '../../../../src/services/delivery-channels/core/deliveryHours.service'

const DIAS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

function horario(over: Partial<HorarioSemanal> = {}): HorarioSemanal {
  const base = {} as HorarioSemanal
  for (const d of DIAS) base[d] = { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] }
  return { ...base, ...over }
}

describe('aHorarioRappi', () => {
  it('agrupa los días con el mismo horario en una sola entrada', () => {
    const r = aHorarioRappi(horario())
    expect(r.schedule_details).toEqual([{ days: 'mon,tue,wed,thu,fri,sat,sun', starts_time: '09:00:00', ends_time: '22:00:00' }])
  })

  it('🔴 añade los SEGUNDOS: Rappi pide HH:mm:ss y mandarlos de menos es un 400', () => {
    expect(aHorarioRappi(horario()).schedule_details[0].starts_time).toBe('09:00:00')
  })

  // ── La única forma de decir "cerrado" en este formato ─────────────────────────────
  // No hay campo `enabled`: un día cerrado simplemente NO aparece. Mandarlo con franja
  // 00:00-00:00 lo dejaría abierto un instante, o lo rechazaría.
  it('🔴 el día cerrado NO aparece — es así como se expresa "cerrado"', () => {
    const r = aHorarioRappi(horario({ sunday: { enabled: false, ranges: [] } }))
    expect(r.schedule_details[0].days).toBe('mon,tue,wed,thu,fri,sat')
    expect(JSON.stringify(r)).not.toMatch(/sun/)
  })

  it('separa los días que tienen horarios distintos', () => {
    const r = aHorarioRappi(horario({ saturday: { enabled: true, ranges: [{ open: '10:00', close: '23:00' }] } }))
    expect(r.schedule_details).toHaveLength(2)
    expect(r.schedule_details.find(d => d.days === 'sat')?.ends_time).toBe('23:00:00')
  })

  it('un día con dos turnos (comida y cena) produce DOS entradas', () => {
    const r = aHorarioRappi(
      horario({
        monday: {
          enabled: true,
          ranges: [
            { open: '13:00', close: '17:00' },
            { open: '19:00', close: '23:00' },
          ],
        },
      }),
    )
    const lunes = r.schedule_details.filter(d => d.days === 'mon')
    expect(lunes).toHaveLength(2)
    expect(lunes.map(f => f.starts_time)).toEqual(['13:00:00', '19:00:00'])
  })

  it('un horario con todo cerrado devuelve la lista vacía, no revienta', () => {
    const cerrado = {} as HorarioSemanal
    for (const d of DIAS) cerrado[d] = { enabled: false, ranges: [] }
    expect(aHorarioRappi(cerrado).schedule_details).toEqual([])
  })
})

describe('aFranjasDeTienda', () => {
  // El horario de TIENDA se manda de una franja a la vez, no en lote: la forma es distinta.
  it('devuelve una llamada por franja, con `day` en singular', () => {
    const f = aFranjasDeTienda(horario({ sunday: { enabled: false, ranges: [] } }))
    expect(f).toHaveLength(6)
    expect(f[0]).toEqual({ day: 'mon', starts_time: '09:00:00', ends_time: '22:00:00' })
  })

  it('los días cerrados tampoco aparecen aquí', () => {
    const f = aFranjasDeTienda(horario({ sunday: { enabled: false, ranges: [] } }))
    expect(f.some(x => x.day === 'sun')).toBe(false)
  })
})

describe('esPracticamente24x7', () => {
  // 🔴 El default de Rappi ES 24/7. Publicar un horario que en la práctica equivale a eso
  // deja al comercio justo donde no queríamos: pedidos de madrugada que nadie cocina.
  it('detecta un horario que en la práctica es 24/7', () => {
    const todoElDia = {} as HorarioSemanal
    for (const d of DIAS) todoElDia[d] = { enabled: true, ranges: [{ open: '00:00', close: '23:59' }] }
    expect(esPracticamente24x7(todoElDia)).toBe(true)
  })

  it('un horario normal NO se marca como 24/7', () => {
    expect(esPracticamente24x7(horario())).toBe(false)
  })

  it('si un solo día está cerrado, ya no es 24/7', () => {
    const casi = {} as HorarioSemanal
    for (const d of DIAS) casi[d] = { enabled: true, ranges: [{ open: '00:00', close: '23:59' }] }
    casi.sunday = { enabled: false, ranges: [] }
    expect(esPracticamente24x7(casi)).toBe(false)
  })
})
