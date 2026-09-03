import { Prisma } from '@prisma/client'
import { decidirReparacionDelCierre, type GavetaDeLaPareja, type TurnoDeLaPareja } from '@/services/shared/parejaDeCierre'

const VENUE = 'venue-1'
const TURNO = 'shift-1'
const CAJA = 'caja-1'
const CERRADO_A_LAS = new Date('2026-09-03T20:05:00.000Z')
const ABIERTO_A_LAS = new Date('2026-09-03T14:00:00.000Z')

function gaveta(over: Partial<GavetaDeLaPareja> = {}): GavetaDeLaPareja {
  return {
    id: CAJA,
    venueId: VENUE,
    shiftId: TURNO,
    status: 'CLOSED',
    openedAt: ABIERTO_A_LAS,
    closedAt: CERRADO_A_LAS,
    actualAmount: new Prisma.Decimal('2950.00'),
    overShort: new Prisma.Decimal('-50.00'),
    closedByStaffId: 'staff-1',
    ...over,
  }
}

function turno(over: Partial<TurnoDeLaPareja> = {}): TurnoDeLaPareja {
  return {
    id: TURNO,
    venueId: VENUE,
    status: 'OPEN',
    startTime: ABIERTO_A_LAS,
    endTime: null,
    cashDeclared: null,
    cashDifference: null,
    closedById: null,
    ...over,
  }
}

