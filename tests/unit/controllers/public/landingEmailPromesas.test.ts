/**
 * 🔴 AUDITORÍA DE CODEX (2026-09-18, hallazgo #2): el correo de bienvenida promete capacidades que
 * el cliente NO contrató, y lo deja POR ESCRITO.
 *
 * Tres afirmaciones medidas en el texto, las tres falsas para quien llega por una campaña de pago:
 *
 *  1. «Nos dijiste que te interesa esto, y **ya viene incluido en tu cuenta**» — los `modules` del
 *     formulario se usan para CRM y comunicación; NUNCA se pasan a `signupFromLanding` como
 *     selección comercial. No se contrata ninguno.
 *  2. «Facturar CFDI 4.0 … desde el primer día» — CFDI es PREMIUM (`PREMIUM_ONLY_CODES`). Quien
 *     llega por POS22 compra PRO y no lo tiene.
 *  3. «El plan inicial es gratis para siempre y **no pedimos tarjeta**» — a quien llega por una
 *     campaña se le cobra el primer mes CON tarjeta, en la última pantalla del alta.
 *
 * Una cafetería puede marcar inventario y CFDI, recibir ese correo, pagar POS22 y no tener ninguno
 * de los dos. Eso no es un desajuste de copy: es una promesa comercial escrita que el producto no
 * cumple, y llega al buzón del cliente antes de que pague.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fuente = readFileSync(join(__dirname, '../../../../src/controllers/public/landing.public.controller.ts'), 'utf8')

describe('el correo de la landing no promete lo que no se vendió', () => {
  it('🔴 NO afirma que los módulos marcados «ya vienen incluidos»', () => {
    expect(fuente).not.toMatch(/ya viene incluido en tu cuenta/i)
  })

  it('🔴 NO promete CFDI «desde el primer día» a quien no lo compró', () => {
    // CFDI vive en PREMIUM_ONLY_CODES: prometerlo en el correo del alta es venderle a un PRO algo
    // que su plan no le da.
    const bloqueDelPrimerDia = fuente.match(/lo que vas a poder hacer desde el primer día[\s\S]{0,900}?<\/ul>/)?.[0] ?? ''
    expect(bloqueDelPrimerDia).not.toMatch(/CFDI/i)
  })

  it('🔴 NO promete «no pedimos tarjeta» sin distinguir a quien llega por una campaña de pago', () => {
    // El texto plano de «gratis para siempre / sin tarjeta» sólo puede aparecer condicionado a que
    // NO haya campaña — a quien llega del anuncio se le cobra con tarjeta ese mismo día.
    // Se mira el CONTEXTO, no la línea: la promesa puede vivir dentro de un ternario cuya condición
    // está unas líneas arriba. Lo que se exige es que ninguna aparición quede fuera de una rama
    // que distinga si hay campaña.
    const lineas = fuente.split('\n')
    // Los COMENTARIOS que explican este mismo defecto citan la frase: no son texto del correo.
    const apariciones = lineas
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /no pedimos tarjeta/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
    expect(apariciones.length).toBeGreaterThan(0)
    for (const { i } of apariciones) {
      const contexto = lineas.slice(Math.max(0, i - 8), i + 1).join('\n')
      expect(contexto).toMatch(/launchCampaignCode/)
    }
  })
})
