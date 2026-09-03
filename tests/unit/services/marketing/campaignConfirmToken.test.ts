import { firmarTokenDeEnvio, verificarTokenDeEnvio, huellaDeCampana } from '@/services/marketing/campaignConfirmToken'

describe('token de confirmación al publicar una campaña', () => {
  const ahora = new Date('2026-09-02T12:00:00.000Z')

  it('un token firmado con el mismo contenido y conteo verifica', () => {
    const t = firmarTokenDeEnvio({ campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora })
    expect(verificarTokenDeEnvio(t, { campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora })).toEqual({
      ok: true,
    })
  })

  // 🔴 Es la razón de existir del token (spec, ronda 2 #17).
  it('si el CONTENIDO cambió entre la vista previa y el confirmar, el token NO vale', () => {
    const t = firmarTokenDeEnvio({ campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora })
    expect(verificarTokenDeEnvio(t, { campaignId: 'c1', venueId: 'v1', huellaContenido: 'B', totalDestinatarios: 10, ahora })).toEqual({
      ok: false,
      motivo: 'CAMBIO',
    })
  })

  it('si la AUDIENCIA creció entre la vista previa y el confirmar, el token NO vale', () => {
    const t = firmarTokenDeEnvio({ campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora })
    expect(verificarTokenDeEnvio(t, { campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 11, ahora })).toEqual({
      ok: false,
      motivo: 'CAMBIO',
    })
  })

  it('a los 16 minutos está vencido', () => {
    const t = firmarTokenDeEnvio({ campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora })
    const dieciseisMinutosDespues = new Date(ahora.getTime() + 16 * 60 * 1000)
    expect(
      verificarTokenDeEnvio(t, {
        campaignId: 'c1',
        venueId: 'v1',
        huellaContenido: 'A',
        totalDestinatarios: 10,
        ahora: dieciseisMinutosDespues,
      }),
    ).toEqual({ ok: false, motivo: 'VENCIDO' })
  })

  it('a los 14 minutos todavía vale (justo antes del corte de 15)', () => {
    const t = firmarTokenDeEnvio({ campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora })
    const catorceMinutosDespues = new Date(ahora.getTime() + 14 * 60 * 1000)
    expect(
      verificarTokenDeEnvio(t, {
        campaignId: 'c1',
        venueId: 'v1',
        huellaContenido: 'A',
        totalDestinatarios: 10,
        ahora: catorceMinutosDespues,
      }),
    ).toEqual({ ok: true })
  })

  it('un token manipulado no verifica', () => {
    const t = firmarTokenDeEnvio({ campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora })
    const manipulado = t.slice(0, -2) + 'xx'
    expect(
      verificarTokenDeEnvio(manipulado, { campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora }),
    ).toEqual({
      ok: false,
      motivo: 'INVALIDO',
    })
  })

  it('un token de OTRA campaña no vale para ésta', () => {
    const t = firmarTokenDeEnvio({ campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora })
    expect(verificarTokenDeEnvio(t, { campaignId: 'c2', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora })).toEqual({
      ok: false,
      motivo: 'INVALIDO',
    })
  })

  it('un token de OTRO venue no vale para éste (aunque sea la misma campaña)', () => {
    const t = firmarTokenDeEnvio({ campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora })
    expect(verificarTokenDeEnvio(t, { campaignId: 'c1', venueId: 'v2', huellaContenido: 'A', totalDestinatarios: 10, ahora })).toEqual({
      ok: false,
      motivo: 'INVALIDO',
    })
  })

  it('un token vacío o sin punto no verifica', () => {
    expect(verificarTokenDeEnvio('', { campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora })).toEqual({
      ok: false,
      motivo: 'INVALIDO',
    })
    expect(
      verificarTokenDeEnvio('sinpunto', { campaignId: 'c1', venueId: 'v1', huellaContenido: 'A', totalDestinatarios: 10, ahora }),
    ).toEqual({ ok: false, motivo: 'INVALIDO' })
  })
})

describe('huella de campaña (contenido)', () => {
  it('la MISMA entrada da la MISMA huella (determinista) — si no, el token nunca verificaría', () => {
    const bloques = [
      { type: 'heading', text: 'Promoción' },
      { type: 'paragraph', text: 'Este mes, 2x1.' },
    ]
    const h1 = huellaDeCampana({ subject: 'Asunto', bloques })
    const h2 = huellaDeCampana({ subject: 'Asunto', bloques })
    expect(h1).toBe(h2)
  })

  it('cambia si cambia el ASUNTO', () => {
    const bloques = [{ type: 'heading', text: 'Promoción' }]
    const h1 = huellaDeCampana({ subject: 'Asunto A', bloques })
    const h2 = huellaDeCampana({ subject: 'Asunto B', bloques })
    expect(h1).not.toBe(h2)
  })

  it('cambia si cambia el TEXTO de un bloque', () => {
    const h1 = huellaDeCampana({ subject: 'Asunto', bloques: [{ type: 'paragraph', text: 'Original' }] })
    const h2 = huellaDeCampana({ subject: 'Asunto', bloques: [{ type: 'paragraph', text: 'Editado' }] })
    expect(h1).not.toBe(h2)
  })

  it('cambia si se AÑADE un bloque', () => {
    const h1 = huellaDeCampana({ subject: 'Asunto', bloques: [{ type: 'heading', text: 'Título' }] })
    const h2 = huellaDeCampana({
      subject: 'Asunto',
      bloques: [
        { type: 'heading', text: 'Título' },
        { type: 'paragraph', text: 'Nuevo párrafo' },
      ],
    })
    expect(h1).not.toBe(h2)
  })

  // 🔴 Un correo con los mismos bloques en OTRO orden es un correo DISTINTO — el destinatario
  // lo lee en ese orden. Una huella que no distingue el orden dejaría publicar algo distinto
  // de lo que el dueño revisó en la vista previa.
  it('cambia si se REORDENAN los bloques (mismo conjunto, otro orden)', () => {
    const a = { type: 'heading', text: 'Título' }
    const b = { type: 'paragraph', text: 'Párrafo' }
    const h1 = huellaDeCampana({ subject: 'Asunto', bloques: [a, b] })
    const h2 = huellaDeCampana({ subject: 'Asunto', bloques: [b, a] })
    expect(h1).not.toBe(h2)
  })

  it('NO cambia si sólo cambia el orden de las LLAVES dentro de un mismo bloque (mismo contenido)', () => {
    const h1 = huellaDeCampana({ subject: 'Asunto', bloques: [{ type: 'button', label: 'Ver', url: 'https://x.mx' }] })
    const h2 = huellaDeCampana({ subject: 'Asunto', bloques: [{ url: 'https://x.mx', label: 'Ver', type: 'button' }] })
    expect(h1).toBe(h2)
  })
})
