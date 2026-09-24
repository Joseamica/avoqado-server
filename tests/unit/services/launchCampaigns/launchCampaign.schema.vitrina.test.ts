/**
 * Los mensajes que ve una persona salen en ESPAÑOL (regla del repo: el middleware de validación
 * muestra el texto de Zod tal cual). /full-testing del 24-sep encontró dos en inglés en lo nuevo de
 * la vitrina: «Invalid enum value…» y el de un booleano.
 */
import { featuredVerticalParams, updateLaunchCampaignBody } from '@/services/launchCampaigns/launchCampaign.schema'

const mensajes = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  (r.error?.issues ?? []).map(i => i.message).join(' | ')

describe('vitrina — mensajes en español', () => {
  it('un giro que no existe se explica en español', () => {
    const r = featuredVerticalParams.safeParse({ vertical: 'BOGUS' })
    expect(r.success).toBe(false)
    expect(mensajes(r as never)).toMatch(/giro/i)
    expect(mensajes(r as never)).not.toMatch(/Invalid|Expected/)
  })

  it('los giros válidos pasan', () => {
    for (const v of ['ALL', 'FOOD_SERVICE', 'RETAIL', 'SERVICES', 'HOSPITALITY', 'ENTERTAINMENT']) {
      expect(featuredVerticalParams.safeParse({ vertical: v }).success).toBe(true)
    }
  })

  it('una vitrina que no es sí/no se explica en español', () => {
    const r = updateLaunchCampaignBody.safeParse({ expectedUpdatedAt: '2026-09-24T00:00:00Z', featuredForVertical: 'si' })
    expect(r.success).toBe(false)
    expect(mensajes(r as never)).toMatch(/vitrina/i)
    expect(mensajes(r as never)).not.toMatch(/Expected|Invalid/)
  })
})
