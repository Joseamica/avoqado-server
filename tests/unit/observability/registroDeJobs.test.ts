/**
 * Qué job estaba corriendo cuando el hilo se retuvo.
 *
 * El guardia ya dice si fue el recolector o CPU, pero no QUIÉN gastó esa CPU. `topInFlight`
 * sólo ve peticiones HTTP, y el sospechoso natural de una retención de medio segundo que no
 * corresponde a ninguna ruta es un cron: ~78 registros de scheduler en este repo, varios de
 * ellos barridos que leen lotes de la base.
 *
 * 🔴 Dos cosas que Codex exigió y que esta prueba fija:
 *
 * 1. **Un job que empieza y TERMINA dentro del tramo bloqueado tiene que verse igual.** Si sólo
 *    se mirara la lista de activos en el momento de muestrear, el job que causó la retención y
 *    acabó justo antes del tick sería invisible — precisamente el caso más probable, porque el
 *    tick no puede correr mientras el job tiene el hilo.
 * 2. **La cobertura es PARCIAL y el aviso lo dice.** Medido el 22-sep: 5 registros no pasan por
 *    el envoltorio de contexto (`server.ts` ×2, los dos de catálogo, `reviewSync`) y varios
 *    descartan su promesa con `=> void`, así que su tick «termina» al instante aunque siga
 *    trabajando. Un aviso que callara eso invitaría a leer «ningún job» como «no fue un job».
 */
import { crearRegistroDeJobs } from '@/observability/registroDeJobs'

describe('registro de jobs en vuelo (puro, con reloj inyectado)', () => {
  const banco = () => {
    let t = 1000
    const r = crearRegistroDeJobs({ ahoraMs: () => t, maxHistorial: 5 })
    return { r, avanzar: (ms: number) => (t += ms), ahora: () => t }
  }

  it('un job ACTIVO aparece en la ventana que lo cruza', () => {
    const { r, avanzar } = banco()
    r.iniciar('cash-drawer-reconciler')
    avanzar(500)

    const v = r.jobsEnVentana(1000, 1500)
    expect(v).toEqual([{ nombre: 'cash-drawer-reconciler', ms: 500, vivo: true }])
  })

  it('🔴 un job que YA TERMINÓ dentro de la ventana sigue apareciendo', () => {
    const { r, avanzar } = banco()
    const id = r.iniciar('paid-order-reconciler')
    avanzar(400)
    r.terminar(id)
    avanzar(100) // el tick del guardia llega DESPUÉS de que el job acabó

    const v = r.jobsEnVentana(1000, 1500)
    expect(v).toEqual([{ nombre: 'paid-order-reconciler', ms: 400, vivo: false }])
  })

  it('ignora los jobs de OTRAS ventanas', () => {
    const { r, avanzar } = banco()
    const viejo = r.iniciar('viejo')
    avanzar(100)
    r.terminar(viejo) // [1000, 1100]
    avanzar(900) // la ventana empieza en 2000

    const id = r.iniciar('actual')
    avanzar(200)
    r.terminar(id)

    expect(r.jobsEnVentana(2000, 2200).map(j => j.nombre)).toEqual(['actual'])
  })

  it('cuenta sólo la parte del job que cae DENTRO de la ventana', () => {
    const { r, avanzar } = banco()
    r.iniciar('barrido-largo') // empieza en 1000 y sigue vivo
    avanzar(5000)

    // La ventana es [4000, 4500]: el job lleva rato, pero sólo 500 ms son de este tramo.
    expect(r.jobsEnVentana(4000, 4500)).toEqual([{ nombre: 'barrido-largo', ms: 500, vivo: true }])
  })

  it('ordena por tiempo dentro de la ventana, el más pesado primero', () => {
    const { r, avanzar } = banco()
    const corto = r.iniciar('corto')
    const largo = r.iniciar('largo')
    avanzar(100)
    r.terminar(corto)
    avanzar(300)
    r.terminar(largo)

    expect(r.jobsEnVentana(1000, 1400).map(j => j.nombre)).toEqual(['largo', 'corto'])
  })

  it('el historial está acotado: un pico de jobs no se vuelve una fuga', () => {
    const { r, avanzar } = banco()
    for (let i = 0; i < 20; i += 1) {
      const id = r.iniciar(`job-${i}`)
      avanzar(1)
      r.terminar(id)
    }
    expect(r.jobsEnVentana(1000, 1100).length).toBeLessThanOrEqual(5)
  })

  it('terminar dos veces el mismo job no lo duplica ni lo revive', () => {
    const { r, avanzar } = banco()
    const id = r.iniciar('doble-cierre')
    avanzar(50)
    r.terminar(id)
    avanzar(50)
    r.terminar(id) // un `finally` que corre dos veces no puede mover el reloj del job

    const v = r.jobsEnVentana(1000, 1200)
    expect(v).toEqual([{ nombre: 'doble-cierre', ms: 50, vivo: false }])
  })

  it('dos ticks del MISMO job a la vez se cuentan por separado', () => {
    // Pasa de verdad: `cron@4.3.3` no espera la promesa del tick anterior (waitForCompletion
    // es false por default), así que un barrido lento se solapa consigo mismo.
    const { r, avanzar } = banco()
    r.iniciar('lento')
    avanzar(100)
    r.iniciar('lento')
    avanzar(100)

    const v = r.jobsEnVentana(1000, 1200)
    expect(v).toHaveLength(2)
    expect(v.map(j => j.ms)).toEqual([200, 100])
  })
})

