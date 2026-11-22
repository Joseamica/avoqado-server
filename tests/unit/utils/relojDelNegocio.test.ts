/**
 * D13 (carril E, Codex r4): la fecha de cada fila del exporte en la hora del negocio, rápida y sin tumbar el archivo por una zona
 * guardada fuera de IANA. Correr con TZ=UTC, como Render: el reloj sale de la zona del negocio, nunca de la del proceso.
 */
import { relojDelNegocio } from '@/utils/datetime'
import { zonaDelCalculo } from '@/utils/sanitizeTimezone'

describe('relojDelNegocio', () => {
  it('las 02:30 UTC del 22 son las 20:30 del 21 en CDMX, con su desfase', () => {
    expect(relojDelNegocio(new Date('2026-11-22T02:30:05.000Z'), 'America/Mexico_City')).toEqual({
      anio: '2026',
      mes: '11',
      dia: '21',
      hora: '20',
      minuto: '30',
      segundo: '05',
      desfase: '-06:00',
    })
  })

  it('la medianoche sale «00», no «24»', () => {
    expect(relojDelNegocio(new Date('2026-11-22T06:00:00.000Z'), 'America/Mexico_City').hora).toBe('00')
  })

  it('la misma hora del reloj dos veces (Tijuana atrasa el 1-nov) se distingue por el desfase', () => {
    expect(relojDelNegocio(new Date('2026-11-01T08:30:00.000Z'), 'America/Tijuana')).toMatchObject({ hora: '01', desfase: '-07:00' })
    expect(relojDelNegocio(new Date('2026-11-01T09:30:00.000Z'), 'America/Tijuana')).toMatchObject({ hora: '01', desfase: '-08:00' })
  })

  it('«GMT» va a desfase cero; una zona inválida («GMT-6») o vacía cae a CDMX sin lanzar', () => {
    expect(relojDelNegocio(new Date('2026-11-22T02:30:00.000Z'), 'UTC')).toMatchObject({ dia: '22', hora: '02', desfase: '+00:00' })
    expect(relojDelNegocio(new Date('2026-11-22T02:30:00.000Z'), 'GMT-6')).toMatchObject({ dia: '21', hora: '20' })
    expect(relojDelNegocio(new Date('2026-11-22T02:30:00.000Z'), null)).toMatchObject({ dia: '21', hora: '20' })
    // Codex r6: un texto largo (no es una zona) no se guarda como llave del caché: va el default.
    expect(relojDelNegocio(new Date('2026-11-22T02:30:00.000Z'), 'x'.repeat(100_000))).toMatchObject({ dia: '21', hora: '20' })
  })

  it('20,000 filas no retienen el hilo (un formateador por zona), tampoco con una zona inválida (Codex r5)', () => {
    const t0 = Date.now()
    for (let i = 0; i < 20_000; i++) relojDelNegocio(new Date(1_790_000_000_000 + i * 60_000), i % 2 ? 'America/Mexico_City' : 'GMT-6')
    // Con `formatInTimeZone` por fila eran ~880 ms en la Mac (Codex r4); ahora ~80 ms. Holgura para una máquina cargada.
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe('zonaDelCalculo', () => {
  it('deja pasar una zona IANA; un nombre que Intl conoce va a su forma canónica; lo demás, a CDMX', () => {
    expect(zonaDelCalculo('America/Tijuana')).toBe('America/Tijuana')
    expect(zonaDelCalculo('UTC')).toBe('UTC')
    // Codex r5: «GMT» es la misma hora que «UTC»; mandarla a CDMX corría seis horas el día de la MCP.
    expect(zonaDelCalculo('GMT')).toBe('UTC')
    for (const mala of ['GMT-6', 'Foo/Bar', '', null, undefined]) expect(zonaDelCalculo(mala)).toBe('America/Mexico_City')
  })
})
