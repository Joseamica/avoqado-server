/**
 * `AlmacenPorVentana` (tarjeta `hz:nube0000:na526456`, 17-nov-2026): el almacén del tope de PIN que sabe a qué ventana pertenece cada
 * intento, para que devolver lo que salió bien nunca borre un fallo de otra ventana (Codex r2 #1 y r3 #1). La identidad de la
 * ventana es su REGISTRO, no su hora: cada intento recibe su ficha (`resetTime`) atada al registro donde se contó (Codex r5 #1 y #2).
 * Todo lo demás es una copia fiel del `MemoryStore` de la librería: la prueba diferencial de abajo lo compara contra el real (r7).
 */
import { MemoryStore } from 'express-rate-limit'
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
    // a los 60 s exactos el siguiente intento ya abre una ventana nueva (la librería decide al contar, no al leer)
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

  it('🔴 Codex r6 #1: un brinco del reloj durante UNA rotación no borra los fallos de una ventana vigente', () => {
    const a = almacen()
    for (let i = 0; i < 10; i++) a.increment('k') // 10 fallos
    ahora = inicio + VENTANA + 5 // el reloj se adelanta justo cuando pasa la rotación…
    a.rotarAhora()
    ahora = inicio + 10 // …y vuelve antes del vencimiento de verdad

    expect(a.get('k')?.totalHits).toBe(10)
    expect(a.increment('k').totalHits).toBe(11)
  })

  it('🔴 Codex r7 #1: una petición entre dos rotaciones conserva los fallos, como la librería', () => {
    const a = almacen()
    for (let i = 0; i < 10; i++) a.increment('k')
    ahora = inicio + VENTANA + 5
    a.rotarAhora()
    ahora = inicio + 10
    a.increment('k') // la trae de vuelta a la rotación de ahora
    ahora = inicio + VENTANA + 5
    a.rotarAhora()
    ahora = inicio + 20

    expect(a.get('k')?.totalHits).toBe(11) // antes (limpieza en dos pasos): se borraba y el siguiente contaba 1
  })

  it('🔴 Codex r7 #2: si el reloj brinca entre las dos lecturas al crear la llave, la ventana vence donde la librería', () => {
    const lecturas = [inicio, inicio + VENTANA + 5] // al crear la llave · al contar
    reloj.mockImplementation(() => lecturas.shift() ?? ahora)
    const a = almacen()

    expect(a.increment('k').resetTime!.getTime()).toBe(inicio + 2 * VENTANA + 5)
  })

  it('una llave sin uso se olvida a la segunda rotación, como la librería', () => {
    const a = almacen()
    a.increment('k')
    a.rotarAhora()
    expect(a.get('k')?.totalHits).toBe(1)
    a.rotarAhora()
    expect(a.get('k')).toBeUndefined()
  })

  it('🔴 Codex r7: frente a CUALQUIER brinco del reloj cuenta exactamente igual que el `MemoryStore` real (prueba diferencial)', async () => {
    let semilla = 20261118
    const azar = () => {
      semilla = (semilla * 1103515245 + 12345) % 2147483648
      return semilla / 2147483648
    }
    let lecturas: number[] = []
    reloj.mockImplementation(() => lecturas.shift() ?? ahora)
    const nuestro = almacen()
    const base = new MemoryStore()
    base.init({ windowMs: VENTANA } as never)
    const llaves = ['pin-login:ip:a', 'pin-login:ip:b', 'pin-login:venue:x']
    try {
      for (let paso = 0; paso < 6000; paso++) {
        const t = azar()
        const k = llaves[Math.floor(azar() * llaves.length)]
        if (t < 0.25) {
          ahora += Math.floor((azar() - 0.45) * 3 * VENTANA) // brinco hacia adelante o hacia atrás, hasta ~1.6 ventanas
        } else if (t < 0.33) {
          nuestro.rotarAhora()
          ;(base as unknown as { clearExpired(): void }).clearExpired()
        } else if (t < 0.35) {
          nuestro.resetKey(k)
          await base.resetKey(k)
        } else if (t < 0.37) {
          nuestro.decrement(k)
          await base.decrement(k)
        } else {
          // A veces el reloj brinca ENTRE las dos lecturas de un mismo incremento (Codex r7 #2).
          const segunda = azar() < 0.2 ? ahora + Math.floor((azar() - 0.3) * 2 * VENTANA) : ahora
          lecturas = [ahora, segunda]
          const n = nuestro.increment(k)
          lecturas = [ahora, segunda]
          const b = await base.increment(k)
          lecturas = []
          ahora = segunda
          expect([paso, n.totalHits, n.resetTime!.getTime()]).toEqual([paso, b.totalHits, b.resetTime!.getTime()])
        }
        for (const llave of llaves) {
          const mio = nuestro.get(llave)
          const suyo = await base.get(llave)
          expect([paso, llave, mio?.totalHits, mio?.resetTime?.getTime()]).toEqual([
            paso,
            llave,
            suyo?.totalHits,
            suyo?.resetTime?.getTime(),
          ])
        }
      }
    } finally {
      base.shutdown()
    }
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
