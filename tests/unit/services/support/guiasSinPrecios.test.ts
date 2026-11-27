/**
 * Planes editables B4 (guías): el bot de soporte, sus guías y el MCP `help` ya no escriben el precio de un plan (con el editor
 * pueden quedar viejos): remiten a «Tu plan». Va aparte del resto de B4 porque cambia la biblioteca firmada del bot: se une sólo
 * con la firma del founder (`aprobar-biblioteca --firmar`), y es requisito para prender el interruptor (B5).
 */
import fs from 'fs'
import path from 'path'
import { DRAFT_INSTRUCTIONS, reviewSupportDraft, type SupportDraft } from '@/services/support/hybrid.service'
import { SUPPORT_OVERVIEW_DIRECTORY, readLibrarySources } from '@/services/support/libraryFiles'

const REMISION = 'El precio vigente de tu plan está en «Tu plan», en Facturación.'

const PRECIO_DE_PLAN = /\$\s?(?:499|999|1,?699)\b|\b1699\b|30 días gratis|\$499 \+ IVA/
const TREINTA_JUNTO_A_UN_PLAN = /(?:plan\s+\p{L}+[^.\n]{0,40}30 días|30 días[^.\n]{0,40}(?:plan|Pro\b|Básico|Premium))/iu

describe('ninguna guía escribe el precio de un plan', () => {
  const fuentes = readLibrarySources()
  const archivosDelMcp = fs
    .readdirSync(path.resolve(__dirname, '../../../../src/assets/mcp-knowledge'), { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.md'))

  it('recorre las tres fuentes de readLibrarySources (ayuda, resúmenes y manual interno)', () => {
    expect(fuentes.some(s => s.internal)).toBe(true)
    expect(fuentes.some(s => s.general)).toBe(true)
    expect(fuentes.some(s => !s.internal && !s.general)).toBe(true)
  })

  it.each(fuentes.map(s => [s.id, s.raw.toString('utf8')]))('%s: sin $499, $999, $1,699 ni «30 días» junto a un plan', (_id, texto) => {
    expect(texto).not.toMatch(PRECIO_DE_PLAN)
    expect(texto).not.toMatch(TREINTA_JUNTO_A_UN_PLAN)
  })

  it.each(archivosDelMcp)('mcp-knowledge/%s: sin precio de plan', archivo => {
    const texto = fs.readFileSync(path.resolve(__dirname, '../../../../src/assets/mcp-knowledge', archivo), 'utf8')
    expect(texto).not.toMatch(PRECIO_DE_PLAN)
    expect(texto).not.toMatch(TREINTA_JUNTO_A_UN_PLAN)
  })

  it('el resumen general trae la remisión a «Tu plan»', () => {
    const resumen = fs.readFileSync(path.join(SUPPORT_OVERVIEW_DIRECTORY, '_overview.md'), 'utf8')
    expect(resumen).toContain(REMISION)
  })

  it('la remisión pasa el revisor de hybrid.service (sin dominio: CONTACT rechaza avoqado.io)', () => {
    const resumen = fuentes.find(s => s.id === 'general/overview')!
    const guia = { ...resumen, id: resumen.id } as never
    const borrador: SupportDraft = {
      covered: true,
      intro: { text: REMISION, guideId: resumen.id, quote: REMISION },
      steps: [{ text: REMISION, guideId: resumen.id, quote: REMISION }],
    }
    expect(reviewSupportDraft(borrador, [guia]).ok).toBe(true)
  })

  it('el ejemplo del prompt no trae un precio de plan', () => {
    expect(DRAFT_INSTRUCTIONS).not.toMatch(PRECIO_DE_PLAN)
  })
})
