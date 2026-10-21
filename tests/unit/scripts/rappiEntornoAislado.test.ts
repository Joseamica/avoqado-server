/**
 * Las dos decisiones del script del entorno aislado de Rappi que no necesitan una base: la guarda por NOMBRE de base y la lectura de
 * argumentos. Lo que toca la base (vincular, jobs) se corre a mano en el recorrido real, no aquí.
 *
 * 🔴 `exigirBaseLocal()` deja pasar `av-db-25`, la base que comparten todas las sesiones; por eso el script exige además que el nombre
 * contenga `rappi-f2`. Esta prueba fija que `av-db-25` (y su variante `-test`) NO pasan, y que ningún mensaje de rechazo suelta la URL
 * (trae la contraseña).
 */
import {
  baseAislada,
  interpretarArgumentos,
  INTERVALO_JOBS_MS,
  MARCA_BASE_AISLADA,
  nombreDeBase,
} from '../../../scripts/rappi-entorno-aislado'
import { esBaseLocal } from '../../../scripts/_solo-base-local'

const CLAVE = 's3cr3t-que-no-debe-salir'
const url = (base: string) => `postgresql://postgres:${CLAVE}@localhost:5432/${base}`

describe('nombreDeBase', () => {
  it('saca sólo el nombre, sin usuario, contraseña, host ni parámetros', () => {
    expect(nombreDeBase(`${url('av-db-25-rappi-f2-test')}?schema=public&connection_limit=5`)).toBe('av-db-25-rappi-f2-test')
  })

  it.each([
    undefined,
    '',
    'esto no es una url',
    'postgresql://postgres:x@localhost:5432/',
    'postgresql://postgres:x@localhost:5432/%E0%A4%A',
  ])('devuelve undefined si no hay nombre legible (%s)', entrada => {
    expect(nombreDeBase(entrada)).toBeUndefined()
  })
})

describe('baseAislada', () => {
  it('deja pasar la copia del recorrido', () => {
    expect(baseAislada(url('av-db-25-rappi-f2-test')).ok).toBe(true)
  })

  it('la copia pasa también la guarda local (`-test`): las dos condiciones juntas son satisfacibles', () => {
    expect(esBaseLocal(url('av-db-25-rappi-f2-test')).ok).toBe(true)
  })

  describe('🔴 se niega con todo lo demás, empezando por la base compartida', () => {
    // Estas dos SÍ pasan `esBaseLocal`: son justo las que la marca existe para frenar.
    it.each(['av-db-25', 'av-db-25-test'])('%s pasa esBaseLocal pero NO es la copia', base => {
      expect(esBaseLocal(url(base)).ok).toBe(true)
      const r = baseAislada(url(base))
      expect(r.ok).toBe(false)
      expect(r.motivo).toContain(base)
      expect(r.motivo).toContain(MARCA_BASE_AISLADA)
    })

    it.each(['avoqado', 'postgres', 'avoqado_prod', 'rappi_f2', 'rappif2'])('%s', base => {
      expect(baseAislada(url(base)).ok).toBe(false)
    })

    it('sin DATABASE_URL', () => {
      expect(baseAislada(undefined).ok).toBe(false)
      expect(baseAislada('').ok).toBe(false)
    })

    it('con una URL ilegible', () => {
      expect(baseAislada('no es una url').ok).toBe(false)
    })
  })

  it('🔴 ningún motivo de rechazo imprime la URL ni la contraseña', () => {
    const rechazadas = [url('av-db-25'), url('avoqado_prod'), `${url('x')}?schema=public`, `postgresql://postgres:${CLAVE}@localhost:5432/`]
    for (const rechazada of rechazadas) {
      const { ok, motivo } = baseAislada(rechazada)
      expect(ok).toBe(false)
      expect(motivo).toBeDefined()
      expect(motivo).not.toContain(CLAVE)
      expect(motivo).not.toContain('postgresql://')
      expect(motivo).not.toContain('localhost')
    }
  })
})

describe('interpretarArgumentos', () => {
  it('vincular con tienda y venue', () => {
    expect(interpretarArgumentos(['vincular', '--tienda', '900175625', '--venue', 'cabc'])).toEqual({
      cmd: 'vincular',
      tienda: '900175625',
      venue: 'cabc',
    })
  })

  it('acepta las opciones en cualquier orden y antes del subcomando', () => {
    expect(interpretarArgumentos(['--venue', 'cabc', '--tienda', '900175625', 'vincular'])).toEqual({
      cmd: 'vincular',
      tienda: '900175625',
      venue: 'cabc',
    })
  })

  it('jobs, sin opciones', () => {
    expect(interpretarArgumentos(['jobs'])).toEqual({ cmd: 'jobs' })
  })

  describe('imprime el uso (devuelve error) con todo lo demás', () => {
    it.each([
      ['sin nada', []],
      ['subcomando desconocido', ['borrar']],
      ['vincular sin venue', ['vincular', '--tienda', '900175625']],
      ['vincular sin tienda', ['vincular', '--venue', 'cabc']],
      ['vincular con valores vacíos', ['vincular', '--tienda', ' ', '--venue', 'cabc']],
      ['opción sin valor', ['vincular', '--tienda']],
      ['opción desconocida', ['vincular', '--tienda', '1', '--venue', 'c', '--produccion']],
      ['jobs con opciones que no usa', ['jobs', '--tienda', '1']],
      ['argumento de sobra', ['jobs', 'otro']],
    ])('%s', (_caso, argv) => {
      const r = interpretarArgumentos(argv as string[])
      expect(r).toHaveProperty('error')
      expect((r as { error: string }).error.length).toBeGreaterThan(0)
    })
  })
})

describe('INTERVALO_JOBS_MS', () => {
  it('son 2 minutos (el plan); la Tarea 8 suma su carril de 30 s aparte, sin cambiar éste', () => {
    expect(INTERVALO_JOBS_MS).toBe(120_000)
  })
})
