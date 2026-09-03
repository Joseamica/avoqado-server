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

describe('huella de campaña (contenido + audiencia)', () => {
  // Base común: ALL_CONSENTED, sin grupo, sin tags — cada prueba sólo cambia lo que dice su título.
  function base(overrides: Partial<Parameters<typeof huellaDeCampana>[0]> = {}) {
    return {
      subject: 'Asunto',
      bloques: [{ type: 'heading', text: 'Promoción' }],
      audience: 'ALL_CONSENTED',
      customerGroupId: null,
      tags: [] as string[],
      ...overrides,
    }
  }

  it('la MISMA entrada da la MISMA huella (determinista) — si no, el token nunca verificaría', () => {
    const h1 = huellaDeCampana(base())
    const h2 = huellaDeCampana(base())
    expect(h1).toBe(h2)
  })

  it('cambia si cambia el ASUNTO', () => {
    const h1 = huellaDeCampana(base({ subject: 'Asunto A' }))
    const h2 = huellaDeCampana(base({ subject: 'Asunto B' }))
    expect(h1).not.toBe(h2)
  })

  it('cambia si cambia el TEXTO de un bloque', () => {
    const h1 = huellaDeCampana(base({ bloques: [{ type: 'paragraph', text: 'Original' }] }))
    const h2 = huellaDeCampana(base({ bloques: [{ type: 'paragraph', text: 'Editado' }] }))
    expect(h1).not.toBe(h2)
  })

  it('cambia si se AÑADE un bloque', () => {
    const h1 = huellaDeCampana(base({ bloques: [{ type: 'heading', text: 'Título' }] }))
    const h2 = huellaDeCampana(
      base({
        bloques: [
          { type: 'heading', text: 'Título' },
          { type: 'paragraph', text: 'Nuevo párrafo' },
        ],
      }),
    )
    expect(h1).not.toBe(h2)
  })

  // 🔴 Un correo con los mismos bloques en OTRO orden es un correo DISTINTO — el destinatario
  // lo lee en ese orden. Una huella que no distingue el orden dejaría publicar algo distinto
  // de lo que el dueño revisó en la vista previa.
  it('cambia si se REORDENAN los bloques (mismo conjunto, otro orden)', () => {
    const a = { type: 'heading', text: 'Título' }
    const b = { type: 'paragraph', text: 'Párrafo' }
    const h1 = huellaDeCampana(base({ bloques: [a, b] }))
    const h2 = huellaDeCampana(base({ bloques: [b, a] }))
    expect(h1).not.toBe(h2)
  })

  it('NO cambia si sólo cambia el orden de las LLAVES dentro de un mismo bloque (mismo contenido)', () => {
    const h1 = huellaDeCampana(base({ bloques: [{ type: 'button', label: 'Ver', url: 'https://x.mx' }] }))
    const h2 = huellaDeCampana(base({ bloques: [{ url: 'https://x.mx', label: 'Ver', type: 'button' }] }))
    expect(h1).toBe(h2)
  })

  // 🔴 El defecto que originó este fix (revisor, ronda final): la huella NO ataba la
  // audiencia. Cambiar de GROUP a otro GROUP (o de TAGS a otras TAGS) sin tocar el asunto
  // ni los bloques dejaba un token viejo verificando sobre gente que el dueño nunca revisó.
  it('cambia si cambia la AUDIENCIA (tipo)', () => {
    const h1 = huellaDeCampana(base({ audience: 'ALL_CONSENTED' }))
    const h2 = huellaDeCampana(base({ audience: 'TAGS', tags: ['vip'] }))
    expect(h1).not.toBe(h2)
  })

  it('cambia si cambia el GRUPO (misma audiencia GROUP, otro customerGroupId)', () => {
    const h1 = huellaDeCampana(base({ audience: 'GROUP', customerGroupId: 'group-A' }))
    const h2 = huellaDeCampana(base({ audience: 'GROUP', customerGroupId: 'group-B' }))
    expect(h1).not.toBe(h2)
  })

  it('cambia si cambian las TAGS (mismo asunto y bloques, otro conjunto de etiquetas)', () => {
    const h1 = huellaDeCampana(base({ audience: 'TAGS', tags: ['vip'] }))
    const h2 = huellaDeCampana(base({ audience: 'TAGS', tags: ['nuevo'] }))
    expect(h1).not.toBe(h2)
  })

  // Los tags no tienen un orden que le importe a la audiencia real (TAGS es "cualquiera de
  // estas etiquetas") — reordenarlas no puede invalidar un token sin que nada haya cambiado.
  it('NO cambia si las MISMAS tags vienen en OTRO orden', () => {
    const h1 = huellaDeCampana(base({ audience: 'TAGS', tags: ['vip', 'nuevo'] }))
    const h2 = huellaDeCampana(base({ audience: 'TAGS', tags: ['nuevo', 'vip'] }))
    expect(h1).toBe(h2)
  })
})