describe('parejaDeCierre — qué mitad falta y con qué números se firma', () => {
  describe('🔴 la gaveta cerró y su turno sigue abierto (el gesto de la tablet murió a medias)', () => {
    it('manda cerrar el TURNO con el conteo y el esperado que la gaveta YA firmó', () => {
      const r = decidirReparacionDelCierre(gaveta(), turno(), { hayTurnoAbierto: true })

      expect(r.reparable).toBe(true)
      if (!r.reparable) return
      expect(r.falta).toBe('TURNO')
      expect(r.venueId).toBe(VENUE)
      expect(r.shiftId).toBe(TURNO)
      expect(r.cashDrawerSessionId).toBe(CAJA)
      expect(Number(r.conteo)).toBe(2950)
      // 🔴 El esperado NO se recalcula: sale de lo persistido, `actualAmount − overShort`. Recalcularlo
      // sería una segunda foto y las dos mitades firmarían números distintos del mismo billete.
      expect(Number(r.esperado)).toBe(3000)
      expect(r.actorStaffId).toBe('staff-1')
      expect(r.momento).toEqual(CERRADO_A_LAS)
    })

    it('🔴 una gaveta que cerró SOLA (auto-cierre o relevo) no repara nada: nadie contó y no es este gesto', () => {
      const r = decidirReparacionDelCierre(gaveta({ actualAmount: null, overShort: null, closedByStaffId: null }), turno(), {
        hayTurnoAbierto: true,
      })

      expect(r.reparable).toBe(false)
      if (r.reparable) return
      expect(r.motivo).toBe('CIERRE_AUTOMATICO')
    })

    it('🔴 contar CERO es un conteo real: una gaveta vacía con $3,000 esperados es un faltante de $3,000', () => {
      const r = decidirReparacionDelCierre(
        gaveta({ actualAmount: new Prisma.Decimal('0.00'), overShort: new Prisma.Decimal('-3000.00') }),
        turno(),
        { hayTurnoAbierto: true },
      )

      expect(r.reparable).toBe(true)
      if (!r.reparable) return
      expect(r.conteo).not.toBeNull()
      expect(Number(r.conteo)).toBe(0)
      expect(Number(r.esperado)).toBe(3000)
    })

    it('un conteo sin diferencia firmada no se repara a ciegas: se reporta', () => {
      // `Decimal(10,2)` desbordado: el turno se negó a firmar la diferencia. Recalcular el esperado
      // aquí le daría a la otra mitad un número que la primera rechazó.
      const r = decidirReparacionDelCierre(gaveta({ overShort: null }), turno(), { hayTurnoAbierto: true })

      expect(r.reparable).toBe(false)
      if (r.reparable) return
      expect(r.motivo).toBe('SIN_NUMEROS_PAREJOS')
    })
  })

  describe('🔴 el turno cerró y su gaveta sigue abierta (el gesto de la PAX murió a medias)', () => {
    const turnoCerrado = turno({
      status: 'CLOSED',
      endTime: CERRADO_A_LAS,
      cashDeclared: new Prisma.Decimal('2950.00'),
      cashDifference: new Prisma.Decimal('-50.00'),
      closedById: 'staff-2',
    })
    const gavetaAbierta = gaveta({ status: 'OPEN', closedAt: null, actualAmount: null, overShort: null, closedByStaffId: null })

    it('manda cerrar la GAVETA con el conteo y el esperado que el turno YA firmó', () => {
      const r = decidirReparacionDelCierre(gavetaAbierta, turnoCerrado, { hayTurnoAbierto: false })

      expect(r.reparable).toBe(true)
      if (!r.reparable) return
      expect(r.falta).toBe('GAVETA')
      expect(Number(r.conteo)).toBe(2950)
      expect(Number(r.esperado)).toBe(3000)
      expect(r.actorStaffId).toBe('staff-2')
      // El instante de la pareja es el que la primera mitad firmó, no el del barrido: así la gaveta
      // no absorbe hacia atrás las ventas que entraron después del cierre del turno.
      expect(r.momento).toEqual(CERRADO_A_LAS)
    })

    it('🔴 si el turno cerró SIN conteo, la gaveta se cierra SIN conteo: jamás se inventa uno', () => {
      const r = decidirReparacionDelCierre(gavetaAbierta, turno({ status: 'CLOSED', endTime: CERRADO_A_LAS, closedById: 'staff-2' }), {
        hayTurnoAbierto: false,
      })

      expect(r.reparable).toBe(true)
      if (!r.reparable) return
      expect(r.conteo).toBeNull()
      expect(r.esperado).toBeNull()
    })

    it('🔴 NUNCA se le quita la gaveta a quien está vendiendo: con un turno abierto se reporta y no se toca', () => {
      // Escenario real: el turno cerró a las 20:05 y la mitad de la gaveta falló; a las 20:20 alguien
      // abrió un turno nuevo, que REUSA esa misma gaveta. Cerrarla aquí dejaría al mostrador sin caja.
      // Es también el relevo: cierra el turno de ayer y crea el de hoy en la MISMA transacción, así
      // que su gaveta superviviente siempre tiene un turno abierto encima.
      const r = decidirReparacionDelCierre(gavetaAbierta, turnoCerrado, { hayTurnoAbierto: true })

      expect(r.reparable).toBe(false)
      if (r.reparable) return
      expect(r.motivo).toBe('EL_NEGOCIO_SIGUIO')
    })

    it('una gaveta abierta ANTES de que existiera su turno sigue siendo suya: la liga manda, no el reloj', () => {
      // Testarudo, 1-sep: la caja abrió 07:38 y el turno 08:12. Un filtro por `openedAt >= startTime`
      // dejaría fuera justo la forma que produce producción.
      const r = decidirReparacionDelCierre(
        gaveta({
          status: 'OPEN',
          closedAt: null,
          actualAmount: null,
          overShort: null,
          closedByStaffId: null,
          openedAt: new Date('2026-09-03T13:38:00.000Z'),
        }),
        turnoCerrado,
        { hayTurnoAbierto: false },
      )

      expect(r.reparable).toBe(true)
    })
  })

  describe('lo que NO es una pareja a medias', () => {
    it('los dos cerrados: no hay nada que reparar', () => {
      const r = decidirReparacionDelCierre(gaveta(), turno({ status: 'CLOSED', endTime: CERRADO_A_LAS }), { hayTurnoAbierto: false })

      expect(r.reparable).toBe(false)
      if (r.reparable) return
      expect(r.motivo).toBe('PAREJA_COMPLETA')
    })

    it('los dos abiertos: el gesto ni siquiera ha empezado', () => {
      const r = decidirReparacionDelCierre(
        gaveta({ status: 'OPEN', closedAt: null, actualAmount: null, overShort: null, closedByStaffId: null }),
        turno(),
        { hayTurnoAbierto: true },
      )

      expect(r.reparable).toBe(false)
      if (r.reparable) return
      expect(r.motivo).toBe('PAREJA_COMPLETA')
    })

    it('🔴 un turno en CLOSING no se toca: hay un cierre en vuelo y el vigilante puede devolverlo a OPEN', () => {
      const r = decidirReparacionDelCierre(gaveta(), turno({ status: 'CLOSING' }), { hayTurnoAbierto: true })

      expect(r.reparable).toBe(false)
      if (r.reparable) return
      expect(r.motivo).toBe('CIERRE_EN_VUELO')
    })

    it('una gaveta cerrada sin `closedAt` no da instante que firmar: se reporta', () => {
      const r = decidirReparacionDelCierre(gaveta({ closedAt: null }), turno(), { hayTurnoAbierto: true })

      expect(r.reparable).toBe(false)
      if (r.reparable) return
      expect(r.motivo).toBe('SIN_NUMEROS_PAREJOS')
    })

    it('un turno cerrado sin `endTime` tampoco: se reporta', () => {
      const r = decidirReparacionDelCierre(
        gaveta({ status: 'OPEN', closedAt: null, actualAmount: null, overShort: null, closedByStaffId: null }),
        turno({ status: 'CLOSED', endTime: null }),
        { hayTurnoAbierto: false },
      )

      expect(r.reparable).toBe(false)
      if (r.reparable) return
      expect(r.motivo).toBe('SIN_NUMEROS_PAREJOS')
    })

    it('la pareja tiene que ser del MISMO negocio', () => {
      const r = decidirReparacionDelCierre(gaveta(), turno({ venueId: 'venue-2' }), { hayTurnoAbierto: true })

      expect(r.reparable).toBe(false)
      if (r.reparable) return
      expect(r.motivo).toBe('NEGOCIOS_DISTINTOS')
    })
  })
})
