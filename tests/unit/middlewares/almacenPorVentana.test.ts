/**
 * `AlmacenPorVentana` (tarjeta `hz:nube0000:na526456`, 17-nov-2026): el almacén del tope de PIN que sabe a qué ventana pertenece cada
 * intento, para que devolver lo que salió bien nunca borre un fallo de otra ventana (Codex r2 #1 y r3 #1). La identidad de la
 * ventana es su REGISTRO, no su hora: cada intento recibe su ficha (`resetTime`) atada al registro donde se contó (Codex r5 #1 y #2).
 */
import { AlmacenPorVentana } from '../../../src/middlewares/almacenPorVentana'

const VENTANA = 60_000

function almacen() {
  const a = new AlmacenPorVentana()
  a.init({ windowMs: VENTANA } as never)
  return a
}

describe('AlmacenPorVentana', () => {
  const inicio = 1_800_000_000_000
  let ahora = inicio
  let reloj: jest.SpyInstance
  beforeEach(() => {
    ahora = inicio
    reloj = jest.spyOn(Date, 'now').mockImplementation(() => ahora)
  })
  afterEach(() => reloj.mockRestore())

  // NEW FEATURE TESTS
  it('🔴 Codex r3 #1: dos peticiones al vencer el plazo — la de la ventana vieja, al salir bien, NO resta en la nueva', () => {
    const a = almacen()
    a.increment('k') // abre la ventana [inicio, inicio + 60 s)
    ahora = inicio + VENTANA - 1
    const vieja = a.increment('k') // A: último milisegundo de la ventana vieja
    ahora = inicio + VENTANA
    const nueva = a.increment('k') // B: reinicia (fallo de la ventana nueva)
    expect(vieja.resetTime!.getTime()).toBe(inicio + VENTANA) // la ficha de A no cambió con el reinicio
    expect(nueva.resetTime!.getTime()).toBe(inicio + 2 * VENTANA)

    a.devolverEnVentana('k', vieja.resetTime) // A termina bien

    expect(a.get('k')?.totalHits).toBe(1) // el fallo de B sigue contado
  })

  it('una petición que sale bien en su misma ventana se devuelve', () => {
    const a = almacen()
    const r = a.increment('k')
    a.increment('k')

    a.devolverEnVentana('k', r.resetTime)

    expect(a.get('k')?.totalHits).toBe(1)
  })

  it('🔴 Codex r5 #1: dos llaves que abren ventana en el mismo milisegundo vencen las dos a los 60 s exactos, como la librería', () => {
    const a = almacen()
    const ip = a.increment('ip')
    const negocio = a.increment('negocio')

    expect(ip.resetTime!.getTime()).toBe(inicio + VENTANA)
    expect(negocio.resetTime!.getTime()).toBe(inicio + VENTANA) // antes: + 1 ms, heredado de la otra llave
    ahora = inicio + VENTANA
    expect(a.get('negocio')).toBeUndefined() // a los 60 s exactos ya no bloquea
    expect(a.increment('negocio').totalHits).toBe(1)
  })

  it('🔴 Codex r5 #1: si el reloj brinca para atrás, una llave nueva vence a sus propios 60 s, sin heredar el salto', () => {
    const a = almacen()
    ahora = inicio + 3_600_000 // el reloj adelantado una hora
    a.increment('otra')
    ahora = inicio // vuelve a la hora buena

    expect(a.increment('k').resetTime!.getTime()).toBe(inicio + VENTANA)
  })

  it('🔴 Codex r5 #2: un acierto que termina con el reloj adelantado se devuelve igual; si el reloj vuelve, la ventana sólo tiene sus fallos', () => {
    const a = almacen()
    for (let i = 0; i < 9; i++) a.increment('k') // 9 fallos
    const acierto = a.increment('k') // una checada correcta, en vuelo
    expect(a.get('k')?.totalHits).toBe(10)

    ahora = inicio + VENTANA + 5 // el reloj brinca más allá del vencimiento justo cuando termina la checada
    a.devolverEnVentana('k', acierto.resetTime)
    ahora = inicio + 10 // y vuelve atrás antes de que nadie reemplace o barra el registro

    expect(a.get('k')?.totalHits).toBe(9) // antes: 10 ⇒ el siguiente empleado recibía 429 con 9 fallos
  })

  it('con la ventana ya vencida y reemplazada, devolver no toca la ventana nueva', () => {
    const a = almacen()
    const r = a.increment('k')
    ahora = inicio + VENTANA + 5
    a.increment('k') // ventana nueva, con su fallo

    a.devolverEnVentana('k', r.resetTime)

    expect(a.get('k')?.totalHits).toBe(1)
  })

  it('la ficha es un `Date` propio: cambiarlo no toca el almacén, y sigue devolviendo en su ventana', () => {
    const a = almacen()
    const r = a.increment('k')
    a.increment('k')
    r.resetTime!.setTime(0)

    expect(a.get('k')?.resetTime?.getTime()).toBe(inicio + VENTANA)
    a.devolverEnVentana('k', r.resetTime)
    expect(a.get('k')?.totalHits).toBe(1)
  })

  it('no resta con una ficha ajena, sin ficha ni en una llave que no existe, y no lanza', () => {
    const a = almacen()
    expect(() => a.devolverEnVentana('nadie', new Date(inicio + VENTANA))).not.toThrow()
    expect(() => a.devolverEnVentana('nadie', undefined)).not.toThrow()
    a.increment('k')
    a.increment('k')
    a.devolverEnVentana('k', new Date(inicio + VENTANA)) // misma hora, pero no es su ficha
    a.devolverEnVentana('k', undefined)
    expect(a.get('k')?.totalHits).toBe(2)
  })

  it('Codex r6 #3: cada ficha devuelve UNA sola vez, aunque la llamen de nuevo', () => {
    const a = almacen()
    const r = a.increment('k')
    a.increment('k')

    a.devolverEnVentana('k', r.resetTime)
    a.devolverEnVentana('k', r.resetTime)
    a.devolverEnVentana('k', r.resetTime)

    expect(a.get('k')?.totalHits).toBe(1)
  })

  it('🔴 Codex r6 #1: un brinco del reloj durante UNA limpieza no borra los fallos de una ventana vigente', () => {
    const a = almacen()
    for (let i = 0; i < 10; i++) a.increment('k') // 10 fallos
    ahora = inicio + VENTANA + 5 // el reloj se adelanta justo cuando pasa la limpieza…
    a.limpiarAhora()
    ahora = inicio + 10 // …y vuelve antes del vencimiento de verdad

    expect(a.get('k')?.totalHits).toBe(10) // antes: el registro se borraba y el siguiente intento contaba 1
    expect(a.increment('k').totalHits).toBe(11)
    a.limpiarAhora() // la siguiente limpieza la ve vigente y la conserva
    expect(a.get('k')?.totalHits).toBe(11)
  })

  it('la limpieza sí quita lo vencido de verdad: a la segunda vez que lo ve vencido', () => {
    const a = almacen()
    a.increment('k')
    const tamano = () => (a as unknown as { registros: Map<string, unknown> }).registros.size
    ahora = inicio + VENTANA + 1
    a.limpiarAhora()
    expect(tamano()).toBe(1) // primera vez: sólo lo marca
    ahora = inicio + 2 * VENTANA + 1
    a.limpiarAhora()
    expect(tamano()).toBe(0)
  })

  it('una ficha de una llave no resta en otra llave', () => {
    const a = almacen()
    const deIp = a.increment('ip')
    a.increment('negocio')

    a.devolverEnVentana('negocio', deIp.resetTime)

    expect(a.get('negocio')?.totalHits).toBe(1)
  })

  it('Codex r4 #4: tras borrar la llave y reabrirla en el mismo milisegundo (misma hora), la ficha vieja no toca la ventana nueva', () => {
    const a = almacen()
    const vieja = a.increment('k')
    a.resetKey('k')
    const nueva = a.increment('k') // mismo milisegundo: misma hora de vencimiento
    expect(nueva.resetTime!.getTime()).toBe(vieja.resetTime!.getTime())

    a.devolverEnVentana('k', vieja.resetTime)

    expect(a.get('k')?.totalHits).toBe(1)
  })

  it('Codex r4 #4: lo mismo tras `resetAll` con el reloj de vuelta atrás', () => {
    const a = almacen()
    const primera = a.increment('k')
    ahora = inicio + VENTANA + 1
    a.increment('otra')
    ahora = inicio // el reloj vuelve atrás
    a.resetAll()
    a.increment('k')

    a.devolverEnVentana('k', primera.resetTime)

    expect(a.get('k')?.totalHits).toBe(1)
  })

  // REGRESSION TESTS — lo que express-rate-limit espera de un almacén
  it('cuenta por llave y reinicia al vencer', () => {
    const a = almacen()
    expect(a.increment('a').totalHits).toBe(1)
    expect(a.increment('a').totalHits).toBe(2)
    expect(a.increment('b').totalHits).toBe(1)
    ahora = inicio + VENTANA
    expect(a.increment('a').totalHits).toBe(1)
  })

  it('decrement y resetKey', () => {
    const a = almacen()
    a.increment('a')
    a.increment('a')
    a.decrement('a')
    expect(a.get('a')?.totalHits).toBe(1)
    a.resetKey('a')
    expect(a.get('a')).toBeUndefined()
  })
})
