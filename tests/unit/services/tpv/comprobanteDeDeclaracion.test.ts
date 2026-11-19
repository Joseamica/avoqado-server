/**
 * F1 · cierre bloque 7: el comprobante de una declaración guardada. Lo arma UNA función para el POST, S6 y el GET por solicitud.
 * Sólo acredita una firma HUMANA lo que consta: clase humana, `by` SESSION o SUPERVISOR_PIN, autor y hora. El cliente decide el texto.
 */
import { comprobanteDeDeclaracion } from '@/services/tpv/comprobanteDeDeclaracion'

const intento = { scope: 'ATTEMPT' as const, attemptId: 'att-1', requestId: null }
const solicitud = { scope: 'REQUEST' as const, attemptId: null, requestId: 'req-1' }
const firmada = {
  id: 'r-1',
  kind: 'NO_INSTRUMENT_PRESENTED',
  acceptedAt: '2026-11-18T18:00:00.000Z',
  bodyHash: 'h',
  staffId: 'gerente-1',
  staffVenueId: 'sv-1',
  by: 'SUPERVISOR_PIN',
  statementVersion: 1,
}

describe('comprobanteDeDeclaracion', () => {
  it('la firma de un gerente: autor, hora y alcance; `alreadyStored` lo dice quien llama (por omisión, ya guardada)', () => {
    expect(comprobanteDeDeclaracion(firmada, intento)).toEqual({
      id: 'r-1',
      kind: 'NO_INSTRUMENT_PRESENTED',
      by: 'SUPERVISOR_PIN',
      staffId: 'gerente-1',
      acceptedAt: '2026-11-18T18:00:00.000Z',
      scope: 'ATTEMPT',
      attemptId: 'att-1',
      requestId: null,
      humanSignature: true,
      alreadyStored: true,
    })
    expect(comprobanteDeDeclaracion(firmada, intento, false)?.alreadyStored).toBe(false)
  })

  it('las dos clases humanas valen con SESSION histórico y con SUPERVISOR_PIN', () => {
    for (const kind of ['NO_INSTRUMENT_PRESENTED', 'UNCHARGED_VERIFIED'])
      for (const by of ['SESSION', 'SUPERVISOR_PIN'])
        expect(comprobanteDeDeclaracion({ ...firmada, kind, by }, solicitud)?.humanSignature).toBe(true)
  })

  it('NO acreditan una firma humana: sin autor, AUTOMATIC, sin `by`, el rechazo del banco ni una hora ilegible', () => {
    const casos = [
      { ...firmada, staffId: null },
      { ...firmada, staffId: '  ' },
      { ...firmada, by: 'AUTOMATIC' },
      { ...firmada, kind: 'NO_BANK_TRACE_AFTER_WINDOW', by: 'AUTOMATIC' },
      { ...firmada, by: undefined },
      { ...firmada, by: 'CUALQUIERA' },
      { ...firmada, kind: 'BANK_DECLINED', by: undefined, staffId: null },
      { ...firmada, acceptedAt: 'ayer' },
    ]
    for (const c of casos) expect(comprobanteDeDeclaracion(c, intento)?.humanSignature).toBe(false)
    // Lo que no consta sale `null`, nunca inventado.
    expect(comprobanteDeDeclaracion({ ...firmada, by: 'CUALQUIERA', staffId: 7, acceptedAt: 'ayer' }, intento)).toMatchObject({
      by: null,
      staffId: null,
      acceptedAt: null,
    })
  })

  it('sin declaración no hay comprobante: null, cuerpo vacío, sin id o sin clase', () => {
    for (const c of [null, undefined, {}, [], 'x', { ...firmada, id: '' }, { ...firmada, id: undefined }, { ...firmada, kind: undefined }])
      expect(comprobanteDeDeclaracion(c, intento)).toBeNull()
  })
})
