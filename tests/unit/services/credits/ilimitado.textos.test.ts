/**
 * D687 (hz:73e6a32c:D687) · los textos del Ilimitado. A quien compró el pase (widget, app de clientes) se le habla de «tu»; al
 * personal (DASHBOARD, POS, MCP), sin posesivo y sin suponer el giro. El vencimiento dice «antes de este horario», como el widget:
 * «esta clase es después» confundía cuando el pase vence y la clase empieza el mismo día. Los códigos no cambian.
 */
import { BadRequestError } from '@/errors/AppError'
import {
  CREDIT_UNLIMITED_AFTER_EXPIRY,
  CREDIT_UNLIMITED_ONE_SEAT,
  CREDIT_UNLIMITED_TITULAR,
  errorIlimitado,
  errorVenceAntes,
  mensajeVenceAntes,
} from '@/services/credits/ilimitado'

const TZ = 'America/Mexico_City'
// Vence a la 01:22 del 30 de noviembre, hora del negocio (la clase del caso real era a las 10:00 del mismo día).
const VENCE = new Date('2026-11-30T07:22:00.000Z')

describe('D687 · textos del Ilimitado', () => {
  describe('vencimiento', () => {
    it('a quien lo compró: el mismo texto que el widget', () => {
      expect(mensajeVenceAntes(VENCE, TZ)).toBe('Tu Ilimitado vence el 30 de noviembre, antes de este horario.')
      expect(mensajeVenceAntes(VENCE, TZ, 'CLIENTA')).toBe('Tu Ilimitado vence el 30 de noviembre, antes de este horario.')
    })

    it('al personal, sin posesivo', () => {
      expect(mensajeVenceAntes(VENCE, TZ, 'PERSONAL')).toBe('Este Ilimitado vence el 30 de noviembre, antes de este horario.')
    })

    it('la fecha va en la zona del negocio: las 23:00 del 30 en México ya son el 1 de diciembre en UTC', () => {
      expect(mensajeVenceAntes(new Date('2026-12-01T05:00:00.000Z'), TZ)).toBe(
        'Tu Ilimitado vence el 30 de noviembre, antes de este horario.',
      )
    })

    it('el error conserva su código y su forma para las dos', () => {
      for (const audiencia of [undefined, 'CLIENTA', 'PERSONAL'] as const) {
        const error = errorVenceAntes(VENCE, TZ, audiencia)
        expect(error).toBeInstanceOf(BadRequestError)
        expect(error.statusCode).toBe(400)
        expect(error.code).toBe(CREDIT_UNLIMITED_AFTER_EXPIRY)
        expect(error.message).not.toContain('esta clase es después')
      }
      expect(errorVenceAntes(VENCE, TZ, 'PERSONAL').message).toBe('Este Ilimitado vence el 30 de noviembre, antes de este horario.')
    })
  })

  describe('un lugar por clase', () => {
    it('a quien lo compró, el texto de siempre', () => {
      const error = errorIlimitado('CREDIT_UNLIMITED_ONE_SEAT')
      expect(error.code).toBe(CREDIT_UNLIMITED_ONE_SEAT)
      expect(error.message).toBe('Tu Ilimitado es personal: cubre 1 lugar por clase a tu nombre. Los demás lugares se pagan aparte.')
    })

    it('al personal: sin «tu», sin suponer «cliente» y con el mismo código', () => {
      const error = errorIlimitado('CREDIT_UNLIMITED_ONE_SEAT', 'PERSONAL')
      expect(error).toBeInstanceOf(BadRequestError)
      expect(error.code).toBe(CREDIT_UNLIMITED_ONE_SEAT)
      expect(error.message).toBe(
        'El Ilimitado es personal: cubre 1 lugar por clase, a nombre de quien lo compró. Los demás lugares se pagan aparte.',
      )
      expect(error.message).not.toMatch(/\btu\b/i)
      expect(error.message).not.toMatch(/client/i)
    })
  })

  it('un texto que ya era neutro sale igual para los dos (regresión)', () => {
    expect(errorIlimitado('CREDIT_UNLIMITED_TITULAR', 'PERSONAL').message).toBe(errorIlimitado('CREDIT_UNLIMITED_TITULAR').message)
    expect(errorIlimitado('CREDIT_UNLIMITED_TITULAR', 'PERSONAL').code).toBe(CREDIT_UNLIMITED_TITULAR)
  })
})
