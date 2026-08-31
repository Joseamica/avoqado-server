/**
 * «¿Este servidor tiene bien la configuración crítica?» — contestable a demanda.
 *
 * Por qué existe (founder, 2026-08-30): `SESSION_SUCCESSOR_ENC_KEY` sólo se comprobaba AL
 * ARRANCAR, en un `logger.error`. Eso obliga a reiniciar el servicio y a leer el log para saber
 * si quedó puesta — y si los logs de arranque no llegan al drenaje (pasa en Render), no hay forma
 * de saberlo. Se buscó en Better Stack y no había una sola línea de arranque en 48 h, así que ni
 * la ausencia del error probaba nada.
 *
 * 🔴 La MISMA función contesta el arranque y el endpoint. Si cada uno recolectara por su cuenta
 * acabarían diciendo cosas distintas — es exactamente lo que ya pasó entre el reporte de
 * asistencia y las comisiones con los turnos nocturnos.
 */
import { revisarConfiguracionCritica } from '@/config/configCheck'

const LLAVE = 'a'.repeat(64)

describe('revisarConfiguracionCritica', () => {
  it('🔴 NUNCA devuelve el valor de una variable — sólo si está o no', () => {
    // La razón de ser del endpoint es poder preguntar «¿la tienes?» sin que la respuesta sea
    // «sí, es ésta». Un secreto que viaja en una respuesta HTTP ya está comprometido: queda en
    // logs de proxy, en el historial del navegador y en cualquier captura de pantalla.
    const secreto = 'deadbeef'.repeat(8)
    const r = revisarConfiguracionCritica({
      NODE_ENV: 'production',
      SESSION_SUCCESSOR_ENC_KEY: secreto,
      EXTERNAL_BANK_API_BASE: 'https://api.banco-real.mx',
    })

    expect(JSON.stringify(r)).not.toContain(secreto)
    expect(JSON.stringify(r)).not.toContain('deadbeef')
  })

  it('en producción SIN la llave: no está bien, y dice la consecuencia', () => {
    const r = revisarConfiguracionCritica({ NODE_ENV: 'production', EXTERNAL_BANK_API_BASE: 'https://api.banco-real.mx' })
    const llave = r.revisiones.find(x => x.clave === 'SESSION_SUCCESSOR_ENC_KEY')!

    expect(llave.ok).toBe(false)
    expect(r.todoBien).toBe(false)
    // Quien lee esto a las 3 AM tiene que entender qué se rompe, no sólo que algo falta.
    expect(llave.detalle).toMatch(/revoc|retransmisi/i)
  })

  it('en producción CON la llave: todo bien', () => {
    const r = revisarConfiguracionCritica({
      NODE_ENV: 'production',
      SESSION_SUCCESSOR_ENC_KEY: LLAVE,
      EXTERNAL_BANK_API_BASE: 'https://api.banco-real.mx',
    })

    expect(r.revisiones.find(x => x.clave === 'SESSION_SUCCESSOR_ENC_KEY')!.ok).toBe(true)
    expect(r.todoBien).toBe(true)
  })

  it('staging TAMBIÉN es un entorno desplegado — es donde se prueba con aparatos reales', () => {
    const r = revisarConfiguracionCritica({ NODE_ENV: 'staging', EXTERNAL_BANK_API_BASE: 'https://api.banco-real.mx' })

    expect(r.revisiones.find(x => x.clave === 'SESSION_SUCCESSOR_ENC_KEY')!.ok).toBe(false)
  })

  it('en development sin la llave NO se reporta como problema — un dev local no despliega nada', () => {
    const r = revisarConfiguracionCritica({ NODE_ENV: 'development', EXTERNAL_BANK_API_BASE: 'http://localhost:9999' })

    expect(r.revisiones.find(x => x.clave === 'SESSION_SUCCESSOR_ENC_KEY')!.ok).toBe(true)
    expect(r.todoBien).toBe(true)
  })

  it('el banco apuntando a un host de PRUEBAS en producción se reporta', () => {
    // Mismo guardia que ya vivía en el arranque; ahora también se puede preguntar.
    const r = revisarConfiguracionCritica({
      NODE_ENV: 'production',
      SESSION_SUCCESSOR_ENC_KEY: LLAVE,
      EXTERNAL_BANK_API_BASE: 'https://qpaydev.xyz/api',
    })

    expect(r.revisiones.find(x => x.clave === 'EXTERNAL_BANK_API_BASE')!.ok).toBe(false)
    expect(r.todoBien).toBe(false)
  })

  it('una URL de banco ilegible NO revienta la revisión — el diagnóstico no puede ser lo que falle', () => {
    // Si esta función lanza, el endpoint devuelve 500 y perdemos justo la herramienta que
    // veníamos a usar para diagnosticar.
    expect(() => revisarConfiguracionCritica({ NODE_ENV: 'production', EXTERNAL_BANK_API_BASE: 'no-es-una-url' })).not.toThrow()
  })

  it('reporta el entorno, porque la misma respuesta significa cosas distintas según dónde corra', () => {
    expect(revisarConfiguracionCritica({ NODE_ENV: 'staging' }).entorno).toBe('staging')
  })
})
