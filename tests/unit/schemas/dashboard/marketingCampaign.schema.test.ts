// tests/unit/schemas/dashboard/marketingCampaign.schema.test.ts
/**
 * `scheduledFor` — fix ronda final (revisor): el esquema lo aceptaba pero nadie lo honraba.
 * `guardarBorrador` siempre escribía DRAFT y el envío ocurre en minutos; peor,
 * `campaignEnqueue.service.ts:220` usa `campaign.scheduledFor ?? ahora` para calcular el
 * PERÍODO de la cuota mensual — una fecha futura en el cuerpo mandaba el correo HOY pero
 * cargaba la cuota a un mes futuro, evadiendo el tope que protege la reputación del
 * subdominio de correo. Se quitó el campo del esquema; estas pruebas fijan que Zod lo
 * DESCARTA (no lo rechaza con error — sólo lo ignora, como cualquier llave desconocida en
 * modo "strip", el default de este repo).
 */
import { crearCampanaSchema, editarCampanaSchema } from '@/schemas/dashboard/marketingCampaign.schema'

const VENUE_ID = 'cabcdefghijklmnopqrstuvwxy'
const CAMPAIGN_ID = 'cabcdefghijklmnopqrstuvwxz'

function cuerpoBase() {
  return {
    name: 'Promo de diciembre',
    subject: 'Asunto',
    bloques: [{ type: 'heading', text: 'Hola' }],
    audience: 'ALL_CONSENTED',
    // El campo hostil: un cliente que todavía cree que puede agendar.
    scheduledFor: '2026-12-25T00:00:00.000Z',
  }
}

describe('marketingCampaign.schema — scheduledFor NO se persiste (Zod lo descarta)', () => {
  it('crearCampanaSchema: scheduledFor desaparece del body parseado', () => {
    const resultado = crearCampanaSchema.safeParse({ params: { venueId: VENUE_ID }, body: cuerpoBase() })
    expect(resultado.success).toBe(true)
    if (!resultado.success) return
    expect(resultado.data.body).not.toHaveProperty('scheduledFor')
    expect(Object.keys(resultado.data.body)).not.toContain('scheduledFor')
  })

  it('editarCampanaSchema: scheduledFor desaparece del body parseado', () => {
    const resultado = editarCampanaSchema.safeParse({
      params: { venueId: VENUE_ID, id: CAMPAIGN_ID },
      body: cuerpoBase(),
    })
    expect(resultado.success).toBe(true)
    if (!resultado.success) return
    expect(resultado.data.body).not.toHaveProperty('scheduledFor')
  })

  it('sin scheduledFor, el resto del body sigue validando igual (no es un campo requerido en ningún lado)', () => {
    const { scheduledFor: _fuera, ...sinAgenda } = cuerpoBase()
    const resultado = crearCampanaSchema.safeParse({ params: { venueId: VENUE_ID }, body: sinAgenda })
    expect(resultado.success).toBe(true)
  })
})
