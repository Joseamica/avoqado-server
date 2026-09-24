/**
 * Codex pasada final (P1-2): las marcas en memoria del aviso firmado que el servidor no pudo guardar.
 */
import {
  ESPERAS_DE_REINGRESO_MS,
  TOPE_DE_COMERCIOS,
  TOPE_DE_INTENTOS,
  TOPE_DE_REINGRESOS_SIN_VERIFICAR,
  TOPE_DE_REINGRESOS_VERIFICADOS,
  VENTANA_SIN_CANAL_MS,
  _olvidarTodoParaPruebas,
  _reingresarYaParaPruebas,
  canalDelComercioFalloHacePoco,
  hayDineroNoGuardado,
  puertaDelDinero,
  registrarAvisoNoGuardado,
  reingresarMasTarde,
} from '@/services/tpv/avisosNoGuardados'

afterEach(() => _olvidarTodoParaPruebas())

describe('avisosNoGuardados', () => {
  it('el canal del comercio queda sin comprobar durante la ventana, contada desde la ÚLTIMA falla', () => {
    const t = 1_000_000
    registrarAvisoNoGuardado({ merchantAccountId: 'm1', attemptId: null, posibleDinero: false }, t)
    expect(canalDelComercioFalloHacePoco('m1', t + VENTANA_SIN_CANAL_MS - 1)).toBe(true)
    expect(canalDelComercioFalloHacePoco('m1', t + VENTANA_SIN_CANAL_MS)).toBe(false)
    registrarAvisoNoGuardado({ merchantAccountId: 'm1', attemptId: null, posibleDinero: false }, t + 10_000)
    expect(canalDelComercioFalloHacePoco('m1', t + VENTANA_SIN_CANAL_MS)).toBe(true)
    expect(canalDelComercioFalloHacePoco('m2', t)).toBe(false)
  })

  it('una falla registrada con un reloj más viejo nunca acorta la ventana vigente', () => {
    const t = 5_000_000
    registrarAvisoNoGuardado({ merchantAccountId: 'm1', attemptId: null, posibleDinero: false }, t)
    registrarAvisoNoGuardado({ merchantAccountId: 'm1', attemptId: null, posibleDinero: false }, t - VENTANA_SIN_CANAL_MS)
    expect(canalDelComercioFalloHacePoco('m1', t + 1)).toBe(true)
  })

  it('el dinero se marca sólo con llave y posible dinero, y NO caduca con la ventana', () => {
    registrarAvisoNoGuardado({ merchantAccountId: 'm1', attemptId: 'a1', posibleDinero: true }, 0)
    registrarAvisoNoGuardado({ merchantAccountId: 'm1', attemptId: 'a2', posibleDinero: false }, 0)
    registrarAvisoNoGuardado({ merchantAccountId: 'm1', attemptId: null, posibleDinero: true }, 0)
    expect(hayDineroNoGuardado('a1')).toBe(true)
    expect(hayDineroNoGuardado('a2')).toBe(false)
    expect(canalDelComercioFalloHacePoco('m1', 10 * VENTANA_SIN_CANAL_MS)).toBe(false) // el canal sí caduca…
    expect(hayDineroNoGuardado('a1')).toBe(true) // …el dinero no
  })

  it('con el tope lleno se olvida la llave MÁS VIEJA, nunca la nueva', () => {
    for (let i = 0; i < TOPE_DE_INTENTOS; i++) registrarAvisoNoGuardado({ merchantAccountId: 'm', attemptId: `k${i}`, posibleDinero: true })
    registrarAvisoNoGuardado({ merchantAccountId: 'm', attemptId: 'nueva', posibleDinero: true })
    expect(hayDineroNoGuardado('nueva')).toBe(true)
    expect(hayDineroNoGuardado('k0')).toBe(false)
    expect(hayDineroNoGuardado('k1')).toBe(true)
  })

  it('el canal también tiene tope (en la búsqueda caída el id viene de la URL): se olvida la falla MÁS VIEJA, nunca la nueva', () => {
    const t = 10_000_000
    for (let i = 0; i < TOPE_DE_COMERCIOS; i++) {
      registrarAvisoNoGuardado({ merchantAccountId: `m${i}`, attemptId: null, posibleDinero: false }, t + i)
    }
    // m0 vuelve a fallar: ya no es la falla más vieja — la más vieja pasa a ser m1.
    registrarAvisoNoGuardado({ merchantAccountId: 'm0', attemptId: null, posibleDinero: false }, t + TOPE_DE_COMERCIOS)
    registrarAvisoNoGuardado({ merchantAccountId: 'nuevo', attemptId: null, posibleDinero: false }, t + TOPE_DE_COMERCIOS + 1)
    const ahora = t + TOPE_DE_COMERCIOS + 2
    expect(canalDelComercioFalloHacePoco('nuevo', ahora)).toBe(true)
    expect(canalDelComercioFalloHacePoco('m0', ahora)).toBe(true)
    expect(canalDelComercioFalloHacePoco('m1', ahora)).toBe(false)
    expect(canalDelComercioFalloHacePoco('m2', ahora)).toBe(true)
  })

  /**
   * 🔴 El reingreso: si AngelPay no reintentara el 503, la marca de dinero dejaría la terminal apartada para siempre (la
   * terminal guarda durable el «hay evidencia» y nadie registraría ese cobro). El servidor vuelve a intentar él mismo.
   */
  describe('reingreso propio', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => {
      _olvidarTodoParaPruebas()
      jest.useRealTimers()
    })

    it('reintenta con esperas crecientes hasta que queda guardado, y ahí se detiene', async () => {
      const resultados = [false, false, true]
      const reintentar = jest.fn(async () => resultados.shift() ?? true)
      reingresarMasTarde('m:e1', reintentar, true)
      expect(reintentar).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[0])
      expect(reintentar).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[1])
      expect(reintentar).toHaveBeenCalledTimes(2)
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[2])
      expect(reintentar).toHaveBeenCalledTimes(3)
      await jest.advanceTimersByTimeAsync(10 * ESPERAS_DE_REINGRESO_MS[2])
      expect(reintentar).toHaveBeenCalledTimes(3)
    })

    it('un reintento que LANZA cuenta como no guardado: se vuelve a programar', async () => {
      const reintentar = jest.fn().mockRejectedValueOnce(new Error('la base sigue caída')).mockResolvedValue(true)
      reingresarMasTarde('m:e2', reintentar, true)
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[0])
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[1])
      expect(reintentar).toHaveBeenCalledTimes(2)
    })

    it('la misma clave programada dos veces deja UN solo reingreso (también mientras la base sigue caída)', async () => {
      // Con un reintento que SIGUE fallando: un reintento que sale bien a la primera borra la clave y esconde un temporizador
      // duplicado (su vuelta ya no la encuentra) — la prueba pasaba sin la deduplicación.
      const reintentar = jest.fn(async () => false)
      reingresarMasTarde('m:e3', reintentar, true)
      reingresarMasTarde('m:e3', reintentar, true)
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[0])
      expect(reintentar).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[1])
      expect(reintentar).toHaveBeenCalledTimes(2)
    })

    it('los reingresos SIN verificar tienen tope: se abandona el MÁS VIEJO de ellos, nunca el nuevo', async () => {
      const llamados: string[] = []
      for (let i = 0; i <= TOPE_DE_REINGRESOS_SIN_VERIFICAR; i++) {
        reingresarMasTarde(
          `k${i}`,
          async () => {
            llamados.push(`k${i}`)
            return true
          },
          false,
        )
      }
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[0])
      expect(llamados).toHaveLength(TOPE_DE_REINGRESOS_SIN_VERIFICAR)
      expect(llamados).not.toContain('k0')
      expect(llamados).toContain(`k${TOPE_DE_REINGRESOS_SIN_VERIFICAR}`)
    })

    it('🔴 final-2 · los sin verificar NUNCA expulsan a uno verificado: su tope es aparte', async () => {
      // Codex: un aviso auténtico con ingreso fallido y luego 1 000 cuerpos con firma falsa durante la caída ⇒ el auténtico se
      // abandonaba y su veto quedaba vivo: terminal retenida sin recuperación aunque la base ya había vuelto.
      const autentico = jest.fn(async () => true)
      reingresarMasTarde('m:autentico', autentico, true)
      for (let i = 0; i < TOPE_DE_REINGRESOS_SIN_VERIFICAR + 5; i++) reingresarMasTarde(`m:basura${i}`, async () => true, false)
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[0])
      expect(autentico).toHaveBeenCalledTimes(1)
    })

    it('🔴 final-2 · un pendiente sin verificar que resulta auténtico pasa a verificado, y ya no lo expulsan los sin verificar', async () => {
      const reintentar = jest.fn(async () => false)
      reingresarMasTarde('m:x', reintentar, false)
      reingresarMasTarde('m:x', reintentar, true) // al reintentar se verificó la firma y volvió a fallar el ingreso
      for (let i = 0; i < TOPE_DE_REINGRESOS_SIN_VERIFICAR + 5; i++) reingresarMasTarde(`m:b${i}`, async () => true, false)
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[0])
      expect(reintentar).toHaveBeenCalledTimes(1)
    })

    it('🔴 final-3 · el auténtico con la MISMA clave que una entrada sin verificar REEMPLAZA su reintento (no hereda el del falso)', async () => {
      // Codex final-3: la promoción conservaba el callback de la entrada sin verificar. Si era un cuerpo con firma falsa, al
      // reintentar recibía 401, contaba como «terminado» y se borraba: el auténtico nunca se reingresaba y su veto quedaba vivo.
      const falso = jest.fn(async () => true)
      const autentico = jest.fn(async () => true)
      reingresarMasTarde('m:e', falso, false)
      reingresarMasTarde('m:e', autentico, true)
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[0])
      expect(autentico).toHaveBeenCalledTimes(1)
      expect(falso).not.toHaveBeenCalled()
    })

    it('🔴 final-3 · una corrida del falso que termina DESPUÉS de la promoción no se lleva al auténtico', async () => {
      let soltarFalso!: (v: boolean) => void
      const falso = jest.fn(() => new Promise<boolean>(r => (soltarFalso = r)))
      const autentico = jest.fn(async () => true)
      reingresarMasTarde('m:e', falso, false)
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[0])
      expect(falso).toHaveBeenCalledTimes(1) // el falso está corriendo
      reingresarMasTarde('m:e', autentico, true) // llega el auténtico con la misma clave y su ingreso falla
      soltarFalso(true) // el falso «termina» (401)
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[0])
      expect(autentico).toHaveBeenCalledTimes(1)
    })

    it('los VERIFICADOS también tienen tope (una caída enorme): se abandona el más viejo de ellos, con 🚨', async () => {
      const llamados: string[] = []
      for (let i = 0; i <= TOPE_DE_REINGRESOS_VERIFICADOS; i++) {
        reingresarMasTarde(
          `v${i}`,
          async () => {
            llamados.push(`v${i}`)
            return true
          },
          true,
        )
      }
      // Se corren directo: con 10 000 temporizadores vivos, el reloj simulado de Jest se vuelve cuadrático (medido: >30 s).
      await _reingresarYaParaPruebas()
      expect(llamados).toHaveLength(TOPE_DE_REINGRESOS_VERIFICADOS)
      expect(llamados).not.toContain('v0')
    })

    it('🔴 final-2 · la PUERTA contesta si hay dinero sin guardar y despierta el reingreso YA — no espera su reloj', async () => {
      const reintentar = jest.fn(async () => true)
      registrarAvisoNoGuardado({ merchantAccountId: 'm', attemptId: 'A', posibleDinero: true })
      reingresarMasTarde('m:evtA', reintentar, true)
      expect(puertaDelDinero('A')).toBe(true)
      expect(puertaDelDinero('otro')).toBe(false)
      await jest.advanceTimersByTimeAsync(0)
      expect(reintentar).toHaveBeenCalledTimes(1)
    })

    it('despertar un reingreso que YA está corriendo no lo corre dos veces', async () => {
      let soltar!: (v: boolean) => void
      const reintentar = jest.fn(() => new Promise<boolean>(r => (soltar = r)))
      reingresarMasTarde('m:lento', reintentar, true)
      await jest.advanceTimersByTimeAsync(ESPERAS_DE_REINGRESO_MS[0])
      expect(reintentar).toHaveBeenCalledTimes(1) // corriendo, sin contestar
      puertaDelDinero('cualquiera')
      await jest.advanceTimersByTimeAsync(0)
      expect(reintentar).toHaveBeenCalledTimes(1)
      soltar(true)
      await jest.advanceTimersByTimeAsync(10 * 60_000)
      expect(reintentar).toHaveBeenCalledTimes(1)
    })
  })
})