/**
 * 🔴 Codex, auditoría del 22-sep: el tope de 200 sólo acotaba el HISTORIAL.
 *
 * Los activos crecían sin límite: un tick que nunca resuelve se queda dentro para siempre y
 * aparece en todas las ventanas posteriores. Codex lo reprodujo reteniendo **10,000 activos**.
 * Y la consulta copia y ordena todos antes de que el guardia se quede con cinco.
 *
 * Expulsar un registro de observabilidad es perder el rastro, no terminar el trabajo: el job
 * sigue corriendo allá afuera. Por eso se cuenta aparte y NUNCA se publica como terminado.
 */
describe('los ticks ACTIVOS también están acotados', () => {
  const banco = (maxActivos: number) => {
    let t = 1000
    const r = crearRegistroDeJobs({ ahoraMs: () => t, maxHistorial: 5, maxActivos })
    return { r, avanzar: (ms: number) => (t += ms) }
  }

  it('al pasar del tope expulsa el MÁS VIEJO y lo cuenta como rastro perdido', () => {
    const { r, avanzar } = banco(3)
    for (let i = 0; i < 5; i += 1) {
      r.iniciar(`colgado-${i}`)
      avanzar(10)
    }

    const vivos = r.jobsEnVentana(1000, 1100).filter(j => j.vivo)
    expect(vivos).toHaveLength(3)
    expect(vivos.map(j => j.nombre)).not.toContain('colgado-0') // el más viejo se fue
    expect(r.descartesDeHistorial() + r.expulsionesDeActivos()).toBe(2)
  })

  it('un tick expulsado NO se publica como terminado (seguía corriendo)', () => {
    const { r, avanzar } = banco(1)
    r.iniciar('sigue-vivo-alla-afuera')
    avanzar(10)
    r.iniciar('el-nuevo')
    avanzar(10)

    const v = r.jobsEnVentana(1000, 1100)
    expect(v.map(j => j.nombre)).toEqual(['el-nuevo'])
    expect(v.some(j => j.nombre === 'sigue-vivo-alla-afuera')).toBe(false)
    expect(r.descartesDeHistorial() + r.expulsionesDeActivos()).toBe(1)
  })

  it('terminar un tick ya expulsado no revive nada ni descuadra el conteo', () => {
    const { r, avanzar } = banco(1)
    const expulsado = r.iniciar('expulsado')
    avanzar(10)
    r.iniciar('nuevo')
    avanzar(10)

    expect(() => r.terminar(expulsado)).not.toThrow()
    expect(r.jobsEnVentana(1000, 1100).map(j => j.nombre)).toEqual(['nuevo'])
  })

  it('cuenta los descartes del HISTORIAL, que son evidencia perdida de una ventana', () => {
    const { r, avanzar } = banco(10)
    for (let i = 0; i < 8; i += 1) {
      const id = r.iniciar(`t-${i}`)
      avanzar(1)
      r.terminar(id)
    }
    // El historial guarda 5: tres ticks terminados se perdieron.
    expect(r.descartesDeHistorial() + r.expulsionesDeActivos()).toBe(3)
  })
})

/**
 * 🔴 Codex, 2ª pasada: un solo contador mezclaba dos pérdidas distintas.
 *
 * Recortar el HISTORIAL pierde evidencia de un tramo concreto y se agota (deja de crecer si no
 * pasa nada). Expulsar un ACTIVO es otra cosa: seguimos ciegos respecto de ese trabajo MIENTRAS
 * siga corriendo, y un aviso posterior con «0 perdidos» diría que se ve todo cuando no es cierto.
 * Codex lo reprodujo: expulsión, un tramo normal, y luego el tramo lento salía con todo en cero.
 */
describe('las dos pérdidas se cuentan por separado', () => {
  const banco = (maxActivos: number, maxHistorial: number) => {
    let t = 1000
    const r = crearRegistroDeJobs({ ahoraMs: () => t, maxHistorial, maxActivos })
    return { r, avanzar: (ms: number) => (t += ms) }
  }

  it('recortar el historial NO cuenta como expulsión de activos', () => {
    const { r, avanzar } = banco(10, 2)
    for (let i = 0; i < 5; i += 1) {
      const id = r.iniciar(`t-${i}`)
      avanzar(1)
      r.terminar(id)
    }
    expect(r.descartesDeHistorial()).toBe(3)
    expect(r.expulsionesDeActivos()).toBe(0)
  })

  it('expulsar un activo NO cuenta como descarte de historial', () => {
    const { r, avanzar } = banco(2, 50)
    for (let i = 0; i < 5; i += 1) {
      r.iniciar(`colgado-${i}`)
      avanzar(1)
    }
    expect(r.expulsionesDeActivos()).toBe(3)
    expect(r.descartesDeHistorial()).toBe(0)
  })

  it('la expulsión es ACUMULADA: no se olvida cuando pasa el rato', () => {
    const { r, avanzar } = banco(1, 50)
    r.iniciar('primero')
    avanzar(10)
    r.iniciar('segundo') // expulsa a 'primero'
    avanzar(5000) // pasa mucho tiempo y muchos tramos

    // Seguimos ciegos respecto de 'primero' mientras siga corriendo: el contador lo recuerda.
    expect(r.expulsionesDeActivos()).toBe(1)
  })
})
