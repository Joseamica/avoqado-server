/**
 * Codex R8 (l) / R9 (l): los actores en vuelo de una prueba de carrera nunca esconden su desenlace — ni un rechazo detrás de
 * una aserción caída, ni una operación que no termina. Este módulo es lo que vuelve certificable una caída por aserción.
 */
import { stripVTControlCharacters } from 'node:util'

import { actores } from '../../integration/payments/actores'

const rechazoTardio = (ms: number, msg: string) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))
const valorTardio = <T>(ms: number, v: T) => new Promise<T>(r => setTimeout(() => r(v), ms))

describe('actores en vuelo', () => {
  it('sin fallo previo y con todos los actores asentados, `cerrar` deja seguir y `resultado()` devuelve el valor', async () => {
    const a = actores(1000)
    const x = a.lanzar('x', valorTardio(10, 42))
    await a.cerrar()
    expect(await x.resultado()).toBe(42)
    expect(() => a.examinados()).not.toThrow()
  })

  it('`resultado()` relanza el rechazo del actor, igual que `await promesa` — y con `.resolves` es una ASERCIÓN', async () => {
    const a = actores(1000)
    const x = a.lanzar('REST', rechazoTardio(10, 'HTTP 503 CONSOLIDATION_UNCERTAIN'))
    await a.cerrar()
    await expect(x.resultado()).rejects.toThrow('503')
    expect(() => a.examinados()).not.toThrow()
  })

  it('con una aserción caída ANTES y un actor que rechazó detrás: INCONCLUSO, conservando el fallo original (mensaje y `cause`) — nunca una caída «por aserción» limpia', async () => {
    const a = actores(1000)
    a.lanzar('REST de A', rechazoTardio(10, 'HTTP 503 PAYMENT_REGISTRATION_UNRESOLVED_CONSOLIDATION_UNCERTAIN'))
    a.lanzar('vínculo', valorTardio(10, { success: true }))
    const original = new Error('expect(received).toBe(expected)\n\nExpected: true\nReceived: false')
    let capturado: unknown
    try {
      await a.cerrar({ error: original })
    } catch (e) {
      capturado = e
    }
    expect(capturado).toBeInstanceOf(Error)
    const err = capturado as Error & { cause?: unknown }
    expect(err.message).toMatch(/^INCONCLUSO — /)
    expect(err.message).toContain('REST de A: HTTP 503 PAYMENT_REGISTRATION_UNRESOLVED_CONSOLIDATION_UNCERTAIN')
    expect(err.message).toContain('fallo original: expect(received).toBe(expected)')
    expect(err.message).not.toContain('vínculo:')
    expect(err.cause).toBe(original)
  })

  it('con una aserción caída antes y TODOS los actores resueltos: relanza el fallo original tal cual (la caída sigue siendo por aserción)', async () => {
    const a = actores(1000)
    a.lanzar('REST', valorTardio(10, 'ok'))
    const original = new Error('expect(received).toBe(expected)')
    await expect(a.cerrar({ error: original })).rejects.toBe(original)
  })

  it('un actor que NO se asienta en la espera acotada ⇒ INCONCLUSO (con o sin fallo previo), nombrándolo', async () => {
    const a = actores(50)
    a.lanzar('REST colgado', new Promise<never>(() => undefined))
    await expect(a.cerrar()).rejects.toThrow(/^INCONCLUSO — actores sin asentar tras 50 ms: \[REST colgado\]/)
    const b = actores(50)
    b.lanzar('REST colgado', new Promise<never>(() => undefined))
    await expect(b.cerrar({ error: new Error('expect(x).toBe(y)') })).rejects.toThrow(
      /INCONCLUSO — actores sin asentar.*fallo original: expect\(x\)\.toBe\(y\)/,
    )
  })

  it('un actor lanzado que nadie examinó ⇒ `examinados()` lo denuncia (aunque haya resuelto bien)', async () => {
    const a = actores(1000)
    a.lanzar('E', valorTardio(5, 1))
    const f = a.lanzar('F', valorTardio(5, 2))
    await a.cerrar()
    await f.resultado()
    expect(() => a.examinados()).toThrow(/INCONCLUSO — actores lanzados y nunca examinados: \[E\]/)
  })

  it('Codex R10 (l) · `afirmar`: una aserción cae a medias y un actor RECHAZADO quedaba por examinar ⇒ INCONCLUSO con el fallo original (mensaje y `cause`), nunca una caída «por aserción» limpia', async () => {
    const a = actores(1000)
    const link = a.lanzar('vínculo', valorTardio(5, { success: true, outcome: 'LINKED' }))
    a.lanzar('REST de A', rechazoTardio(5, 'HTTP 503 CONSOLIDATION_UNCERTAIN'))
    await a.cerrar()
    const original = new Error('expect(received).toMatchObject(expected)')
    let capturado: unknown
    try {
      await a.afirmar(async () => {
        await link.resultado() // examinado
        throw original // la aserción sobre el vínculo cae; el REST ya no se examinaría
      })
    } catch (e) {
      capturado = e
    }
    const err = capturado as Error & { cause?: unknown }
    expect(err.message).toMatch(
      /^INCONCLUSO — rechazos que la fase de aserciones ya no examinó: \[REST de A: HTTP 503 CONSOLIDATION_UNCERTAIN\]/,
    )
    expect(err.message).toContain('fallo original: expect(received).toMatchObject(expected)')
    expect(err.cause).toBe(original)
  })

  it('Codex R10 (l) · `afirmar`: una aserción cae y los actores restantes RESOLVIERON ⇒ se relanza el fallo original tal cual', async () => {
    const a = actores(1000)
    a.lanzar('REST', valorTardio(5, 'ok'))
    await a.cerrar()
    const original = new Error('expect(received).toBe(expected)')
    await expect(
      a.afirmar(async () => {
        throw original
      }),
    ).rejects.toBe(original)
  })

  it('Codex R10 (l) · `afirmar` termina bien pero un actor nunca se examinó ⇒ INCONCLUSO', async () => {
    const a = actores(1000)
    a.lanzar('E', valorTardio(5, 1))
    await a.cerrar()
    await expect(a.afirmar(async () => undefined)).rejects.toThrow(/INCONCLUSO — actores lanzados y nunca examinados: \[E\]/)
  })

  it('Codex R10 (l) · `carrera` que gana el RELOJ no acredita examen (`BLOQUEADA`, el actor sigue sin examinar); la que gana el actor entrega su desenlace y lo examina', async () => {
    const a = actores(1000)
    const lento = a.lanzar('worker lento', valorTardio(200, false))
    expect(await a.carrera(lento, 20)).toEqual({ estado: 'BLOQUEADA' })
    await a.cerrar()
    // Sin examinar todavía: `afirmar` lo denuncia si nadie lo mira.
    await expect(a.afirmar(async () => undefined)).rejects.toThrow(/nunca examinados: \[worker lento\]/)
    const b = actores(1000)
    const rapido = b.lanzar('rápido', valorTardio(5, 'CONTENDIDA'))
    expect(await b.carrera(rapido, 500)).toEqual({ estado: 'ASENTADA', ok: true, value: 'CONTENDIDA' })
    await b.cerrar()
    await expect(b.afirmar(async () => undefined)).resolves.toBeUndefined()
    const c = actores(1000)
    const roto = c.lanzar('roto', rechazoTardio(5, 'boom'))
    const d = await c.carrera(roto, 500)
    expect(d).toMatchObject({ estado: 'ASENTADA', ok: false })
    await c.cerrar()
  })

  it('Codex R11 (l) · DOS actores rechazan con errores DISTINTOS: la fase afirma el primero (cae) y el segundo, que nadie llegó a examinar, NO se pierde ⇒ INCONCLUSO lo nombra con SU mensaje y conserva el primero como fallo original', async () => {
    const a = actores(1000)
    const k1 = a.lanzar('K1', rechazoTardio(5, 'HTTP 409 TERMINAL_BUSY'))
    a.lanzar('K2', rechazoTardio(5, 'HTTP 503 CONSOLIDATION_UNCERTAIN'))
    await a.cerrar()
    let capturado: unknown
    try {
      await a.afirmar(async () => {
        await expect(k1.resultado()).resolves.toMatchObject({ id: expect.any(String) }) // cae: K1 rechazó
        // K2 nunca se llega a examinar
      })
    } catch (e) {
      capturado = e
    }
    const err = capturado as Error & { cause?: unknown }
    // En una terminal Jest pinta `received`/`expected` con códigos ANSI dentro del mensaje (en el CI no): se compara sin ellos.
    const mensaje = stripVTControlCharacters(err.message)
    expect(mensaje).toMatch(/^INCONCLUSO — rechazos que la fase de aserciones ya no examinó: \[K2: HTTP 503 CONSOLIDATION_UNCERTAIN\]/)
    expect(mensaje).toContain('fallo original: expect(received).resolves')
    expect(mensaje).not.toMatch(/K1: HTTP 409/) // K1 sí se examinó: viaja como fallo original, no como rechazo escondido
    expect(err.cause).toBeInstanceOf(Error)
    expect((err.cause as Error).message).toContain('TERMINAL_BUSY') // el fallo original conserva el desenlace de K1 entero
  })

  it('Codex R11 (l) · una aserción cae ANTES de examinar a nadie y un actor había rechazado ⇒ INCONCLUSO (el rechazo no queda escondido detrás de la aserción); con todos resueltos, la misma caída se relanza tal cual', async () => {
    const a = actores(1000)
    a.lanzar('REST', rechazoTardio(5, 'HTTP 503 CONSOLIDATION_UNCERTAIN'))
    await a.cerrar()
    await expect(
      a.afirmar(async () => {
        expect(1).toBe(2)
      }),
    ).rejects.toThrow(/^INCONCLUSO — rechazos que la fase de aserciones ya no examinó: \[REST: HTTP 503 CONSOLIDATION_UNCERTAIN\]/)
    const b = actores(1000)
    b.lanzar('REST', valorTardio(5, 'ok'))
    await b.cerrar()
    // La caída se relanza tal cual; en una terminal su mensaje trae los colores de Jest: se compara sin ellos.
    const caida = await b
      .afirmar(async () => {
        expect(1).toBe(2)
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    expect(caida).toBeInstanceOf(Error)
    expect(stripVTControlCharacters((caida as Error).message)).toMatch(/expect\(received\)\.toBe\(expected\)/)
  })

  /**
   * Codex R11 (l) / R12-13: guardia ESTÁTICA y LIMITADA — no es un verificador de JavaScript. Lee cada prueba de pagos y busca
   * agregados `Promise.all / race / allSettled / any` cuyo ARGUMENTO (con paréntesis balanceados, aunque ocupe varias líneas)
   * contenga `.resultado()` o el nombre de una variable a la que antes se asignó un `.resultado()` (alias). Lo que NO ve: un
   * alias construido de otra forma, una carrera entre señales ajenas a los actores, o un agregado escrito vía otra función.
   * Por eso los desenlaces se afirman uno por uno o compiten con `carrera` — y la guardia sólo cierra la puerta más común.
   */
  const agregadosProhibidos = (fuente: string): string[] => {
    const infracciones: string[] = []
    const aliases = new Set<string>()
    for (const m of fuente.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w$.]+\.resultado\(\)/g)) aliases.add(m[1])
    const re = /Promise\s*\.\s*(all|race|allSettled|any)\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(fuente)) !== null) {
      // Argumento con paréntesis balanceados (multilínea).
      let profundidad = 1
      let i = m.index + m[0].length
      const inicio = i
      while (i < fuente.length && profundidad > 0) {
        if (fuente[i] === '(') profundidad++
        else if (fuente[i] === ')') profundidad--
        i++
      }
      const argumento = fuente.slice(inicio, i - 1)
      const linea = fuente.slice(0, m.index).split('\n').length
      if (/\.resultado\(\)/.test(argumento)) infracciones.push(`${linea}: resultado() dentro de Promise.${m[1]}`)
      for (const alias of aliases)
        if (new RegExp(`\\b${alias}\\b`).test(argumento))
          infracciones.push(`${linea}: alias ${alias} de resultado() dentro de Promise.${m[1]}`)
    }
    return infracciones
  }

  it('Codex R11 (l) / R12-13 · guardia: ninguna prueba de pagos agrega `resultado()` (ni en varias líneas, ni por alias) con `Promise.all` / `race` / `allSettled` / `any` — cada desenlace se afirma por separado o compite con `carrera`', () => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const carpeta = path.resolve(__dirname, '../../integration/payments')
    const archivos = fs.readdirSync(carpeta).filter(n => n.endsWith('.integration.test.ts'))
    expect(archivos.length).toBeGreaterThan(0)
    const infractores: string[] = []
    for (const nombre of archivos) {
      for (const inf of agregadosProhibidos(fs.readFileSync(path.join(carpeta, nombre), 'utf-8'))) infractores.push(`${nombre}:${inf}`)
    }
    expect(infractores).toEqual([])
  })

  it('Codex R12-13 · la guardia SÍ ve un agregado multilínea y un alias (y no acusa a un `allSettled` de señales ajenas a los actores)', () => {
    expect(
      agregadosProhibidos(`
      const [a, b] = await Promise.all([
        k1.resultado(),
        k2.resultado(),
      ])`),
    ).toEqual(['2: resultado() dentro de Promise.all'])
    expect(
      agregadosProhibidos(`
      const r1 = k1.resultado()
      const r2 = await Promise.race([r1, reloj])`),
    ).toEqual(['3: alias r1 de resultado() dentro de Promise.race'])
    expect(agregadosProhibidos(`await Promise.allSettled([senal1, senal2])`)).toEqual([])
  })

  it('Codex R12-13 · MONTAJE: un trabajo de montaje que rechaza vuelve INCONCLUSA la prueba en `cerrar` aunque ninguna aserción cayera y nadie lo examine, conservando su causa', async () => {
    const a = actores(1000)
    const causa = new Error('UPDATE de K1 falló')
    a.montaje('transacción que escribe K1', Promise.reject(causa))
    a.lanzar('K2', Promise.resolve('ok'))
    await new Promise(r => setTimeout(r, 10))
    // `cerrar` RECHAZA (se afirma: si resolviera, la prueba cae por aserción, no por un `undefined.message`).
    const err = await a.cerrar().then(
      () => null,
      e => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toMatch(/^INCONCLUSO — montaje fallido: \[transacción que escribe K1: UPDATE de K1 falló\]/)
    expect(err.cause).toBe(causa)
  })

  it('Codex R12-13 · MONTAJE: la adquisición de un mutex que falla ANTES de devolver el cleanup es INCONCLUSO (con la causa), no una caída limpia ni un cuelgue', async () => {
    const a = actores(300)
    const adquisicion = a.montaje('mutex del fixture', rechazoTardio(20, 'no se pudo tomar el mutex'))
    let fallo: { error: unknown } | null = null
    try {
      await adquisicion.resultado() // la prueba lo examina y cae aquí
    } catch (error) {
      fallo = { error }
    }
    const err = await a.cerrar(fallo).then(
      () => null,
      e => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toMatch(/INCONCLUSO — montaje fallido: \[mutex del fixture: no se pudo tomar el mutex\]/)
    expect(String(err.message)).toMatch(/fallo original: no se pudo tomar el mutex/)
  })

  it('Codex R12-13 · LIBERACIÓN: todas las barreras se sueltan aunque una rechace, y un error de liberación junto con un worker rechazado terminan en UN INCONCLUSO que nombra los dos', async () => {
    const a = actores(1000)
    a.lanzar('worker', Promise.reject(new Error('worker rechazado')))
    const soltadas: string[] = []
    // `liberar` NUNCA rechaza (captura cada error de liberación y sigue con las demás barreras): se afirma.
    const liberacion = await a
      .liberar({
        'barrera 1': async () => {
          throw new Error('soltar() rechazó')
        },
        'barrera 2': () => {
          soltadas.push('2')
        },
      })
      .then(
        fallidas => ({ ok: true as const, fallidas }),
        e => ({ ok: false as const, e: String(e) }),
      )
    expect(liberacion).toEqual({ ok: true, fallidas: 1 })
    expect(soltadas).toEqual(['2']) // la segunda se soltó aunque la primera falló
    const err = await a.cerrar({ error: new Error('aserción caída') }).then(
      () => null,
      e => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toMatch(/liberación fallida: \[barrera 1: soltar\(\) rechazó\]/)
    expect(String(err.message)).toMatch(/rechazos que la prueba ya no examinó: \[worker: worker rechazado\]/)
    expect(String(err.message)).toMatch(/fallo original: aserción caída/)
  })

  it('Codex R12-13 · LIBERACIÓN sin fallo previo: un error de liberación por sí solo también es INCONCLUSO (nunca un verde con una barrera mal soltada)', async () => {
    const a = actores(1000)
    a.lanzar('REST', Promise.resolve(1))
    const liberacion = await a
      .liberar({
        candado: async () => {
          throw new Error('commit del candado falló')
        },
      })
      .then(
        fallidas => ({ ok: true as const, fallidas }),
        e => ({ ok: false as const, e: String(e) }),
      )
    expect(liberacion).toEqual({ ok: true, fallidas: 1 })
    const err = await a.cerrar().then(
      () => null,
      e => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toMatch(/^INCONCLUSO — liberación fallida: \[candado: commit del candado falló\]/)
    expect(String(err.cause?.message)).toBe('commit del candado falló')
  })

  it('Codex R12-13 · `afirmar` también denuncia un montaje caído aunque la fase de aserciones termine bien (incluso si la fase se tragó su rechazo al examinarlo)', async () => {
    const a = actores(1000)
    const backfill = a.montaje('backfill', Promise.reject(new Error('backfill roto')))
    const rest = a.lanzar('REST', Promise.resolve(1))
    await new Promise(r => setTimeout(r, 10))
    // Sin `cerrar` de por medio: la fase examina a los dos —al montaje tragándose el rechazo— y no cae ninguna aserción.
    const err = await a
      .afirmar(async () => {
        expect(await backfill.resultado().catch(() => 'tragado')).toBe('tragado')
        expect(await rest.resultado()).toBe(1)
      })
      .then(
        () => null,
        e => e,
      )
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toMatch(/^INCONCLUSO — montaje fallido: \[backfill: backfill roto\]/)
  })

  it('ningún actor queda sin manejador: un rechazo capturado al lanzar no dispara `unhandledRejection` aunque nadie lo examine todavía', async () => {
    const vistos: unknown[] = []
    const escucha = (r: unknown) => vistos.push(r)
    process.on('unhandledRejection', escucha)
    try {
      const a = actores(1000)
      a.lanzar('REST', Promise.reject(new Error('503')))
      await new Promise(r => setTimeout(r, 20))
      await a.cerrar()
      expect(vistos).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', escucha)
    }
  })
})
