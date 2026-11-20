// tests/unit/services/shared/motivoDelDescuento.test.ts
// Encargo f998c8 (founder «A», 15-nov): motivo obligatorio en los descuentos del POS, como Toast.
import { MAX_COMENTARIO, MAX_MOTIVO, MAX_MOTIVOS, motivoDelDescuento, validarAjusteDeMotivos } from '@/services/shared/motivoDelDescuento'

describe('motivoDelDescuento (lo que llega del POS)', () => {
  it('guarda el motivo y el comentario recortados', () => {
    expect(motivoDelDescuento('  Cliente frecuente ', '  le debíamos una  ')).toEqual({
      reason: 'Cliente frecuente',
      reasonComment: 'le debíamos una',
    })
  })

  it('sin motivo ni comentario no agrega nada (la fila queda «Sin motivo», como hoy)', () => {
    expect(motivoDelDescuento(undefined, undefined)).toEqual({})
    expect(motivoDelDescuento(null, null)).toEqual({})
    expect(motivoDelDescuento('   ', '')).toEqual({})
  })

  it('nunca rechaza basura: lo que no es texto se ignora (una app vieja o la cola no pueden perder la venta)', () => {
    expect(motivoDelDescuento(42, { a: 1 })).toEqual({})
    expect(motivoDelDescuento(['x'], true)).toEqual({})
  })

  it('un comentario sin motivo se guarda solo', () => {
    expect(motivoDelDescuento(undefined, 'nota')).toEqual({ reasonComment: 'nota' })
  })

  it('recorta lo largo al tope, sin rechazar', () => {
    const r = motivoDelDescuento('m'.repeat(MAX_MOTIVO + 10), 'c'.repeat(MAX_COMENTARIO + 10))
    expect(r.reason).toHaveLength(MAX_MOTIVO)
    expect(r.reasonComment).toHaveLength(MAX_COMENTARIO)
  })

  it('junta los espacios de dentro (un motivo con dos espacios no es otro motivo en el reporte)', () => {
    expect(motivoDelDescuento('Cliente   frecuente', undefined)).toEqual({ reason: 'Cliente frecuente' })
  })
})

describe('validarAjusteDeMotivos (lo que guarda el DASHBOARD)', () => {
  it('sin ninguna de las dos llaves no hay nada que validar', () => {
    expect(validarAjusteDeMotivos({}, { required: false, reasons: [] })).toEqual({ ok: true, cambios: {} })
  })

  it('normaliza la lista: recorta, junta espacios y quita vacíos', () => {
    expect(
      validarAjusteDeMotivos({ reasons: ['  Error de captura ', '', 'Cliente  frecuente'] }, { required: false, reasons: [] }),
    ).toEqual({
      ok: true,
      cambios: { discountReasons: ['Error de captura', 'Cliente frecuente'] },
    })
  })

  it('no se prende con la lista vacía (ni la guardada ni la nueva)', () => {
    const r = validarAjusteDeMotivos({ required: true }, { required: false, reasons: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.mensaje).toMatch(/al menos un motivo/i)
    expect(validarAjusteDeMotivos({ required: true, reasons: [] }, { required: false, reasons: ['A'] }).ok).toBe(false)
  })

  it('se prende si la lista guardada o la nueva traen motivos', () => {
    expect(validarAjusteDeMotivos({ required: true }, { required: false, reasons: ['A'] })).toEqual({
      ok: true,
      cambios: { discountReasonRequired: true },
    })
    expect(validarAjusteDeMotivos({ required: true, reasons: ['B'] }, { required: false, reasons: [] })).toEqual({
      ok: true,
      cambios: { discountReasonRequired: true, discountReasons: ['B'] },
    })
  })

  it('con el switch prendido no se quita el último motivo', () => {
    const r = validarAjusteDeMotivos({ reasons: [] }, { required: true, reasons: ['A'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.mensaje).toMatch(/apaga/i)
  })

  it('apagar y vaciar a la vez sí se puede', () => {
    expect(validarAjusteDeMotivos({ required: false, reasons: [] }, { required: true, reasons: ['A'] })).toEqual({
      ok: true,
      cambios: { discountReasonRequired: false, discountReasons: [] },
    })
  })

  it('rechaza repetidos sin importar mayúsculas ni acentos de espacio', () => {
    const r = validarAjusteDeMotivos({ reasons: ['Error', ' error '] }, { required: false, reasons: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.mensaje).toMatch(/repetido/i)
  })

  it('rechaza un motivo más largo que el tope (aquí sí: es el dueño escribiendo, no una venta)', () => {
    const r = validarAjusteDeMotivos({ reasons: ['x'.repeat(MAX_MOTIVO + 1)] }, { required: false, reasons: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.mensaje).toContain(String(MAX_MOTIVO))
  })

  it(`rechaza más de ${MAX_MOTIVOS} motivos`, () => {
    const muchos = Array.from({ length: MAX_MOTIVOS + 1 }, (_, i) => `Motivo ${i + 1}`)
    const r = validarAjusteDeMotivos({ reasons: muchos }, { required: false, reasons: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.mensaje).toContain(String(MAX_MOTIVOS))
  })
})

// D4 (Codex r3 #2, 18-nov): un carácter nulo (o de control) en el motivo o el comentario hacía que PostgreSQL rechazara la escritura
// entera (el vale, o la venta de Mostrador). Se cambia por un espacio, como un salto de línea.
describe('motivoDelDescuento · caracteres de control', () => {
  it('quita el nulo y los de control y nunca deja texto que la base rechace', () => {
    expect(motivoDelDescuento('Cliente\u0000frecuente', 'Viene\u0007 diario\u0000')).toEqual({
      reason: 'Cliente frecuente',
      reasonComment: 'Viene diario',
    })
    expect(motivoDelDescuento('\u0000\u0000', '\u0000')).toEqual({})
    expect(motivoDelDescuento('Cliente\u0085frecuente\u009F', null)).toEqual({ reason: 'Cliente frecuente' })
  })
})
