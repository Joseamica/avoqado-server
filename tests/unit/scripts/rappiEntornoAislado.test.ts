/**
 * Las decisiones del script del entorno aislado de Rappi que no necesitan una base: la guarda por NOMBRE de base, la lectura de
 * argumentos, qué hacer con un vínculo que ya existe, cuándo `jobs` se niega a correr por vínculos de otros proveedores y cómo se
 * recortan los mensajes de error. Lo que toca la base (vincular, jobs) se corre a mano en el recorrido real, no aquí.
 *
 * 🔴 `exigirBaseLocal()` deja pasar `av-db-25`, la base que comparten todas las sesiones; por eso el script exige además que el nombre
 * contenga `rappi-f2`. Esta prueba fija que `av-db-25` (y su variante `-test`) NO pasan, y que ningún mensaje de rechazo suelta la URL
 * (trae la contraseña).
 */
import { DeliveryProvider, Prisma } from '@prisma/client'

import {
  baseAislada,
  CAMPOS_AL_REAPUNTAR,
  decidirVinculo,
  interpretarArgumentos,
  INTERVALO_CARRIL_RAPPI_MS,
  INTERVALO_JOBS_MS,
  MARCA_BASE_AISLADA,
  nombreDeBase,
  nombreEsAislado,
  primeraLinea,
  proveedoresAjenos,
  textoConteos,
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
      reapuntar: false,
    })
  })

  it('--reapuntar es opt-in y sólo de vincular', () => {
    expect(interpretarArgumentos(['vincular', '--tienda', '900175625', '--venue', 'cabc', '--reapuntar'])).toEqual({
      cmd: 'vincular',
      tienda: '900175625',
      venue: 'cabc',
      reapuntar: true,
    })
  })

  it('acepta las opciones en cualquier orden y antes del subcomando', () => {
    expect(interpretarArgumentos(['--venue', 'cabc', '--tienda', '900175625', 'vincular'])).toEqual({
      cmd: 'vincular',
      tienda: '900175625',
      venue: 'cabc',
      reapuntar: false,
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
      ['jobs con --reapuntar', ['jobs', '--reapuntar']],
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

  it('el carril de Rappi corre aparte cada 30 s (Tarea 8): un pedido a medias se retoma en ≤ 90 s', () => {
    expect(INTERVALO_CARRIL_RAPPI_MS).toBe(30_000)
  })
})

describe('nombreEsAislado (la base REAL a la que se conectó, `SELECT current_database()`)', () => {
  it('deja pasar la copia', () => {
    expect(nombreEsAislado('av-db-25-rappi-f2-test').ok).toBe(true)
  })

  it.each(['av-db-25', 'av-db-25-test', 'avoqado', 'postgres', '', undefined])('🔴 se niega con %p', nombre => {
    const r = nombreEsAislado(nombre)
    expect(r.ok).toBe(false)
    expect(r.motivo).toBeDefined()
  })

  it('el motivo dice qué base era, para poder corregir el entorno', () => {
    expect(nombreEsAislado('av-db-25').motivo).toContain('av-db-25')
  })
})

describe('decidirVinculo (qué hacer con el vínculo de la tienda)', () => {
  it.each([false, true])('sin vínculo previo: crea (reapuntar=%p)', reapuntar => {
    expect(decidirVinculo(null, 'cvenueB', reapuntar)).toEqual({ accion: 'CREAR' })
  })

  it.each([false, true])('mismo venue: actualiza, igual que antes y sin limpiar nada (reapuntar=%p)', reapuntar => {
    expect(decidirVinculo({ venueId: 'cvenueA' }, 'cvenueA', reapuntar)).toEqual({ accion: 'ACTUALIZAR' })
  })

  it('🔴 otro venue y SIN --reapuntar: aborta, y el motivo nombra los dos venues y la salida', () => {
    const d = decidirVinculo({ venueId: 'cvenueA' }, 'cvenueB', false)
    expect(d.accion).toBe('ABORTAR')
    const motivo = (d as { motivo: string }).motivo
    expect(motivo).toContain('cvenueA')
    expect(motivo).toContain('cvenueB')
    expect(motivo).toContain('--reapuntar')
  })

  it('otro venue CON --reapuntar: re-apunta y dice desde cuál', () => {
    expect(decidirVinculo({ venueId: 'cvenueA' }, 'cvenueB', true)).toEqual({ accion: 'REAPUNTAR', venueAnterior: 'cvenueA' })
  })
})

describe('CAMPOS_AL_REAPUNTAR (lo que se limpia al mover el vínculo de venue)', () => {
  it('deja en null la huella del menú, su fecha, la config y la activación', () => {
    expect(CAMPOS_AL_REAPUNTAR).toEqual({
      lastMenuHash: null,
      lastMenuSyncAt: null,
      config: Prisma.DbNull,
      activatingIntentId: null,
      activationOwner: null,
    })
  })

  it('🔴 cada campo es un campo REAL del modelo DeliveryChannelLink (un nombre inventado fallaría en silencio en la copia)', () => {
    for (const campo of Object.keys(CAMPOS_AL_REAPUNTAR)) {
      expect(Prisma.DeliveryChannelLinkScalarFieldEnum).toHaveProperty(campo)
    }
  })
})

describe('proveedoresAjenos (`jobs` se niega a correr si hay vínculos ACTIVE de otro proveedor)', () => {
  it('sin vínculos o sólo de RAPPI: nada ajeno', () => {
    expect(proveedoresAjenos([])).toEqual([])
    expect(proveedoresAjenos([{ provider: DeliveryProvider.RAPPI, cantidad: 3 }])).toEqual([])
  })

  it('🔴 cualquier otro proveedor con al menos un vínculo cuenta como ajeno, aunque haya RAPPI', () => {
    expect(
      proveedoresAjenos([
        { provider: DeliveryProvider.RAPPI, cantidad: 1 },
        { provider: DeliveryProvider.UBER_EATS, cantidad: 2 },
      ]),
    ).toEqual([{ provider: DeliveryProvider.UBER_EATS, cantidad: 2 }])
  })

  it.each(Object.values(DeliveryProvider).filter(p => p !== DeliveryProvider.RAPPI))(
    '%s es ajeno (también uno que se agregue mañana)',
    provider => {
      expect(proveedoresAjenos([{ provider, cantidad: 1 }])).toEqual([{ provider, cantidad: 1 }])
    },
  )

  it('un proveedor ajeno con 0 vínculos no frena', () => {
    expect(proveedoresAjenos([{ provider: DeliveryProvider.DELIVERECT, cantidad: 0 }])).toEqual([])
  })
})

describe('textoConteos (lo único que se imprime de los vínculos: proveedor y cantidad)', () => {
  it('sin vínculos: «ninguno»', () => {
    expect(textoConteos([])).toBe('ninguno')
  })

  it('proveedor=cantidad, separados por «·»', () => {
    expect(
      textoConteos([
        { provider: DeliveryProvider.RAPPI, cantidad: 1 },
        { provider: DeliveryProvider.UBER_EATS, cantidad: 2 },
      ]),
    ).toBe('RAPPI=1 · UBER_EATS=2')
  })
})

describe('primeraLinea (los errores de validación de Prisma traen los argumentos en las líneas de abajo)', () => {
  it('sólo la primera línea', () => {
    expect(primeraLinea(new Error('primera\nsegunda'))).toBe('primera')
  })

  it('🔴 salta el salto de línea inicial que Prisma antepone, y no suelta los argumentos', () => {
    const e = new Error(
      '\nInvalid `prisma.deliveryChannelLink.upsert()` invocation in\n/ruta/script.ts:150:7\n\n  data: { webhookSecret: "abc123" }',
    )
    const texto = primeraLinea(e)
    expect(texto).toBe('Invalid `prisma.deliveryChannelLink.upsert()` invocation in')
    expect(texto).not.toContain('abc123')
  })

  it('un valor que no es Error', () => {
    expect(primeraLinea('texto\nmás')).toBe('texto')
    expect(primeraLinea(42)).toBe('42')
  })

  it('un mensaje vacío no deja una línea en blanco', () => {
    expect(primeraLinea(new Error(''))).toBe('error desconocido')
  })

  it('una primera línea larguísima se recorta', () => {
    const texto = primeraLinea(new Error('x'.repeat(2000)))
    expect(texto.length).toBeLessThanOrEqual(301)
    expect(texto.endsWith('…')).toBe(true)
  })
})
