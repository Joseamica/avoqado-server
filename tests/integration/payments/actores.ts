/**
 * Actores «en vuelo» de una prueba de carrera: promesas lanzadas ANTES de las aserciones (el REST, el vínculo, el webhook, la
 * unidad de costo contendida) que se asientan cuando la prueba suelta sus barreras.
 *
 * Codex R8 (l) / R9 (l): un actor se captura al lanzarlo (nunca queda sin manejador), y su desenlace SIEMPRE se examina —
 * también cuando una aserción anterior ya cayó—. La regla es que ninguna evidencia se esconda:
 *  · un actor que NO se asienta en la espera acotada ⇒ la prueba termina con un error «INCONCLUSO — …» (no es una aserción:
 *    el runner certificado lo clasifica como inconcluso), conservando el fallo original en el mensaje y en `cause`;
 *  · un actor que RECHAZÓ y que la prueba ya no iba a examinar (porque una aserción anterior cayó) ⇒ lo mismo: INCONCLUSO
 *    con el fallo original conservado — un 503 aterrizado detrás de una aserción caída no puede certificar un sabotaje;
 *  · sin fallo previo, cada actor se examina con `resultado()` (que relanza su rechazo, como `await promesa`) o con una
 *    aserción sobre él (`await expect(actor.resultado()).resolves…`), y `examinados()` —la última línea de la prueba— falla
 *    si alguno se lanzó y nadie lo miró;
 *  · Codex R10 (l): la fase de ASERCIONES va dentro de `afirmar(fn)` — si una aserción cae a medias, los actores que quedaban
 *    por examinar se examinan igual: un rechazo que ya nadie iba a mirar ⇒ INCONCLUSO conservando el fallo original; si la
 *    fase termina bien, todo actor tiene que haber sido examinado (`examinados()`);
 *  · `carrera(actor, ms)` compite el actor contra un reloj y devuelve su desenlace como DATO: sólo cuenta como examinado si se
 *    asentó dentro del plazo — «participar en una carrera que ganó el reloj no acredita haber examinado el desenlace».
 * `resultado()` marca examinado cuando el desenlace se ENTREGA (tras asentarse), nunca al pedirlo; se usa siempre bajo `await` o
 * `expect(…).resolves/.rejects` — para competir contra un reloj NO se usa `resultado()` (un `Promise.race` abandonado dejaría la
 * marca puesta al asentarse), se usa `carrera`.
 *  · Codex R12-13 (l): los trabajos de MONTAJE (una transacción que sostiene un candado, la adquisición de un mutex, un backfill
 *    que hay que drenar) se registran con `montaje(nombre, promesa)` desde su lanzamiento: si rechazan o no se asientan, `cerrar`
 *    termina INCONCLUSO nombrándolos y conservando su causa (aunque ninguna aserción haya caído y aunque nadie los examine) —
 *    un fallo del montaje nunca puede desaparecer y dejar sólo una aserción financiera fallida. Las barreras se sueltan TODAS con
 *    `liberar(...)`, que captura también los errores de liberación y los suma al INCONCLUSO en vez de saltarse `cerrar`.
 * Módulo PURO (sin Prisma ni Jest): se prueba solo en `tests/unit/testing/actoresEnVuelo.test.ts`.
 */
type Asentado = { ok: true; value: unknown } | { ok: false; error: unknown }
type Entrada = {
  nombre: string
  asentada: Promise<Asentado>
  estado: Asentado | null
  examinado: boolean
  actor: Actor<unknown> | null
  /** Codex R12-13: un trabajo de MONTAJE — su rechazo es INCONCLUSO por sí mismo. */
  montaje: boolean
}

export interface Actor<T> {
  /** El desenlace, como `await promesa`: devuelve el valor o relanza el rechazo. Marca el actor como examinado. */
  resultado(): Promise<T>
}
export type Fallo = { error: unknown } | null

const mensaje = (e: unknown): string => {
  const texto =
    e instanceof Error ? e.message || `${e.name}${(e as { code?: string }).code ? ` ${(e as { code?: string }).code}` : ''}` : String(e)
  // En UNA línea, sin quedarse con la primera: los errores de Prisma EMPIEZAN con un salto de línea, y «la primera línea» era
  // una cadena vacía que escondía la causa (`montaje fallido: [transacción …: ]`). Se colapsa el espacio y se acota.
  return (texto.replace(/\s+/g, ' ').trim() || '(sin mensaje)').slice(0, 300)
}

