/**
 * `AlmacenPorVentana` (tarjeta `hz:nube0000:na526456`, 17-nov-2026): el almacén del tope de PIN que sabe a qué ventana pertenece cada
 * intento, para que devolver lo que salió bien nunca borre un fallo de otra ventana (Codex r2 #1 y r3 #1).
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
    expect(vieja.resetTime!.getTime()).toBe(inicio + VENTANA) // la copia de A no cambió con el reinicio
    expect(nueva.resetTime!.getTime()).toBe(inicio + 2 * VENTANA)

    a.devolverEnVentana('k', vieja.resetTime!.getTime()) // A termina bien

    expect(a.get('k')?.totalHits).toBe(1) // el fallo de B sigue contado
  })

  it('una petición que sale bien en su misma ventana se devuelve', () => {
    const a = almacen()
    const r = a.increment('k')
    a.increment('k')

    a.devolverEnVentana('k', r.resetTime!.getTime())

    expect(a.get('k')?.totalHits).toBe(1)
  })

  it('con la ventana ya vencida (sin reinicio todavía) no resta nada', () => {
    const a = almacen()
    const r = a.increment('k')
    ahora = inicio + VENTANA + 5

    a.devolverEnVentana('k', r.resetTime!.getTime())

    expect(a.get('k')).toBeUndefined()
    expect(a.increment('k').totalHits).toBe(1)
  })

  it('la ventana que devuelve es una COPIA: cambiarla no toca el almacén', () => {
    const a = almacen()
    const r = a.increment('k')
    r.resetTime!.setTime(0)

    expect(a.get('k')?.resetTime?.getTime()).toBe(inicio + VENTANA)
  })

  it('nunca baja de cero ni resta en una llave que no existe, y no lanza', () => {
    const a = almacen()
    expect(() => a.devolverEnVentana('nadie', inicio + VENTANA)).not.toThrow()
    const r = a.increment('k')
    a.devolverEnVentana('k', r.resetTime!.getTime())
    a.devolverEnVentana('k', r.resetTime!.getTime())

    expect(a.get('k')?.totalHits).toBe(0)
  })

  it('Codex r4 #4: tras borrar la llave en el mismo milisegundo, la ventana nueva tiene OTRO número y la devolución vieja no la toca', () => {
    const a = almacen()
    const vieja = a.increment('k')
    a.resetKey('k')
    a.increment('k') // mismo milisegundo
    a.devolverEnVentana('k', vieja.resetTime!.getTime())

    expect(a.get('k')?.totalHits).toBe(1)
  })

  it('si el reloj del servidor brinca para atrás, la ventana nueva sigue sin repetir número', () => {
    const a = almacen()
    const primera = a.increment('k')
    ahora = inicio + VENTANA + 1 // vence la primera
    a.increment('otra') // cualquier llave
    ahora = inicio // el reloj vuelve atrás
    a.resetAll()
    const segunda = a.increment('k')

    expect(segunda.resetTime!.getTime()).not.toBe(primera.resetTime!.getTime())
    a.devolverEnVentana('k', primera.resetTime!.getTime())
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