/**
 * 🔴 final-2 (la puerta): la nota en memoria se lee SÓLO por `puertaDelDinero`. Cada revisión encontraba otro lugar que decidía
 * «no se cobró» mirando sólo la base; con una única lectora, un lector nuevo que la salte se ve aquí y no en producción.
 */
describe('la puerta es la única lectora de la nota en memoria', () => {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const SRC = path.join(__dirname, '../../../../src')
  const archivos = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap(e => (e.isDirectory() ? archivos(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []))

  it('nadie fuera del módulo lee `hayDineroNoGuardado` directo', () => {
    const lectores = archivos(SRC)
      .filter(f => !f.endsWith(path.join('tpv', 'avisosNoGuardados.ts')))
      .filter(f => /\bhayDineroNoGuardado\b/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f))
    expect(lectores).toEqual([])
  })

  it.each([
    ['services/tpv/no-instrument-resolution.service.ts', 'la liberación automática y la declaración del cajero'],
    ['services/terminal-payment.service.ts', 'la ventana de 30 s y la consulta S6 de la terminal'],
  ])('%s pasa por la puerta (%s)', archivo => {
    expect(fs.readFileSync(path.join(SRC, archivo), 'utf8')).toMatch(/\bpuertaDelDinero\(/)
  })

  it('la consulta S6 de la terminal pasa por la puerta', () => {
    const fuente = fs.readFileSync(path.join(SRC, 'services/terminal-payment.service.ts'), 'utf8')
    const s6 = fuente.slice(fuente.indexOf('async consultarIntentoDeTerminal('))
    const cuerpo = s6.slice(0, s6.indexOf('\n  async ', 10))
    expect(cuerpo).toMatch(/\bpuertaDelDinero\(/)
  })
})