export function actores(esperaMs = 15_000) {
  const entradas: Entrada[] = []
  const fallosDeLiberacion: { nombre: string; error: unknown }[] = []
  const espera = (ms: number) =>
    new Promise<'VENCIDA'>(r => {
      const t = setTimeout(() => r('VENCIDA'), ms)
      ;(t as { unref?: () => void }).unref?.()
    })
  /** Todo actor lanzado tiene que haber sido examinado por alguien. */
  const examinados = (): void => {
    const sin = entradas.filter(e => !e.examinado).map(e => e.nombre)
    if (sin.length > 0) throw new Error(`INCONCLUSO — actores lanzados y nunca examinados: [${sin.join(', ')}]`)
  }
  const registrar = <T>(nombre: string, promesa: Promise<T>, montaje: boolean): Actor<T> => {
    const e: Entrada = {
      nombre,
      estado: null,
      examinado: false,
      asentada: Promise.resolve({ ok: true, value: undefined }),
      actor: null,
      montaje,
    }
    e.asentada = promesa.then(
      value => (e.estado = { ok: true, value }),
      error => (e.estado = { ok: false, error }),
    )
    entradas.push(e)
    e.actor = {
      resultado: async () => {
        const r = await e.asentada
        e.examinado = true // el desenlace se ENTREGA aquí (Codex R10 (l): pedirlo no es examinarlo)
        if (r.ok) return r.value as T
        throw r.error
      },
    }
    return e.actor as Actor<T>
  }
  /** Los montajes que rechazaron (Codex R12-13): INCONCLUSO por sí mismos, se hayan examinado o no. */
  const montajesCaidos = () =>
    entradas
      .filter(e => e.montaje && e.estado !== null && !e.estado.ok)
      .map(e => `${e.nombre}: ${mensaje((e.estado as { ok: false; error: unknown }).error)}`)
  return {
    lanzar<T>(nombre: string, promesa: Promise<T>): Actor<T> {
      return registrar(nombre, promesa, false)
    },
    /**
     * Codex R12-13: un trabajo de MONTAJE (candado sostenido, mutex, backfill que se drena) registrado desde su lanzamiento. Se
     * examina con `resultado()` como cualquier actor, pero su rechazo vuelve INCONCLUSA la prueba en `cerrar`/`afirmar` aunque
     * ninguna aserción haya caído: un fallo del montaje nunca se disfraza de aserción financiera fallida.
     */
    montaje<T>(nombre: string, promesa: Promise<T>): Actor<T> {
      return registrar(nombre, promesa, true)
    },
    /**
     * Codex R12-13: suelta TODAS las barreras/liberaciones, aunque alguna rechace — cada error de liberación se captura y se suma
     * al INCONCLUSO de `cerrar` (nunca se salta `cerrar`). Devuelve cuántas fallaron.
     */
    async liberar(liberaciones: Record<string, () => unknown | Promise<unknown>>): Promise<number> {
      let fallidas = 0
      for (const [nombre, soltar] of Object.entries(liberaciones)) {
        try {
          await soltar()
        } catch (error) {
          fallidas++
          fallosDeLiberacion.push({ nombre, error })
        }
      }
      return fallidas
    },
    /**
     * Compite al actor contra un reloj y devuelve su desenlace como DATO: `{ estado: 'BLOQUEADA' }` si el reloj gana (el actor
     * sigue sin examinar), `{ estado: 'ASENTADA', ok, value | error }` si se asentó (y entonces queda examinado).
     */
    async carrera<T>(
      actor: Actor<T>,
      ms: number,
    ): Promise<{ estado: 'BLOQUEADA' } | { estado: 'ASENTADA'; ok: true; value: T } | { estado: 'ASENTADA'; ok: false; error: unknown }> {
      const e = entradas.find(x => x.actor === actor)
      if (!e) throw new Error('carrera: el actor no fue lanzado por este conjunto')
      const ganador = await Promise.race([e.asentada.then(() => 'ASENTADA' as const), espera(ms)])
      if (ganador === 'VENCIDA') return { estado: 'BLOQUEADA' }
      e.examinado = true
      const r = e.estado as Asentado
      return r.ok ? { estado: 'ASENTADA', ok: true, value: r.value as T } : { estado: 'ASENTADA', ok: false, error: r.error }
    },
    /**
     * Se llama DESPUÉS de soltar las barreras (si no, un actor bloqueado no se asentaría nunca), con el fallo capturado
     * por la prueba si lo hubo. Espera acotada a TODOS los actores y decide: INCONCLUSO (actores sin asentar, o rechazados
     * que ya nadie va a examinar porque hubo un fallo previo) · relanza el fallo previo · o deja seguir a la prueba, que
     * entonces examina cada actor.
     */
    async cerrar(fallo: Fallo = null): Promise<void> {
      await Promise.race([Promise.all(entradas.map(e => e.asentada)), espera(esperaMs)])
      const sinAsentar = entradas.filter(e => e.estado === null).map(e => e.nombre)
      const rechazados = entradas
        .filter(e => !e.montaje && e.estado !== null && !e.estado.ok && !e.examinado)
        .map(e => `${e.nombre}: ${mensaje((e.estado as { ok: false; error: unknown }).error)}`)
      const montajes = montajesCaidos()
      const liberaciones = fallosDeLiberacion.map(l => `${l.nombre}: ${mensaje(l.error)}`)
      if (sinAsentar.length > 0 || montajes.length > 0 || liberaciones.length > 0 || (fallo && rechazados.length > 0)) {
        const partes = [
          sinAsentar.length > 0 ? `actores sin asentar tras ${esperaMs} ms: [${sinAsentar.join(', ')}]` : '',
          montajes.length > 0 ? `montaje fallido: [${montajes.join(' | ')}]` : '',
          liberaciones.length > 0 ? `liberación fallida: [${liberaciones.join(' | ')}]` : '',
          fallo && rechazados.length > 0 ? `rechazos que la prueba ya no examinó: [${rechazados.join(' | ')}]` : '',
          fallo ? `fallo original: ${mensaje(fallo.error)}` : '',
        ].filter(Boolean)
        const causa =
          fallo?.error ??
          (entradas.find(e => e.montaje && e.estado !== null && !e.estado.ok)?.estado as { ok: false; error: unknown } | undefined)
            ?.error ??
          fallosDeLiberacion[0]?.error
        throw Object.assign(new Error(`INCONCLUSO — ${partes.join(' · ')}`), { cause: causa })
      }
      if (fallo) throw fallo.error
    },
    /**
     * La fase de aserciones de la prueba (Codex R10 (l)). Si una aserción cae, los actores que quedaban por examinar se examinan
     * igual: cualquier rechazo entre ellos ⇒ INCONCLUSO conservando el fallo original (mensaje y `cause`); si no hay rechazos, se
     * relanza el fallo tal cual (la caída sigue siendo por aserción). Si la fase termina bien, exige que todo actor haya sido
     * examinado. Los actores tienen que estar ASENTADOS antes (`cerrar`), así que aquí no se espera a nadie.
     */
    async afirmar(fase: () => Promise<void>): Promise<void> {
      try {
        await fase()
      } catch (error) {
        const rechazados = entradas
          .filter(e => e.estado !== null && !e.estado.ok && !e.examinado)
          .map(e => `${e.nombre}: ${mensaje((e.estado as { ok: false; error: unknown }).error)}`)
        const sinAsentar = entradas.filter(e => e.estado === null).map(e => e.nombre)
        const montajes = montajesCaidos()
        if (rechazados.length > 0 || sinAsentar.length > 0 || montajes.length > 0) {
          const partes = [
            rechazados.length > 0 ? `rechazos que la fase de aserciones ya no examinó: [${rechazados.join(' | ')}]` : '',
            montajes.length > 0 ? `montaje fallido: [${montajes.join(' | ')}]` : '',
            sinAsentar.length > 0 ? `actores sin asentar: [${sinAsentar.join(', ')}]` : '',
            `fallo original: ${mensaje(error)}`,
          ].filter(Boolean)
          throw Object.assign(new Error(`INCONCLUSO — ${partes.join(' · ')}`), { cause: error })
        }
        throw error
      }
      const montajes = montajesCaidos()
      if (montajes.length > 0) throw new Error(`INCONCLUSO — montaje fallido: [${montajes.join(' | ')}]`)
      examinados()
    },
    /** La última línea de la prueba (si no se usa `afirmar`): todo actor lanzado tiene que haber sido examinado por alguien. */
    examinados,
  }
}
