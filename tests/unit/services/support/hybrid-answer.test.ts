import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type OpenAI from 'openai'
import { LUNA_SUPPORT_PRICING as pricing } from '@/config/supportWhatsapp'
import type { HelpAccess } from '@/services/support/access.service'
import { composeSupportAnswer, supportWarnings } from '@/services/support/answer.service'
import {
  DRAFT_INSTRUCTIONS,
  JUDGE_INSTRUCTIONS,
  clarificationText,
  draftSupportAnswer,
  hybridAnswerText,
  hybridDraftGuides,
  hybridDraftOutcome,
  hybridFallback,
  hybridFixedReply,
  hybridHistory,
  judgeMissingSignal,
  judgeSupportDraft,
  literalSupportAnswer,
  missingLineText,
  numberedGuide,
  renderSupportAnswer,
  reviewSupportDraft,
  SUPPORT_JUDGE_EFFORT,
  type DraftLine,
  type MissingLine,
  type HybridTurn,
  type SupportDraft,
  UNDERSTAND_INSTRUCTIONS,
  understandSupportMessage,
  wholeGuide,
} from '@/services/support/hybrid.service'
import * as hybridModule from '@/services/support/hybrid.service'
import * as textsModule from '@/services/support/texts'
import { loadSupportLibrary, sourceRef, type HelpApp, type LibraryGuide } from '@/services/support/knowledge.service'
import logger from '@/config/logger'
import { aiInput } from '@tests/__helpers__/supportAiInput'
import {
  SUPPORT_CLARIFY,
  SUPPORT_CLARIFY_CLOSE,
  SUPPORT_CLARIFY_CLOSE_MANUAL,
  SUPPORT_CLARIFY_OPEN_GUIDE,
  SUPPORT_GREETING,
  SUPPORT_GUIDE_TOO_LONG,
  SUPPORT_GUIDE_TOO_LONG_MANUAL,
  SUPPORT_HANDOFF_OFFER,
  SUPPORT_DRAFT_CAP,
  SUPPORT_HYBRID_UNKNOWN,
  SUPPORT_LINK,
  SUPPORT_LITERAL_CAP,
  SUPPORT_OFF_TOPIC,
  SUPPORT_REPHRASE,
  SUPPORT_SEND_RETRY_NOTICE,
  SUPPORT_THANKS,
  supportLongAnswerMark,
  supportManualSource,
  supportOldVersion,
  supportTextCap,
} from '@/services/support/texts'

const guide = (id: string, app: HelpApp, body: string, extra: Partial<LibraryGuide> = {}): LibraryGuide => {
  const general = id.startsWith('general/')
  return {
    id,
    app,
    title: `Guía ${id}`,
    summary: `Resumen de ${id}.`,
    steps: [`Paso uno de ${id}.`, `Paso dos de ${id}.`],
    publicUrl: general ? 'https://avoqado.io/help' : `https://avoqado.io/help/${id}`,
    requiredPermissions: [],
    keywords: [],
    body,
    general,
    internal: false,
    hash: 'a'.repeat(64),
    ...extra,
  }
}
const PRODUCTS_BODY = `# Gestionar productos

## Pasos
1. Entra a **Menú > Productos** en el panel.
2. Pulsa *Nuevo producto* y escribe el nombre y el precio.
3. Guarda con el botón **Guardar**; el producto aparece en tu menú.

No puedes borrar un producto que tiene ventas; archívalo desde la lista.`
const BRANCH_BODY = `# Cambiar de sucursal

Abre el selector que está arriba a la izquierda y elige tu sucursal. El cambio se aplica al momento.`
const OVERVIEW_BODY = `# Qué es Avoqado

Avoqado es una plataforma para negocios que cobran en persona: punto de venta, terminal, inventario y reportes.`

const products = guide('dashboard/menu/gestionar-productos', 'dashboard', PRODUCTS_BODY, { requiredPermissions: ['menu:update'] })
const branch = guide('dashboard/inicio/cambiar-de-sucursal', 'dashboard', BRANCH_BODY)
const overview = guide('general/overview', 'dashboard', OVERVIEW_BODY)
const guides = [products, branch]

const line = (g: LibraryGuide, quote: string, text = 'Texto de prueba.'): DraftLine => ({ text, guideId: g.id, quote })
const okIntro = line(products, 'Entra a Menú > Productos en el panel', 'Entra al menú de productos.')
const okStep = line(
  products,
  'Pulsa Nuevo producto y escribe el nombre y el precio',
  'Pulsa *Nuevo producto* y llena el nombre y el precio.',
)
const draftOf = (over: Partial<SupportDraft> = {}): SupportDraft => ({ covered: true, intro: okIntro, steps: [okStep], ...over })
const reason = (draft: SupportDraft, library = guides) => {
  const result = reviewSupportDraft(draft, library)
  return result.ok ? 'ok' : result.reason
}

describe('reviewSupportDraft', () => {
  it('accepts a draft whose quotes are in the guides', () => {
    expect(reviewSupportDraft(draftOf(), guides)).toEqual({ ok: true })
    expect(reviewSupportDraft(draftOf({ intro: null }), guides)).toEqual({ ok: true })
  })

  it('accepts a quote that differs only in accents, case, spaces and **bold**', () => {
    const variants = [
      'ENTRA A MENÚ > PRODUCTOS EN EL PANEL', // case
      'entra a menu > productos en el panel', // accents
      'Entra   a\nMenú  >  Productos en   el panel', // spaces and newlines
      'Entra a **Menú > Productos** en el panel', // as written in the guide
      'Entra a _Menú_ `>` #Productos en el panel', // markdown marks the guide does not have
    ]
    for (const quote of variants) expect(reason(draftOf({ intro: line(products, quote) }))).toBe('ok')
    // accents the guide does not have, and accents the guide has but the quote lacks
    expect(reason(draftOf({ intro: line(branch, 'Ábrè el sélector qué está arriba a la izquierda') }))).toBe('ok')
    expect(reason(draftOf({ intro: line(branch, 'Abre el selector que esta arriba a la izquierda') }))).toBe('ok')
  })

  it('rejects a quote with one extra word', () => {
    expect(reason(draftOf({ intro: line(products, 'Entra a Menú > Productos en el nuevo panel') }))).toBe('quote')
    expect(reason(draftOf({ steps: [line(products, 'Pulsa Nuevo producto y escribe el nombre, el precio y la foto')] }))).toBe('quote')
  })

  it('rejects an intro whose quote is not in the guide', () => {
    const intro = line(products, 'Tu dinero llegará mañana a tu cuenta', 'Tu dinero llegará mañana.')
    expect(reason(draftOf({ intro }))).toBe('quote')
  })

  it('rejects a quote shorter than 12 characters, even if it is in the guide', () => {
    expect(reason(draftOf({ steps: [line(products, 'el nombre')] }))).toBe('quote')
    expect(reason(draftOf({ steps: [line(products, '  Guardar  ')] }))).toBe('quote')
    expect(reason(draftOf({ steps: [line(products, 'Nuevo producto')] }))).toBe('ok')
  })

  it('checks the quote against the guide it names, not against any guide', () => {
    expect(reason(draftOf({ steps: [line(branch, 'Entra a Menú > Productos en el panel')] }))).toBe('quote')
  })

  it('rejects a step citing a guide not given', () => {
    const outside = line(overview, 'Avoqado es una plataforma para negocios')
    expect(reason(draftOf({ steps: [okStep, outside] }))).toBe('guide')
    expect(reason(draftOf({ intro: outside }))).toBe('guide')
    expect(reason(draftOf({ steps: [{ ...okStep, guideId: 'dashboard/privado/otra' }] }))).toBe('guide')
  })

  it('a covered draft without steps is empty; so is one that is not covered', () => {
    expect(reason(draftOf({ steps: [] }))).toBe('empty')
    expect(reason(draftOf({ covered: false, intro: null, steps: [] }))).toBe('empty')
    expect(reason(draftOf({ covered: false }))).toBe('empty')
  })

  it('rejects a *term* that is not in any guide, and accepts one that is', () => {
    const bad = line(products, 'Pulsa Nuevo producto y escribe el nombre y el precio', 'Entra a *Ventas > Reembolsos* y elige la venta.')
    expect(reason(draftOf({ steps: [bad] }))).toBe('term')
    expect(reason(draftOf({ intro: { ...okIntro, text: 'Abre *Ventas > Reembolsos* primero.' } }))).toBe('term')
    // present, whatever its accents/case/bold in the guide
    expect(reason(draftOf({ steps: [{ ...okStep, text: 'Entra a *menu > productos* y pulsa *Nuevo Producto*.' }] }))).toBe('ok')
    // a term that is in the OTHER guide is fine too ("alguna guía")
    expect(reason(draftOf({ steps: [{ ...okStep, text: 'Antes elige tu *sucursal* arriba.' }] }))).toBe('ok')
    // double asterisks hold a term too
    expect(reason(draftOf({ steps: [{ ...okStep, text: 'Pulsa **Guardar** al final.' }] }))).toBe('ok')
    expect(reason(draftOf({ steps: [{ ...okStep, text: 'Pulsa **Cobrar ya** al final.' }] }))).toBe('term')
    // a lone asterisk is not a term
    expect(reason(draftOf({ steps: [{ ...okStep, text: 'Campo obligatorio * revisa el precio.' }] }))).toBe('ok')
  })

  it('a term must match as whole words, not as part of another word', () => {
    const term = (text: string) => reason(draftOf({ steps: [{ ...okStep, text }] }))
    // "pro" is only inside "productos"; "ventas" is a whole word in "tiene ventas"
    expect(term('Disponible en el plan *Pro* del negocio.')).toBe('term')
    expect(term('Revisa *product* en la lista.')).toBe('term')
    expect(term('Revisa *Productos* en la lista.')).toBe('ok')
    expect(term('Mira lo que *tiene ventas* en la lista.')).toBe('ok')
    expect(term('Pulsa *Nuevo producto* ahora.')).toBe('ok')
    expect(term('Pulsa *Nuevo product* ahora.')).toBe('term')
  })

  it('_x_, ~x~ and `x` spans are terms too, and a snake_case word is not', () => {
    const term = (text: string) => reason(draftOf({ steps: [{ ...okStep, text }] }))
    expect(term('Entra a _Ventas > Reembolsos_ y elige la venta.')).toBe('term')
    expect(term('Entra a ~Ventas > Reembolsos~ y elige la venta.')).toBe('term')
    expect(term('Entra a `Ventas > Reembolsos` y elige la venta.')).toBe('term')
    expect(term('Entra a _Menú > Productos_ y pulsa `Nuevo producto`.')).toBe('ok')
    expect(term('Pulsa ~Guardar~ al final.')).toBe('ok')
    expect(term('Usa el campo nombre_del_producto sin cambiarlo.')).toBe('ok')
  })

  it('treats typographic quotes, dashes, ellipses and arrows as their ASCII twins in the quote and in the guide', () => {
    const typographic = guide(
      'dashboard/menu/tipografia',
      'dashboard',
      'Pulsa el botón “Guardar” — después espera… y revisa ›Ventas› en la «lista» de l’inicio – siempre.',
    )
    const check = (quote: string) => reason(draftOf({ intro: null, steps: [line(typographic, quote)] }), [typographic])
    expect(check('Pulsa el botón "Guardar" - después espera... y revisa >Ventas> en la "lista" de l\'inicio - siempre.')).toBe('ok')
    expect(check('Pulsa el botón “Guardar” — después espera… y revisa ›Ventas› en la «lista» de l’inicio – siempre.')).toBe('ok')
    expect(check('Pulsa el botón "Cancelar" - después espera')).toBe('quote')
    // and the other way round: the guide has ASCII, the quote is typographic
    expect(reason(draftOf({ intro: line(products, 'Entra a **Menú › Productos** en el panel') }))).toBe('ok')
    const ascii = guide('dashboard/menu/ascii', 'dashboard', 'Pulsa "Guardar" - despues espera... y listo.')
    expect(reason(draftOf({ intro: null, steps: [line(ascii, '“Guardar” — despues espera… y listo')] }), [ascii])).toBe('ok')
  })

  it.each([
    ['a URL', 'Mira https://avoqado.io/help para más.'],
    ['a URL in capitals', 'Mira HTTPS://AVOQADO.IO/help para más.'],
    ['a www address', 'Mira www.avoqado.io para más.'],
    ['an email', 'Escribe a soporte@avoqado.io para más.'],
    ['a phone', 'Llama al 5512345678 para más.'],
    ['a phone with country code', 'Llama al +52 5512345 para más.'],
    ['a phone with country code and spaces', 'Llama al +52 55 1234 5678 para más.'],
    ['a phone with dashes', 'Llama al 55-1234-5678 para más.'],
    ['a phone with parentheses', 'Llama al (55) 1234 5678 para más.'],
    ['a phone with dots', 'Llama al 55.1234.5678 para más.'],
    ['a bare domain with a path', 'Entra a avoqado.io/help/pagos para más.'],
    ['a bare domain', 'Escribe en soporte.avoqado.mx para más.'],
    ['a bare .com domain in capitals', 'Entra a AVOQADO.COM para más.'],
  ])('rejects %s in the intro or in a step', (_name, text) => {
    expect(reason(draftOf({ intro: { ...okIntro, text } }))).toBe('contact')
    expect(reason(draftOf({ steps: [{ ...okStep, text }] }))).toBe('contact')
  })

  it('ordinary text is not taken for a contact', () => {
    for (const text of [
      'Pulsa Guardar. Después espera el aviso.',
      'Elige 2 o 3 productos y pulsa el botón.',
      'Escribe el folio 123456 en la caja.',
      'Abre Menú > Productos y espera un momento.',
    ])
      expect(reason(draftOf({ steps: [{ ...okStep, text }] }))).toBe('ok')
  })

  it('6 digits are fine, 7 are not; the quote is not checked for contacts', () => {
    expect(reason(draftOf({ steps: [{ ...okStep, text: 'Escribe el folio 123456 en la caja.' }] }))).toBe('ok')
    expect(reason(draftOf({ steps: [{ ...okStep, text: 'Escribe el folio 1234567 en la caja.' }] }))).toBe('contact')
    const withUrl = guide('dashboard/menu/con-enlace', 'dashboard', 'Consulta https://avoqado.io/help/ejemplo y revisa el panel.')
    const cited = line(withUrl, 'Consulta https://avoqado.io/help/ejemplo y revisa el panel', 'Revisa el panel.')
    expect(reason(draftOf({ intro: null, steps: [cited] }), [withUrl])).toBe('ok')
  })

  it('reviews what is shown: control and zero-width characters cannot hide a contact, a term or the length', () => {
    const bad = (text: string) => reason(draftOf({ steps: [{ ...okStep, text }] }))
    expect(bad('Llama al 5512\u200b345678 para más.')).toBe('contact')
    expect(bad('Llama al 55\u200d12\u200b34\u200c56\u200278 para más.')).toBe('contact')
    expect(bad('Entra a ht\u0001tps://x.io para más.')).toBe('contact')
    expect(bad('Llama al ５５１２３４５６７８ para más.')).toBe('contact') // full-width digits
    expect(bad('Entra a ｗｗｗ.avoqado.io para más.')).toBe('contact') // full-width letters
    expect(bad('Escribe a soporte\u200b@avoqado.io')).toBe('contact')
    expect(bad('Entra a *Reem\u200bbolsos* primero.')).toBe('term')
    expect(bad('Pulsa *Nuevo\u200b producto* ahora.')).toBe('ok')
    expect(bad(`${'a'.repeat(220)}${'\u200b'.repeat(10)}  `)).toBe('ok')
    expect(bad(`${'a'.repeat(110)}\n\n\n${'a'.repeat(109)}`)).toBe('ok')
  })

  it('rejects an intro over 280 characters or a step over 220', () => {
    const text = (n: number) => 'a'.repeat(n)
    expect(reason(draftOf({ intro: { ...okIntro, text: text(280) } }))).toBe('ok')
    expect(reason(draftOf({ intro: { ...okIntro, text: text(281) } }))).toBe('length')
    expect(reason(draftOf({ steps: [{ ...okStep, text: text(220) }] }))).toBe('ok')
    expect(reason(draftOf({ steps: [{ ...okStep, text: text(221) }] }))).toBe('length')
  })

  it('reports the first failing rule in the documented order', () => {
    const bad = (over: Partial<DraftLine>): DraftLine => ({
      text: `https://x.io $999 😀 ${'a'.repeat(300)} *Inventado*`,
      guideId: 'dashboard/privado/otra',
      quote: 'nada de esto existe',
      ...over,
    })
    expect(reason({ covered: true, intro: bad({}), steps: [] })).toBe('empty')
    expect(reason({ covered: true, intro: bad({}), steps: [okStep] })).toBe('guide')
    expect(reason({ covered: true, intro: bad({ guideId: products.id }), steps: [okStep] })).toBe('quote')
    const quoted = bad({ guideId: products.id, quote: 'Entra a Menú > Productos en el panel' })
    expect(reason({ covered: true, intro: quoted, steps: [okStep] })).toBe('term')
    const noTerm = { ...quoted, text: quoted.text.replace('*Inventado*', '') }
    expect(reason({ covered: true, intro: noTerm, steps: [okStep] })).toBe('contact')
    const noContact = { ...noTerm, text: noTerm.text.replace('https://x.io ', '') }
    expect(reason({ covered: true, intro: noContact, steps: [okStep] })).toBe('price')
    const noPrice = { ...noContact, text: noContact.text.replace('$999 ', '') }
    expect(reason({ covered: true, intro: noPrice, steps: [okStep] })).toBe('emoji')
    expect(reason({ covered: true, intro: { ...noTerm, text: 'a'.repeat(300) }, steps: [okStep] })).toBe('length')
  })

  it('a price must say «+ IVA»: never a bare amount, a total or «IVA incluido»', () => {
    const price = (text: string) => reason(draftOf({ steps: [{ ...okStep, text }] }))
    expect(price('El plan Pro cuesta $999 al mes.')).toBe('price')
    expect(price('El plan Pro cuesta $ 999 al mes.')).toBe('price')
    expect(price('El plan Pro cuesta $999, IVA incluido.')).toBe('price')
    expect(price('El plan Pro cuesta $1,158.84 al mes.')).toBe('price')
    expect(price('El plan Pro cuesta ＄999 al mes.')).toBe('price') // full-width dollar
    expect(price('El plan Pro cuesta $999 al mes + IVA.')).toBe('ok')
    expect(price('El plan Pro cuesta $999 al mes +IVA')).toBe('ok')
    expect(price('El plan Pro cuesta $999 al mes + iva.')).toBe('ok')
    expect(reason(draftOf({ intro: { ...okIntro, text: 'Cuesta $999 al mes.' } }))).toBe('price')
    // no amount, no rule
    expect(price('Revisa el precio vigente en la página de precios.')).toBe('ok')
    // Codex código R1 #2: también «pesos» y «MXN», no sólo «$».
    expect(price('Cuesta 1,200 pesos al mes, sin permanencia.')).toBe('price')
    expect(price('El plan Pro cuesta 999 pesos al mes.')).toBe('price')
    expect(price('El plan Pro cuesta MXN 999 al mes.')).toBe('price')
    expect(price('El plan Pro cuesta 999 MXN al mes.')).toBe('price')
    expect(price('El plan Pro cuesta 999 pesos al mes + IVA.')).toBe('ok')
    expect(price('Elige 2 o 3 productos y pulsa el botón.')).toBe('ok')
  })

  it('rejects an emoji in the intro or in a step', () => {
    expect(reason(draftOf({ steps: [{ ...okStep, text: 'Pulsa *Nuevo producto* 👍' }] }))).toBe('emoji')
    expect(reason(draftOf({ intro: { ...okIntro, text: '¡Listo! ✅ Entra al menú.' } }))).toBe('emoji')
    expect(reason(draftOf({ steps: [{ ...okStep, text: 'Pulsa *Nuevo producto* → y guarda.' }] }))).toBe('ok')
  })
})

const fullAccess: HelpAccess = {
  permissions: ['menu:update', 'inventory:update'],
  features: { INVENTORY_TRACKING: { included: true, enabled: true } },
  activations: { trackInventory: true },
  fingerprint: 'x',
  role: 'MANAGER',
}
const emptyAccess: HelpAccess = { permissions: [], features: {}, activations: {}, fingerprint: 'y', role: 'MANAGER' }
const gated = guide('dashboard/inventario/contar', 'dashboard', 'Cuenta las piezas de cada producto y guarda el conteo en el panel.', {
  requiredPermissions: ['inventory:update'],
  featureCode: 'INVENTORY_TRACKING',
  gateKind: 'FEATURE',
  activationKey: 'trackInventory',
})
const WARNINGS = [
  'Para realizarlo, pide acceso a tu administrador.',
  'Esta función no está incluida en tu plan; consúltalo en el panel.',
  'Esta función está apagada; revísala con tu administrador en el panel.',
]

describe('renderSupportAnswer', () => {
  it('writes the intro, the numbered steps and the guide link, once per guide', () => {
    const steps = [
      okStep,
      line(products, 'Guarda con el botón Guardar', 'Guarda con *Guardar*.'),
      line(branch, 'Abre el selector que está arriba', 'Elige tu sucursal.'),
    ]
    const out = renderSupportAnswer(draftOf({ steps }), guides, fullAccess)
    expect(out).toBe(
      [
        'Entra al menú de productos.',
        '1. Pulsa *Nuevo producto* y llena el nombre y el precio.\n2. Guarda con *Guardar*.\n3. Elige tu sucursal.',
        `Guía: ${products.publicUrl}\nGuía: ${branch.publicUrl}`,
      ].join('\n\n'),
    )
  })

  it('a draft without an intro starts at the steps; a single step is a sentence, without «1.»', () => {
    expect(renderSupportAnswer(draftOf({ intro: null }), guides, fullAccess)).toBe(`${okStep.text}\n\nGuía: ${products.publicUrl}`)
  })

  it('adds the same access warnings as composeSupportAnswer', () => {
    for (const access of [null, emptyAccess, fullAccess]) {
      const expected = supportWarnings(gated, access)
      const composed = composeSupportAnswer([gated], access)
      const rendered = renderSupportAnswer(
        draftOf({ intro: null, steps: [line(gated, 'Cuenta las piezas de cada producto')] }),
        [gated],
        access,
      )!
      for (const w of expected.split('\n').filter(Boolean)) {
        expect(composed).toContain(w)
        expect(rendered).toContain(w)
      }
    }
    expect(supportWarnings(gated, null)).toBe('Ayuda pública: tus permisos y funciones pueden variar.')
    expect(supportWarnings(gated, emptyAccess).split('\n')).toEqual(WARNINGS)
    expect(supportWarnings(gated, fullAccess)).toBe('')
    const out = renderSupportAnswer(
      draftOf({ intro: null, steps: [line(gated, 'Cuenta las piezas de cada producto')] }),
      [gated],
      emptyAccess,
    )!
    expect(out.startsWith(`${WARNINGS.join('\n')}\n\nTexto de prueba.`)).toBe(true)
    expect(
      renderSupportAnswer(draftOf({ intro: null, steps: [line(gated, 'Cuenta las piezas de cada producto')] }), [gated], fullAccess),
    ).toBe(`Texto de prueba.\n\nGuía: ${gated.publicUrl}`)
  })

  it('warns once per distinct line when two guides share the same warning', () => {
    const out = renderSupportAnswer(draftOf({ steps: [okStep, line(branch, 'Abre el selector que está arriba')] }), guides, null)!
    expect(out.split('Ayuda pública: tus permisos y funciones pueden variar.').length).toBe(2)
  })

  it('does not repeat the general help link for two general guides', () => {
    const facturacion = guide(
      'general/facturacion-y-contabilidad',
      'dashboard',
      'Facturas y contabilidad en un solo lugar para tu negocio.',
    )
    const out = renderSupportAnswer(
      draftOf({
        intro: line(overview, 'Avoqado es una plataforma para negocios', 'Es una plataforma.'),
        steps: [line(facturacion, 'Facturas y contabilidad en un solo lugar', 'Factura desde el panel.')],
      }),
      [overview, facturacion],
      fullAccess,
    )!
    expect(out.match(/Guía: /g)).toHaveLength(1)
    expect(out).toContain('Guía: https://avoqado.io/help')
  })

  it('never renders a draft the review rejects', () => {
    const render = (over: Partial<SupportDraft>) => renderSupportAnswer(draftOf(over), guides, fullAccess)
    expect(render({ intro: { ...okIntro, quote: 'Tu dinero llegará mañana a tu cuenta' } })).toBeNull() // quote
    expect(render({ steps: [{ ...okStep, text: 'Llama al 5512\u200b345678 para más.' }] })).toBeNull() // contact hidden by a zero-width char
    expect(render({ steps: [{ ...okStep, text: 'Entra a ht\u0001tps://x.io' }] })).toBeNull() // contact hidden by a control char
    expect(render({ steps: [{ ...okStep, text: 'Entra a *Ventas > Reembolsos*.' }] })).toBeNull() // term
    expect(render({ steps: [{ ...okStep, text: 'a'.repeat(221) }] })).toBeNull() // length
    expect(render({ covered: false })).toBeNull()
    expect(render({})).not.toBeNull()
  })

  it('sends exactly the text the review checked: zero-width characters are dropped', () => {
    const out = renderSupportAnswer(
      draftOf({
        intro: { ...okIntro, text: 'Entra al\u200b menú\u00a0de\u2060 productos.' },
        steps: [{ ...okStep, text: 'Pulsa *Nuevo\u200b producto*\u0001 ahora.' }],
      }),
      guides,
      fullAccess,
    )
    expect(out).toBe(`Entra al menú de productos.\n\nPulsa *Nuevo producto* ahora.\n\nGuía: ${products.publicUrl}`)
  })

  it('sends the full-width-folded form of each line, the same string the review read, keeping Spanish ordinals', () => {
    const out = renderSupportAnswer(
      draftOf({ intro: null, steps: [{ ...okStep, text: 'Pulsa\u3000*Nuevo producto*\u3000ahora\u2026' }] }),
      guides,
      fullAccess,
    )
    expect(out).toBe(`Pulsa *Nuevo producto* ahora\u2026\n\nGuía: ${products.publicUrl}`)
    const folio = guide('dashboard/ventas/folio', 'dashboard', 'Escribe el Nº de folio en el 1º campo y revisa el Nº de ventas del día.')
    const step = line(folio, 'Escribe el Nº de folio en el 1º campo', 'Escribe el Nº de folio en el 1º campo; revisa el *Nº de ventas*.')
    expect(reason(draftOf({ intro: null, steps: [step] }), [folio])).toBe('ok')
    expect(renderSupportAnswer(draftOf({ intro: null, steps: [step] }), [folio], fullAccess)).toContain('el Nº de folio en el 1º campo')
  })

  it('collapses whitespace inside a line and strips control characters', () => {
    const out = renderSupportAnswer(
      draftOf({ intro: null, steps: [{ ...okStep, text: 'Pulsa\n  *Nuevo producto*\u0007 ahora.' }] }),
      guides,
      fullAccess,
    )
    expect(out).toBe(`Pulsa *Nuevo producto* ahora.\n\nGuía: ${products.publicUrl}`)
  })

  it('invites to link a personal WhatsApp under the same rule as composeVerifiedGuides, only if it fits', () => {
    const keep = process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    try {
      const gatedDraft = draftOf({ intro: null }) // cites products, which needs menu:update
      const plain = draftOf({ intro: null, steps: [line(branch, 'Abre el selector que está arriba')] })
      process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
      expect(composeSupportAnswer([products], null)).toContain(SUPPORT_LINK)
      expect(renderSupportAnswer(gatedDraft, guides, null)).toBe(
        `${supportWarnings(products, null)}\n\n${okStep.text}\n\nGuía: ${products.publicUrl}\n\n${SUPPORT_LINK}`,
      )
      // with access, or no guide with permissions: no invitation (same as composeSupportAnswer)
      expect(renderSupportAnswer(gatedDraft, guides, fullAccess)).not.toContain(SUPPORT_LINK)
      expect(composeSupportAnswer([branch], null)).not.toContain(SUPPORT_LINK)
      expect(renderSupportAnswer(plain, guides, null)).not.toContain(SUPPORT_LINK)
      // it is the last thing to fit: an answer 10 characters short of 1,500 goes without it, never cut
      const long = (last: number) =>
        draftOf({
          intro: { ...okIntro, text: 'y'.repeat(280) },
          steps: [...Array.from({ length: 4 }, () => ({ ...okStep, text: 'x'.repeat(220) })), { ...okStep, text: 'z'.repeat(last) }],
        })
      process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'false'
      const last = 1 + 1490 - renderSupportAnswer(long(1), guides, null)!.length
      const bare = renderSupportAnswer(long(last), guides, null)!
      expect(bare).toHaveLength(1490)
      process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
      expect(renderSupportAnswer(long(last), guides, null)).toBe(bare)
      process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'false'
      expect(renderSupportAnswer(gatedDraft, guides, null)).not.toContain(SUPPORT_LINK)
    } finally {
      if (keep === undefined) delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
      else process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = keep
    }
  })

  describe('tone with one step (texts of exam r6)', () => {
    // Intro and single step exactly as the exam drafted them (scripts/support-eval/resultado-hibrido-r6.json).
    const R6: Record<string, [string | null, string]> = {
      c13: [
        'La terminal TPV permite cobrar con tarjeta, efectivo y transferencia.',
        'La terminal TPV permite cobrar con tarjeta, efectivo y transferencia.',
      ],
      c23: [
        'Si una receta no descuenta inventario, confirma que el producto tenga receta asignada y que sus ingredientes existan.',
        'Revisa que el producto tenga una receta asignada y que existan sus ingredientes.',
      ],
      c27: ['Valida el saldo, las reglas y la vigencia.', 'Revisa el saldo, las reglas y la vigencia del cliente.'],
      c12: [
        'Que aparezca pendiente significa que falta completar la activación.',
        'Sigue el flujo indicado para completar la activación o contacta a soporte con el identificador del dispositivo.',
      ],
      c02: ['Para agregarla, captura su correo correcto y asígnale un rol inicial.', 'Abre *Equipo > Miembros*.'],
      c28: [
        'Si la invitación no llega, escala el caso.',
        'Al escalar, comparte el correo, el rol esperado, la sucursal y una captura del perfil del miembro.',
      ],
      c03: [null, 'Usa recuperación de contraseña antes de pedir un nuevo usuario.'],
      c15: [null, 'El punto de venta funciona sin internet y sincroniza al reconectar.'],
      c18: [null, 'Confirma que el grupo de modificadores esté activo y asociado al producto correcto.'],
      c29: [null, 'Usa *Lista de espera* para dar seguimiento a clientes sin mesa confirmada.'],
    }
    // One guide that holds every line, so each line can cite itself.
    const r6 = guide('dashboard/ventas/examen-r6', 'dashboard', Object.values(R6).flat().filter(Boolean).join('\n'))
    const cite = (text: string) => line(r6, text.replace(/\*/g, ''), text)
    const render = (id: string) => {
      const [intro, step] = R6[id]
      return renderSupportAnswer(draftOf({ intro: intro ? cite(intro) : null, steps: [cite(step)] }), [r6], fullAccess)
    }
    const link = `Guía: ${r6.publicUrl}`

    it.each(['c13'])('%s: an intro that repeats the only step is dropped; the step goes as a sentence', id => {
      expect(render(id)).toBe(`${R6[id][1]}\n\n${link}`)
    })
    // T-F6 (Codex H1): an intro only goes when the step contains ALL of it, never because most of its words are there. c23 and
    // c27 used to go by word overlap; c23's intro carries the condition «Si una receta no descuenta inventario».
    it.each(['c12', 'c02', 'c28', 'c23', 'c27'])('%s: an intro that adds something stays, and the step has no «1.»', id => {
      expect(render(id)).toBe(`${R6[id][0]}\n\n${R6[id][1]}\n\n${link}`)
    })
    it.each(['c03', 'c15', 'c18', 'c29'])('%s: a single step without intro has no «1.»', id => {
      expect(render(id)).toBe(`${R6[id][1]}\n\n${link}`)
    })
    it('two or more steps are still numbered, and the intro stays even if it repeats one', () => {
      const [intro, step] = R6.c13
      const out = renderSupportAnswer(draftOf({ intro: cite(intro!), steps: [cite(step), cite(R6.c15[1])] }), [r6], fullAccess)
      expect(out).toBe(`${intro}\n\n1. ${step}\n2. ${R6.c15[1]}\n\n${link}`)
    })
  })

  it('returns null above 1,500 characters and fits exactly at the limit', () => {
    // valid lines only (<= 280 / <= 220): a long answer is a stack of full steps, tuned with the last one
    const build = (fullSteps: number, last: number) =>
      renderSupportAnswer(
        draftOf({
          intro: { ...okIntro, text: 'y'.repeat(280) },
          steps: [
            ...Array.from({ length: fullSteps }, () => ({ ...okStep, text: 'x'.repeat(220) })),
            { ...okStep, text: 'z'.repeat(last) },
          ],
        }),
        guides,
        null,
      )
    const fullSteps = [0, 1, 2, 3, 4, 5].find(n => build(n, 1) && 1500 - build(n, 1)!.length >= 0 && 1500 - build(n, 1)!.length < 220)!
    const room = 1500 - build(fullSteps, 1)!.length
    expect(build(fullSteps, 1 + room)).toHaveLength(1500)
    expect(build(fullSteps, 2 + room)).toBeNull()
    expect(build(5, 220)).toBeNull()
  })

  it('returns null for a draft that names an unknown guide, an unsafe guide, or has nothing to say', () => {
    expect(renderSupportAnswer(draftOf({ steps: [{ ...okStep, guideId: 'dashboard/privado/otra' }] }), guides, null)).toBeNull()
    const unsafe = { ...products, publicUrl: 'https://evil.example/help' }
    expect(renderSupportAnswer(draftOf(), [unsafe], fullAccess)).toBeNull()
    expect(renderSupportAnswer(draftOf({ intro: null, steps: [] }), guides, null)).toBeNull()
  })
})

describe('literalSupportAnswer', () => {
  const lineCount = (s: string) => s.split('\n').length
  // T-F5 (Codex r2-4): era la misma respuesta que composeSupportAnswer (sólo «## Pasos»). Ahora la guía va entera: sus
  // condiciones y advertencias viven fuera de los pasos. T-F6 (H3): composeSupportAnswer sigue la misma regla; una sección sin
  // `whole` (este fixture) sale como su tarjeta, nunca con sus pasos sueltos.
  it('is the whole guide, with the same title, warnings and link as composeSupportAnswer, which never prints steps alone', () => {
    for (const access of [null, emptyAccess, fullAccess]) {
      const warnings = supportWarnings(products, access)
      expect(literalSupportAnswer([products], access)).toBe(
        [products.title, warnings, wholeGuide(PRODUCTS_BODY), products.publicUrl].filter(Boolean).join('\n'),
      )
      expect(composeSupportAnswer([products], access)).toBe(
        [products.title, warnings, SUPPORT_GUIDE_TOO_LONG, products.publicUrl].filter(Boolean).join('\n'),
      )
      expect(literalSupportAnswer([products, gated], access, 'Aviso previo.')).toBe(
        [
          'Aviso previo.',
          [products.title, warnings, wholeGuide(PRODUCTS_BODY), products.publicUrl].filter(Boolean).join('\n'),
          [gated.title, supportWarnings(gated, access), wholeGuide(gated.body), gated.publicUrl].filter(Boolean).join('\n'),
        ].join('\n\n'),
      )
    }
    // Lo que «## Pasos» deja fuera también sale: aquí, que no se borra un producto con ventas.
    expect(literalSupportAnswer([products], null)).toContain('No puedes borrar un producto que tiene ventas; archívalo desde la lista.')
  })

  it('reads the guide as WhatsApp does: section titles and markdown bold in single asterisks', () => {
    expect(wholeGuide(PRODUCTS_BODY)).toBe(
      [
        '*Gestionar productos*',
        '',
        '*Pasos*',
        '1. Entra a *Menú > Productos* en el panel.',
        '2. Pulsa *Nuevo producto* y escribe el nombre y el precio.',
        '3. Guarda con el botón *Guardar*; el producto aparece en tu menú.',
        '',
        'No puedes borrar un producto que tiene ventas; archívalo desde la lista.',
      ].join('\n'),
    )
  })

  it('accepts general/* guides and always fits', () => {
    const out = literalSupportAnswer([overview], fullAccess)
    expect(out).toBe([overview.title, wholeGuide(OVERVIEW_BODY), 'https://avoqado.io/help'].join('\n'))
    expect(out.length).toBeLessThanOrEqual(1500)
    expect(out).not.toBe(SUPPORT_HYBRID_UNKNOWN)
  })

  it('shows at most 2 guides, one block per id', () => {
    const out = literalSupportAnswer([products, products, branch, overview], fullAccess)
    expect(out).toContain(products.title)
    expect(out).toContain(branch.title)
    expect(out).not.toContain(overview.title)
    expect(out.match(/https:\/\/avoqado\.io\/help\S*/g)).toHaveLength(2)
    // the 4 per-app copies of an overview are one guide
    const copies = (['dashboard', 'android', 'windows', 'tpv'] as HelpApp[]).map(app => guide('general/overview', app, OVERVIEW_BODY))
    expect(literalSupportAnswer(copies, fullAccess)).toBe(literalSupportAnswer([overview], fullAccess))
  })

  // T-F6 (Codex H3): lo que no cabe entero sale como tarjeta, nunca por su resumen (que también da instrucciones).
  // T-F10c: a guide too long for the literal is now one over SUPPORT_LITERAL_CAP (25 long steps, ~3,960), not over 1,500.
  it('shrinks the whole guides, then the first whole and the rest as cards, then cards only, never over the literal cap', () => {
    const wordy = (id: string) =>
      guide(id, 'dashboard', `## Pasos\n${Array.from({ length: 25 }, (_, i) => `${i + 1}. ${'paso largo '.repeat(14)}`).join('\n')}`, {
        summary: 'r'.repeat(450),
      })
    const card = (g: LibraryGuide) => [g.title, SUPPORT_GUIDE_TOO_LONG, g.publicUrl].join('\n')
    const [a, b] = [wordy('dashboard/menu/uno'), wordy('dashboard/menu/dos')]
    const one = literalSupportAnswer([a], fullAccess)
    expect(one).toBe(card(a))
    expect(one).not.toContain(a.summary)
    expect(one).not.toContain('paso largo')
    const two = literalSupportAnswer([a, b], fullAccess, 'n'.repeat(500))
    expect(two).toBe(['n'.repeat(500), card(a), card(b)].join('\n\n'))
    // The first one whole and the second as its card, when that fits and both whole do not.
    const short = guide(
      'dashboard/menu/corta',
      'dashboard',
      '## Pasos\n1. Abre el menú.\n\n## Problemas frecuentes\n- Si no aparece, revisa que esté activo.',
    )
    const mixed = literalSupportAnswer([short, a], fullAccess)
    expect(mixed).toBe([[short.title, wholeGuide(short.body), short.publicUrl].join('\n'), card(a)].join('\n\n'))
    expect(literalSupportAnswer([a, short], fullAccess)).toBe([card(a), card(short)].join('\n\n'))
  })

  it('puts the notice first and falls to the unknown text when nothing fits', () => {
    expect(literalSupportAnswer([branch], fullAccess, 'No pude redactarlo.').startsWith('No pude redactarlo.\n\n')).toBe(true)
    expect(literalSupportAnswer([branch], fullAccess, 'n'.repeat(SUPPORT_LITERAL_CAP))).toBe(SUPPORT_HYBRID_UNKNOWN)
  })

  it('never returns an empty string', () => {
    const unsafe = { ...products, publicUrl: 'https://evil.example/help' }
    for (const input of [[], [unsafe], [{ ...overview, publicUrl: 'https://evil.example' }], [{ ...products, id: 'x' }]]) {
      expect(literalSupportAnswer(input, null)).toBe(SUPPORT_HYBRID_UNKNOWN)
    }
    expect(lineCount(SUPPORT_HYBRID_UNKNOWN)).toBe(1)
    expect(SUPPORT_HYBRID_UNKNOWN).toBe(
      'No encontré eso en nuestras guías y prefiero no adivinar. Escríbenos a hola@avoqado.io y te ayudamos.',
    )
  })
})

const usage = { input_tokens: 400, output_tokens: 90, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }
function fakeClient(payload: unknown, status = 'completed') {
  const create = jest.fn(async (_request: Record<string, unknown>) => ({
    status,
    usage,
    _request_id: 'req_fixture',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: typeof payload === 'string' ? payload : JSON.stringify(payload), annotations: [] }],
      },
    ],
  }))
  return { client: { responses: { create } } as unknown as OpenAI, create }
}
const sentInput = (create: jest.Mock) => JSON.parse(String(create.mock.calls[0][0].input))
const lineJson = (l: DraftLine) => ({ text: l.text, guideId: l.guideId, quote: l.quote })
const draftJson = (over: Record<string, unknown> = {}) => ({ covered: true, intro: lineJson(okIntro), steps: [lineJson(okStep)], ...over })

describe('draftSupportAnswer', () => {
  const run = (client: OpenAI, extra: Partial<Parameters<typeof draftSupportAnswer>[1]> = {}) =>
    draftSupportAnswer(client, { question: '¿Cómo agrego un producto?', guides, history: [], ...extra }, pricing)

  it('sends the guides with their bodies and asks for a strict JSON draft', async () => {
    const { client, create } = fakeClient(draftJson())
    const out = await run(client)
    expect(out).toEqual({ draft: draftJson(), usage, requestId: 'req_fixture', called: true })
    expect(create).toHaveBeenCalledTimes(1)
    const request = create.mock.calls[0][0] as Record<string, any>
    const input = sentInput(create)
    expect(input.question).toBe('¿Cómo agrego un producto?')
    expect(input.guides).toEqual([
      { id: products.id, title: products.title, body: PRODUCTS_BODY },
      { id: branch.id, title: branch.title, body: BRANCH_BODY },
    ])
    expect(request).toMatchObject({
      model: pricing.model,
      store: false,
      stream: false,
      background: false,
      max_output_tokens: 1000,
      service_tier: 'default',
      truncation: 'disabled',
      instructions: DRAFT_INSTRUCTIONS,
      text: { format: { type: 'json_schema', strict: true } },
    })
    for (const key of ['tools', 'previous_response_id', 'metadata', 'user']) expect(request).not.toHaveProperty(key)
    const schema = request.text.format.schema
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['covered', 'intro', 'steps'])
    // T-F5 (Codex r2-4): 6 cortaba «todos los pasos» y sus condiciones (4 + 3 + 2 en los sellos); el tope del texto sigue en 1,500.
    expect(schema.properties.steps.maxItems).toBe(12)
    const lineSchema = schema.properties.steps.items
    expect(lineSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['text', 'guideId', 'quote'] })
    expect(lineSchema.properties.guideId.enum).toEqual([products.id, branch.id])
    expect(schema.properties.intro.anyOf).toEqual([{ type: 'null' }, lineSchema])
  })

  it('sends each guide once even if the library repeats it per app', async () => {
    const { client, create } = fakeClient(draftJson({ intro: null, steps: [], covered: false }))
    const copies = (['dashboard', 'android'] as HelpApp[]).map(app => guide('general/overview', app, OVERVIEW_BODY))
    await run(client, { guides: copies })
    expect(sentInput(create).guides.map((g: { id: string }) => g.id)).toEqual(['general/overview'])
    expect((create.mock.calls[0][0] as any).text.format.schema.properties.steps.items.properties.guideId.enum).toEqual(['general/overview'])
  })

  it('accepts a null intro and a not-covered draft', async () => {
    const { client } = fakeClient({ covered: false, intro: null, steps: [] })
    expect((await run(client)).draft).toEqual({ covered: false, intro: null, steps: [] })
  })

  it('scrubs the question and the history like the understand step', async () => {
    const history: HybridTurn[] = [
      { role: 'user', text: 'mi contraseña: Secreta123' },
      { role: 'assistant', text: 'Escríbenos a hola@avoqado.io' },
      { role: 'user', text: 'quiero agregar un producto' },
    ]
    const { client, create } = fakeClient(draftJson())
    await run(client, { history })
    const sent = sentInput(create)
    expect(sent.history).toEqual([
      { role: 'assistant', text: 'Escríbenos a [dato omitido]' },
      { role: 'user', text: 'quiero agregar un producto' },
    ])
    expect(JSON.stringify(sent)).not.toMatch(/Secreta123|hola@avoqado\.io/)
  })

  it.each([
    ['a password', 'mi contraseña: Secreta123 ¿cómo agrego un producto?'],
    ['an email', 'escríbeme a juan@correo.com sobre productos'],
    ['an empty question', '   '],
    ['a question over 2,000 characters', 'hola '.repeat(500)],
  ])('a sensitive or empty question never calls the model (%s)', async (_name, question) => {
    const { client, create } = fakeClient(draftJson())
    expect(await run(client, { question })).toEqual({ draft: null, usage: null, requestId: undefined, called: false })
    expect(create).not.toHaveBeenCalled()
  })

  it('no guides never calls the model', async () => {
    const { client, create } = fakeClient(draftJson())
    expect(await run(client, { guides: [] })).toMatchObject({ draft: null, called: false })
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid JSON', 'esto no es json', 'completed'],
    ['a missing field', JSON.stringify({ covered: true, steps: [] }), 'completed'],
    ['an extra field', JSON.stringify({ ...draftJson(), answer: 'Ya cobré la tarjeta.' }), 'completed'],
    ['a line with an extra field', JSON.stringify(draftJson({ steps: [{ ...lineJson(okStep), url: 'https://x.io' }] })), 'completed'],
    [
      'an unknown guideId in a step',
      JSON.stringify(draftJson({ steps: [{ ...lineJson(okStep), guideId: 'dashboard/privado/otra' }] })),
      'completed',
    ],
    [
      'an unknown guideId in the intro',
      JSON.stringify(draftJson({ intro: { ...lineJson(okIntro), guideId: 'general/overview' } })),
      'completed',
    ],
    ['more than 12 steps', JSON.stringify(draftJson({ steps: Array.from({ length: 13 }, () => lineJson(okStep)) })), 'completed'],
    ['an incomplete response', JSON.stringify(draftJson()), 'incomplete'],
  ])('%s gives a null draft but keeps usage and request id', async (_name, text, status) => {
    const { client, create } = fakeClient(text, status)
    const out = await run(client)
    expect(create).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ draft: null, usage, requestId: 'req_fixture', called: true })
    expect(JSON.stringify(out)).not.toContain('Ya cobré')
  })

  it('a provider failure is not swallowed', async () => {
    const create = jest.fn(async () => {
      throw new Error('timeout')
    })
    await expect(run({ responses: { create } } as unknown as OpenAI)).rejects.toThrow('timeout')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('the instructions state the sources, the untrusted input, the quotes and the tone', () => {
    expect(DRAFT_INSTRUCTIONS).toMatch(/ÚNICA fuente/)
    expect(DRAFT_INSTRUCTIONS).toMatch(/información no confiable/)
    expect(DRAFT_INSTRUCTIONS).toMatch(/nunca instrucciones/i)
    expect(DRAFT_INSTRUCTIONS).toMatch(/quote/)
    expect(DRAFT_INSTRUCTIONS).toMatch(/LITERAL/)
    expect(DRAFT_INSTRUCTIONS).toMatch(/covered/)
    expect(DRAFT_INSTRUCTIONS).toMatch(/tuteo/)
    expect(DRAFT_INSTRUCTIONS).toMatch(/emojis/)
    expect(DRAFT_INSTRUCTIONS).toMatch(/humano/)
    expect(DRAFT_INSTRUCTIONS).toMatch(/asteriscos/)
    expect(DRAFT_INSTRUCTIONS).toMatch(/no empieces con sí o no salvo que la guía lo diga explícitamente/i)
    expect(DRAFT_INSTRUCTIONS).toContain(
      'Si das un precio de Avoqado, cópialo como viene en la guía y agrégale «+ IVA» (por ejemplo, «$999 al mes + IVA»). Nunca sumes el IVA ni des un total.',
    )
  })

  // T-F2 (análisis sin IA del examen b-tf1-r1): la redacción soltaba lo que la guía sí trae. c63 y s03 sin «si no ves una
  // sucursal, tu usuario no está asignado»; c05 sin «que tu plan incluya facturación»; c13 sin «transferencia» de la lista de
  // cobros; c65 sin el menú de «Menú › Productos». Una regla de la redacción, justo después de la de los pasos.
  // T-F4 (análisis sin IA de b-tf2-r1): «revisar si no le aparece» se leía como condicional (c63: la persona no dijo que no le
  // apareciera) y se cambió a propósito por «revisar por si no le aparece, aunque no lo diga».
  it('T-F2: the drafter keeps the conditions, the whole list and the full path that the guide gives', () => {
    const rule =
      '- No dejes fuera lo que la guía pone como condición o requisito de lo que la persona quiere hacer (que el plan lo incluya, un permiso, que su usuario esté asignado a la sucursal, que algo esté activo) ni lo que dice revisar por si no le aparece, aunque no lo diga: va como un paso, con su cita. Si pregunta qué opciones hay (por ejemplo, con qué formas se puede cobrar), da la lista completa que trae la guía. Escribe la ruta con el menú y la pantalla como la da la guía, no sólo la pantalla.'
    expect(DRAFT_INSTRUCTIONS).toContain(rule)
    const [steps, after] = DRAFT_INSTRUCTIONS.split(rule)
    expect(steps).toMatch(/- steps: .*no repitas en la intro lo que dicen los pasos\.\n$/)
    expect(after).toMatch(/^\n- Cada línea \(la intro y cada paso\) lleva guideId/)
  })

  // T-F4: el tope suave «casi siempre 2 a 4» se comía un paso o la condición (c05, c42, c27, s03). Ahora un «cómo» lleva todos
  // los pasos de la guía, y la condición va aparte, sin quitarle su lugar a un paso.
  it('T-F4: a how-to gets every step of the guide, and the condition never takes the place of a step', () => {
    expect(DRAFT_INSTRUCTIONS).not.toContain('casi siempre 2 a 4')
    expect(DRAFT_INSTRUCTIONS).toContain(
      'Usa sólo los pasos que contestan la duda, pero si pregunta cómo hacer algo, da todos los pasos de la guía hasta terminarlo, sin saltarte ninguno; la condición o el requisito de la regla siguiente va aparte y nunca le quita su lugar a un paso, y no repitas en la intro lo que dicen los pasos.\n',
    )
  })
})

// T-F8: what the judge reads of PRODUCTS_BODY: the same guide, each sentence with its line number; a heading has none. T-F10: it
// is the guide byte for byte with «[n] » inserted, and the judge's only copy.
const PRODUCTS_NUMBERED = `# Gestionar productos

## Pasos
[1] 1. Entra a **Menú > Productos** en el panel.
[2] 2. Pulsa *Nuevo producto* y escribe el nombre y el precio.
[3] 3. Guarda con el botón **Guardar**; el producto aparece en tu menú.

[4] No puedes borrar un producto que tiene ventas; archívalo desde la lista.`
describe('judgeSupportDraft', () => {
  const draft: SupportDraft = draftOf()
  const question = '¿Cómo agrego un producto?'
  const run = (client: OpenAI, input: Partial<Parameters<typeof judgeSupportDraft>[1]> = {}) =>
    judgeSupportDraft(client, { question, draft, guides, ...input }, pricing)

  it('sends the question, every line with its quote and the cited guides, and returns the verdict', async () => {
    for (const supported of [true, false]) {
      const { client, create } = fakeClient({ supported, missing: [] })
      expect(await run(client)).toEqual({ supported, missing: [], usage, requestId: 'req_fixture', called: true })
      const request = create.mock.calls[0][0] as Record<string, any>
      const input = sentInput(create)
      expect(input.question).toBe(question)
      expect(input.lines).toEqual([
        { part: 'intro', text: okIntro.text, guideId: okIntro.guideId, quote: okIntro.quote },
        { part: 'step', text: okStep.text, guideId: okStep.guideId, quote: okStep.quote },
      ])
      // only the guides the draft cites, ONE copy each (T-F10): the guide as it is with each sentence numbered as [n] (T-F8: what is
      // missing comes back as those numbers)
      expect(input.guides).toEqual([{ id: products.id, title: products.title, body: PRODUCTS_NUMBERED }])
      expect(PRODUCTS_NUMBERED.replace(/\[\d+\] /g, '')).toBe(PRODUCTS_BODY)
      expect(request).toMatchObject({
        model: pricing.model,
        store: false,
        stream: false,
        background: false,
        max_output_tokens: 800,
        service_tier: 'default',
        truncation: 'disabled',
        instructions: JUDGE_INSTRUCTIONS,
        text: { format: { type: 'json_schema', strict: true } },
      })
      expect(request.text.format.schema).toMatchObject({ additionalProperties: false, required: ['supported', 'missing'] })
    }
  })

  it('the judge reads the lines as the answer to the question: an elliptic "Sí, ..." gets the question as untrusted data', async () => {
    const elliptic = '¿El cambio de sucursal también cambia mis precios?'
    const ellipticDraft: SupportDraft = {
      covered: true,
      intro: line(branch, 'El cambio se aplica al momento', 'Sí, el cambio se aplica al momento.'),
      steps: [line(branch, 'Abre el selector que está arriba', 'Abre el selector de sucursal.')],
    }
    // the quote is true and the draft passes the fixed rules: only the judge can notice it does not answer the question
    expect(reason(ellipticDraft)).toBe('ok')
    const { client, create } = fakeClient({ supported: false })
    expect(await run(client, { question: elliptic, draft: ellipticDraft })).toMatchObject({ supported: false })
    const request = create.mock.calls[0][0] as Record<string, any>
    expect(sentInput(create).question).toBe(elliptic)
    expect(String(request.instructions)).not.toContain(elliptic)
    expect(request.instructions).toBe(JUDGE_INSTRUCTIONS)
    expect(JUDGE_INSTRUCTIONS).toMatch(/question/)
    expect(JUDGE_INSTRUCTIONS).toMatch(/como respuesta a `?question`?/)
    expect(JUDGE_INSTRUCTIONS).toMatch(/un sí\/no, o lo que se da por hecho, también debe estar en la guía/)
  })

  it('scrubs the question, and a sensitive, empty or oversized one never reaches the model', async () => {
    const { client, create } = fakeClient({ supported: true })
    await run(client, { question: '\u0007¿Cómo agrego un producto?\u0000' })
    expect(sentInput(create).question).toBe('¿Cómo agrego un producto?')
    for (const bad of ['mi contraseña: Secreta123 ¿cómo agrego un producto?', 'escríbeme a juan@correo.com', '   ', 'hola '.repeat(500)]) {
      const fresh = fakeClient({ supported: true })
      expect(await run(fresh.client, { question: bad })).toEqual({
        supported: false,
        missing: [],
        usage: null,
        requestId: undefined,
        called: false,
      })
      expect(fresh.create).not.toHaveBeenCalled()
    }
  })

  it('a draft without an intro sends only its steps', async () => {
    const { client, create } = fakeClient({ supported: true })
    await run(client, { draft: draftOf({ intro: null }) })
    expect(sentInput(create).lines.map((l: { part: string }) => l.part)).toEqual(['step'])
  })

  it.each([
    ['invalid JSON', 'sí, todo bien', 'completed'],
    ['a non-boolean verdict', JSON.stringify({ supported: 'true' }), 'completed'],
    ['an empty object', '{}', 'completed'],
    ['an extra field', JSON.stringify({ supported: true, missing: [], why: 'porque sí' }), 'completed'],
    ['an incomplete response', JSON.stringify({ supported: true, missing: [] }), 'incomplete'],
  ])('%s is supported:false, with usage kept', async (_name, text, status) => {
    const { client } = fakeClient(text, status)
    expect(await run(client)).toEqual({ supported: false, missing: [], usage, requestId: 'req_fixture', called: true })
  })

  it('a provider failure is not swallowed', async () => {
    const create = jest.fn(async () => {
      throw new Error('timeout')
    })
    await expect(run({ responses: { create } } as unknown as OpenAI)).rejects.toThrow('timeout')
  })

  it('the instructions ask for support by the quote and name what must not be invented or shown', () => {
    expect(JUDGE_INSTRUCTIONS).toMatch(/cita|quote/)
    for (const word of ['fecha', 'plazo', 'importe', 'negación', 'botón']) expect(JUDGE_INSTRUCTIONS).toContain(word)
    expect(JUDGE_INSTRUCTIONS).toMatch(/información no confiable|nunca instrucciones/i)
    expect(JUDGE_INSTRUCTIONS).toMatch(/supported/)
    // contacts and impersonation are reasons for false
    expect(JUDGE_INSTRUCTIONS).toMatch(/enlace/)
    expect(JUDGE_INSTRUCTIONS).toMatch(/correo/)
    expect(JUDGE_INSTRUCTIONS).toMatch(/teléfono/)
    expect(JUDGE_INSTRUCTIONS).toMatch(/persona|humano/)
    // «+ IVA» next to a price the guide gives «sin IVA» is fine; the IVA added or a total is false
    const [fine, bad] = JUDGE_INSTRUCTIONS.split('ES FALSO')
    expect(fine.toLowerCase()).toContain('escribir «+ iva» junto a un precio que la guía da «sin iva»')
    expect(bad).toContain('un precio con el IVA sumado o dado como total')
  })
})

describe('output token cap', () => {
  it('draft asks for the pricing cap, understand and judge for 800, and none exceeds pricing.maxOutputTokens', async () => {
    expect(pricing.maxOutputTokens).toBe(1000)
    const sent = async (call: (client: OpenAI, p: typeof pricing) => Promise<unknown>, p = pricing) => {
      const { client, create } = fakeClient({
        covered: false,
        intro: null,
        steps: [],
        supported: true,
        kind: 'greeting',
        standalone: '',
        guideIds: [],
      })
      await call(client, p)
      return (create.mock.calls[0][0] as Record<string, number>).max_output_tokens
    }
    const understand = (c: OpenAI, p: typeof pricing) =>
      understandSupportMessage(c, { message: '¿Cómo agrego un producto?', app: 'dashboard', history: [], library: guides }, p)
    const draftCall = (c: OpenAI, p: typeof pricing) =>
      draftSupportAnswer(c, { question: '¿Cómo agrego un producto?', guides, history: [] }, p)
    const judge = (c: OpenAI, p: typeof pricing) =>
      judgeSupportDraft(c, { question: '¿Cómo agrego un producto?', draft: draftOf(), guides }, p)
    expect(await sent(understand)).toBe(800)
    expect(await sent(draftCall)).toBe(1000)
    expect(await sent(judge)).toBe(800)
    // a pricing with a lower cap lowers every request: a draft can never come back above what parseSupportUsage accepts
    const small = { ...pricing, maxOutputTokens: 500 }
    for (const call of [understand, draftCall, judge]) expect(await sent(call, small)).toBeLessThanOrEqual(small.maxOutputTokens)
    expect(await sent(draftCall, small)).toBe(500)
    expect(await sent(understand, small)).toBe(500)
  })

  // T-F12b: the judge reasons with none in production (exam b-tf11-none: bar 2 at 94 %, the judge's p90 from ~5.9 s to 2.2 s, and
  // its mini exam still passes, 11/11 caught and 1/11 wrongly rejected). SUPPORT_JUDGE_EFFORT pins it in one place.
  it('reasoning effort per call: low to draft, none to judge (T-F12b), medium to understand', async () => {
    const effort = async (call: (client: OpenAI) => Promise<unknown>) => {
      const { client, create } = fakeClient({
        covered: false,
        intro: null,
        steps: [],
        supported: true,
        kind: 'greeting',
        standalone: '',
        guideIds: [],
      })
      await call(client)
      return (create.mock.calls[0][0] as { reasoning?: { effort?: string } }).reasoning?.effort
    }
    expect(
      await effort(c =>
        understandSupportMessage(c, { message: '¿Cómo agrego un producto?', app: 'dashboard', history: [], library: guides }, pricing),
      ),
    ).toBe('medium')
    expect(await effort(c => draftSupportAnswer(c, { question: '¿Cómo agrego un producto?', guides, history: [] }, pricing))).toBe('low')
    expect(await effort(c => judgeSupportDraft(c, { question: '¿Cómo agrego un producto?', draft: draftOf(), guides }, pricing))).toBe(
      'none',
    )
    expect(SUPPORT_JUDGE_EFFORT).toBe('none')
  })

  it('a response that did not complete logs its status and reason, never the user text', async () => {
    const warn = jest.spyOn(logger, 'warn')
    warn.mockClear()
    const create = jest.fn(async () => ({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage,
      _request_id: 'req_fixture',
      output: [],
    }))
    const client = { responses: { create } } as unknown as OpenAI
    const out = await draftSupportAnswer(client, { question: '¿Cómo agrego un producto secreto-de-prueba?', guides, history: [] }, pricing)
    expect(out).toEqual({ draft: null, usage, requestId: 'req_fixture', called: true })
    expect(warn).toHaveBeenCalledWith('Support AI response not completed', {
      call: 'support_answer_draft',
      status: 'incomplete',
      reason: 'max_output_tokens',
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secreto-de-prueba')
    // a completed response logs nothing
    warn.mockClear()
    await judgeSupportDraft(
      fakeClient({ supported: true, missing: [] }).client,
      { question: '¿Cómo agrego un producto?', draft: draftOf(), guides },
      pricing,
    )
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('called', () => {
  it('is true when a request was sent, even if the response is invalid or incomplete, and false when nothing was sent', async () => {
    const draftIn = { question: '¿Cómo agrego un producto?', guides, history: [] }
    const judgeIn = { question: '¿Cómo agrego un producto?', draft: draftOf(), guides }
    const understandIn = { message: '¿Cómo agrego un producto?', app: 'dashboard' as const, history: [], library: guides }
    for (const [payload, status] of [
      ['no es json', 'completed'],
      [JSON.stringify({ covered: false, intro: null, steps: [] }), 'incomplete'],
    ] as const) {
      const a = fakeClient(payload, status)
      expect((await draftSupportAnswer(a.client, draftIn, pricing)).called).toBe(true)
      const b = fakeClient(payload, status)
      expect((await judgeSupportDraft(b.client, judgeIn, pricing)).called).toBe(true)
      const c = fakeClient(payload, status)
      expect((await understandSupportMessage(c.client, understandIn, pricing)).called).toBe(true)
    }
    const idle = fakeClient({})
    expect((await draftSupportAnswer(idle.client, { ...draftIn, question: 'mi contraseña: Secreta123' }, pricing)).called).toBe(false)
    expect((await draftSupportAnswer(idle.client, { ...draftIn, guides: [] }, pricing)).called).toBe(false)
    expect((await judgeSupportDraft(idle.client, { ...judgeIn, question: 'hola '.repeat(500) }, pricing)).called).toBe(false)
    expect((await understandSupportMessage(idle.client, { ...understandIn, message: '   ' }, pricing)).called).toBe(false)
    expect((await understandSupportMessage(idle.client, { ...understandIn, library: [] }, pricing)).called).toBe(false)
    expect(idle.create).not.toHaveBeenCalled()
  })
})

// Las decisiones que comparten el worker y el examen (Task 7): extraídas del worker sin cambiar su comportamiento.
describe('hybrid chain decisions (worker and exam)', () => {
  const clarify = { body: 'saldo', answer: '¿Te refieres a alguna de estas?', sourceIds: ['#clarify', 'a@1', 'b@2'] }
  const answer = { body: 'cómo', answer: 'Así.', sourceIds: ['a@1'] }

  it('history is oldest first; two clarifications in a row are detected only on the newest two', () => {
    expect(hybridHistory([answer, clarify], guides).history).toEqual([
      { role: 'user', text: 'saldo' },
      { role: 'assistant', text: '¿Te refieres a alguna de estas?' },
      { role: 'user', text: 'cómo' },
      { role: 'assistant', text: 'Así.' },
    ])
    expect(hybridHistory([clarify, clarify], guides).clarifiedTwice).toBe(true)
    expect(hybridHistory([answer, clarify, clarify], guides).clarifiedTwice).toBe(false)
    expect(hybridHistory([{ ...answer, answer: null }], guides).history[1]).toEqual({ role: 'assistant', text: '' })
  })

  it('fixed replies: texts by kind, clarification with refs, a third one asks to rephrase; question and human are not fixed', () => {
    expect(hybridFixedReply({ kind: 'greeting' }, false, guides)).toEqual({ text: SUPPORT_GREETING, guides: [], sourceIds: [] })
    expect(hybridFixedReply({ kind: 'nonsense' }, false, guides)?.text).toBe(SUPPORT_REPHRASE)
    expect(hybridFixedReply({ kind: 'off_topic' }, false, guides)?.text).toBe(SUPPORT_OFF_TOPIC)
    expect(hybridFixedReply({ kind: 'unknown' }, false, guides)?.text).toBe(SUPPORT_HYBRID_UNKNOWN)
    const offered = hybridFixedReply({ kind: 'clarify', guideIds: [branch.id, products.id] }, false, guides)!
    expect(offered.guides).toEqual([branch, products])
    expect(offered.sourceIds).toEqual(['#clarify', `${branch.id}@aaaaaaaa`, `${products.id}@aaaaaaaa`])
    expect(hybridFixedReply({ kind: 'clarify', guideIds: [branch.id, products.id] }, true, guides)).toEqual({
      text: SUPPORT_REPHRASE,
      guides: [],
      sourceIds: [],
      fallback: 'clarify-repeat',
    })
    expect(hybridFixedReply({ kind: 'clarify', guideIds: [branch.id, 'falta/esta/guia'] }, false, guides)?.fallback).toBe(
      'clarify-too-long',
    )
    expect(hybridFixedReply({ kind: 'question', standalone: 'x', guideIds: [branch.id] }, false, guides)).toBeNull()
    expect(hybridFixedReply({ kind: 'human' }, false, guides)).toBeNull()
  })

  it('a greeting after an answer («gracias», «va») is thanked, not greeted again; the other kinds do not change', () => {
    expect(SUPPORT_THANKS).toBe('Con gusto. Si tienes otra duda, escríbela con tus palabras.')
    expect(hybridFixedReply({ kind: 'greeting' }, false, guides, true)).toEqual({ text: SUPPORT_THANKS, guides: [], sourceIds: [] })
    expect(hybridFixedReply({ kind: 'greeting' }, false, guides, false)?.text).toBe(SUPPORT_GREETING)
    expect(hybridFixedReply({ kind: 'nonsense' }, false, guides, true)?.text).toBe(SUPPORT_REPHRASE)
    expect(hybridFixedReply({ kind: 'off_topic' }, false, guides, true)?.text).toBe(SUPPORT_OFF_TOPIC)
    expect(hybridFixedReply({ kind: 'unknown' }, false, guides, true)?.text).toBe(SUPPORT_HYBRID_UNKNOWN)
  })

  it('understand is told that short acknowledgements are greetings', () => {
    expect(UNDERSTAND_INSTRUCTIONS).toContain('Los acuses cortos («ok», «va», «sale», «perfecto», «gracias», «listo») son greeting.')
  })

  it('draft outcome: invalid → literal, uncovered → unknown, review → literal, judge no → literal, else continue', () => {
    expect(hybridDraftGuides([products.id, branch.id, overview.id], [...guides, overview])).toEqual([products, branch])
    expect(hybridDraftOutcome(null, guides)).toEqual({ reply: 'literal', fallback: 'draft-invalid' })
    expect(hybridDraftOutcome(draftOf({ covered: false }), guides)).toEqual({ reply: 'unknown', fallback: 'uncovered' })
    expect(hybridDraftOutcome(draftOf({ steps: [line(products, 'esto no está en la guía de productos')] }), guides)).toEqual({
      reply: 'literal',
      fallback: 'review-quote',
    })
    expect(hybridDraftOutcome(draftOf(), guides)).toBeNull()
    expect(hybridDraftOutcome(draftOf(), guides, false)).toEqual({ reply: 'literal', fallback: 'judge-rejected' })
    expect(hybridDraftOutcome(draftOf(), guides, true)).toBeNull()
    // T-F13: the judge approves but gives a real line of the cited guide as missing: the literal guide, as a rejection.
    expect(hybridDraftOutcome(draftOf(), guides, true, [{ guideId: products.id, line: 4 }])).toEqual({
      reply: 'literal',
      fallback: 'judge-rejected',
    })
    expect(hybridFallback({ reply: 'literal' }, [products]).compose(null)).toBe(literalSupportAnswer([products], null))
    expect(hybridFallback({ reply: 'unknown' }, [products])).toMatchObject({ guides: [] })
    expect(hybridFallback({ reply: 'unknown' }, [products]).compose(null)).toBe(SUPPORT_HYBRID_UNKNOWN)
    expect(hybridAnswerText(draftOf(), guides, null)).toEqual({ text: renderSupportAnswer(draftOf(), guides, null) })
    // A guide whose link is not ours is never rendered: the literal answer (which also drops it) goes out.
    const unsafe = [{ ...products, publicUrl: 'https://otro.example/help' }, branch]
    expect(hybridAnswerText(draftOf(), unsafe, null)).toEqual({ text: literalSupportAnswer(unsafe, null), fallback: 'render' })
  })
})

describe('internal manual pages: cited by title, never by link (R1-08)', () => {
  const CASH_BODY = `# Abrir la caja

## Pasos
1. Toca **Caja** en el menú.
2. Escribe el fondo inicial y toca *Abrir caja*.`
  const cash = guide('android/caja/abrir-caja', 'android', CASH_BODY, {
    internal: true,
    publicUrl: '',
    title: 'Abrir la caja',
    summary: 'Abre la caja con el fondo del día.',
    steps: ['Toca Caja en el menú.', 'Escribe el fondo inicial y toca Abrir caja.'],
  })
  const source = supportManualSource('Abrir la caja')
  const noLink = (text: string) => expect(text).not.toMatch(/http|www\.|avoqado\.io/i)

  it('supportManualSource is the exact contract text', () => {
    expect(source).toBe('Fuente: manual de Avoqado · Abrir la caja')
  })

  it('rendered and literal answers from an internal page end with «Fuente: manual de Avoqado · <título>» and contain no http, www. or avoqado.io', () => {
    const draft = draftOf({
      intro: line(cash, 'Toca Caja en el menú', 'Entra a la caja.'),
      steps: [line(cash, 'Escribe el fondo inicial y toca Abrir caja', 'Escribe el fondo y toca *Abrir caja*.')],
    })
    for (const access of [null, fullAccess]) {
      const rendered = renderSupportAnswer(draft, [cash], access)!
      expect(rendered.endsWith(`\n\n${source}`)).toBe(true)
      expect(rendered).not.toContain('Guía:')
      noLink(rendered)
      expect(hybridAnswerText(draft, [cash], access)).toEqual({ text: rendered })
      const literal = literalSupportAnswer([cash], access)
      expect(literal).not.toBe(SUPPORT_HYBRID_UNKNOWN)
      expect(literal.endsWith(`\n${source}`)).toBe(true)
      expect(literal).toContain('1. Toca *Caja* en el menú.')
      noLink(literal)
    }
    // Con una pública al lado, cada una se cita a su manera.
    const mixed = renderSupportAnswer(
      draftOf({ intro: null, steps: [okStep, line(cash, 'Escribe el fondo inicial y toca Abrir caja', 'Escribe el fondo.')] }),
      [products, cash],
      fullAccess,
    )!
    expect(mixed.endsWith(`Guía: ${products.publicUrl}\n${source}`)).toBe(true)
  })

  it('an internal page with a link, or a public one without it, is never sent', () => {
    const draft = draftOf({ intro: null, steps: [line(cash, 'Escribe el fondo inicial y toca Abrir caja', 'Escribe el fondo.')] })
    const leaky = { ...cash, publicUrl: 'https://avoqado.io/help/android/caja/abrir-caja' }
    expect(renderSupportAnswer(draft, [leaky], fullAccess)).toBeNull()
    expect(literalSupportAnswer([leaky], fullAccess)).toBe(SUPPORT_HYBRID_UNKNOWN)
    const bare = { ...products, publicUrl: '' }
    expect(renderSupportAnswer(draftOf(), [bare], fullAccess)).toBeNull()
    expect(literalSupportAnswer([bare], fullAccess)).toBe(SUPPORT_HYBRID_UNKNOWN)
  })

  // T-F6c (Codex H3): the description of a guide is often an instruction without its conditions, so an option is its title (a
  // public one keeps its link, as the no-summary form always did; an internal one has none).
  it('a clarification shows each option by its title, never its description; an internal one has no link (T-F6c)', () => {
    const text = clarificationText([cash, branch])
    expect(text.split('\n').slice(0, 3)).toEqual([SUPPORT_CLARIFY, '• Abrir la caja', `• ${branch.title}: ${branch.publicUrl}`])
    expect(text).not.toContain(cash.summary)
    expect(text).not.toContain(branch.summary)
    expect(text).not.toContain('avoqado.io/help/android')
    // A long description no longer matters: it is never shown.
    expect(clarificationText([{ ...cash, summary: 'x'.repeat(3000) }, branch])).toBe(text)
  })

  // T-F6 (H3): el modo «sólo enlaces» es ahora la tarjeta: una interna dice que es larga y a quién escribir, con su fuente; una
  // pública, que es larga y su enlace.
  it('cards: an internal page says it is long with its «Fuente» line, a public one says it is long with its link (T1-c2, T-F6)', () => {
    // T-F5: the literal prints the whole body, so the long guide is its body now, not only its steps. T-F10c: over 3,500.
    const wordy = (id: string, extra: Partial<LibraryGuide> = {}) =>
      guide(id, 'android', `## Pasos\n${Array.from({ length: 25 }, (_, i) => `${i + 1}. ${'paso largo '.repeat(14)}`).join('\n')}`, {
        summary: 'r'.repeat(450),
        ...extra,
      })
    const manual = (id: string, title: string) => wordy(id, { internal: true, publicUrl: '', title })
    const [a, b] = [manual('android/caja/uno', 'Abrir la caja'), manual('android/caja/dos', 'Cerrar la caja')]
    const internalOnly = literalSupportAnswer([a, b], fullAccess, 'n'.repeat(500))
    expect(internalOnly).not.toContain(SUPPORT_GUIDE_TOO_LONG)
    expect(internalOnly).not.toContain(a.summary)
    expect(internalOnly).toBe(
      [
        'n'.repeat(500),
        `Abrir la caja\n${SUPPORT_GUIDE_TOO_LONG_MANUAL}\n${supportManualSource('Abrir la caja')}`,
        `Cerrar la caja\n${SUPPORT_GUIDE_TOO_LONG_MANUAL}\n${supportManualSource('Cerrar la caja')}`,
      ].join('\n\n'),
    )
    // T-F6c: the card of an internal page has no email and no link: it offers a person in the same chat.
    noLink(internalOnly)
    // Mezcla: la pública dice que es larga y da su enlace; la interna, a quién escribir y su fuente.
    const pub = wordy('dashboard/menu/tres')
    const mixed = literalSupportAnswer([pub, a], fullAccess, 'n'.repeat(500))
    expect(mixed).toBe(
      [
        'n'.repeat(500),
        `${pub.title}\n${SUPPORT_GUIDE_TOO_LONG}\n${pub.publicUrl}`,
        `Abrir la caja\n${SUPPORT_GUIDE_TOO_LONG_MANUAL}\n${supportManualSource('Abrir la caja')}`,
      ].join('\n\n'),
    )
    expect(literalSupportAnswer([pub, wordy('dashboard/menu/cuatro')], fullAccess, 'n'.repeat(500))).toContain(
      `${pub.title}\n${SUPPORT_GUIDE_TOO_LONG}\n${pub.publicUrl}\n\n`,
    )
  })

  // T-F6c: an internal guide has no public link to open, so its card offers what phase 1 already has: the PERSONA word, which
  // the router answers with the handoff in this same chat (an integration test sends the word the card shows).
  it('the card of an internal guide offers a person in the same chat with the PERSONA word, never the contact email (T-F6c)', () => {
    const long = guide(
      'android/caja/larga',
      'android',
      `## Pasos\n${Array.from({ length: 25 }, (_, i) => `${i + 1}. ${'paso largo '.repeat(14)}`).join('\n')}`,
      {
        internal: true,
        publicUrl: '',
        title: 'Cerrar la caja',
      },
    )
    const card = literalSupportAnswer([long], fullAccess)
    expect(card).toBe(`Cerrar la caja\n${SUPPORT_GUIDE_TOO_LONG_MANUAL}\n${supportManualSource('Cerrar la caja')}`)
    expect(SUPPORT_GUIDE_TOO_LONG_MANUAL).toBe(
      'Esta guía es larga para WhatsApp. Si quieres, te paso con una persona del equipo: escribe PERSONA.',
    )
    expect(card).not.toMatch(/hola@avoqado\.io/)
    // The public card, with its link, is the same as before.
    const pub = literalSupportAnswer([{ ...long, internal: false, publicUrl: 'https://avoqado.io/help/android/caja/larga' }], fullAccess)
    expect(pub).toBe(`Cerrar la caja\n${SUPPORT_GUIDE_TOO_LONG}\nhttps://avoqado.io/help/android/caja/larga`)
  })

  describe('clarification close (T1-m5)', () => {
    const withHybrid = (on: boolean, run: () => void) => {
      const keep = [process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED, process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED]
      process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = String(on)
      process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = String(on)
      try {
        run()
      } finally {
        for (const [i, key] of ['SUPPORT_WHATSAPP_FREE_TEXT_ENABLED', 'SUPPORT_WHATSAPP_HYBRID_ENABLED'].entries()) {
          if (keep[i] === undefined) delete process.env[key]
          else process.env[key] = keep[i]
        }
      }
    }
    const lastLine = (text: string) => text.split('\n').at(-1)

    it('with an internal option and the hybrid off it does not promise opening a guide', () => {
      withHybrid(false, () => {
        expect(lastLine(clarificationText([cash, branch]))).toBe(SUPPORT_CLARIFY_CLOSE_MANUAL)
        expect(lastLine(clarificationText([branch, cash]))).toBe(SUPPORT_CLARIFY_CLOSE_MANUAL)
        expect(clarificationText([cash, branch])).not.toContain('Abre la guía')
      })
    })

    it('with only public options and the hybrid off it is the text of today', () => {
      withHybrid(false, () => {
        expect(lastLine(clarificationText([branch, products]))).toBe(SUPPORT_CLARIFY_OPEN_GUIDE)
        expect(SUPPORT_CLARIFY_OPEN_GUIDE).toBe('Abre la guía que corresponda o escríbenos a hola@avoqado.io.')
      })
    })

    it('with the hybrid on it closes as before, internal option or not', () => {
      withHybrid(true, () => {
        expect(lastLine(clarificationText([cash, branch]))).toBe(SUPPORT_CLARIFY_CLOSE)
        expect(lastLine(clarificationText([branch, products]))).toBe(SUPPORT_CLARIFY_CLOSE)
      })
    })
  })
})

// T-F5 (Codex r2-4): «todos los pasos y la condición aparte» no cabía en 6 líneas y el respaldo literal sólo imprimía «## Pasos»:
// la repro real (sellos: 4 pasos en el panel, 3 en el POS, y sus dos condiciones) perdía «Estado del Programa en Activo» y «no
// agregues el cliente … ni lo intentes otra vez». Con la biblioteca real.
describe('a guide never goes out without its conditions (T-F5)', () => {
  const library = loadSupportLibrary({ allowDraft: true })
  const real = (id: string) => library.find(g => g.id === id)!
  const card = real('dashboard/clientes/configurar-tarjeta-de-sellos')
  const stamp = real('android/lealtad/sello-que-no-se-sumo')
  // hz:be99f328:D42: la condición de la guía cambió; antes «el *Estado del Programa* tiene que estar en *Activo*».
  // Codex r2 #2: la condición entera (con cliente, el tope del día y los puntos apagados), no sólo la excepción.
  const ACTIVE =
    'las ventas con cliente suman sello (hasta las *Visitas con sello por cliente al día*) aunque en *Clientes* › *Programa de Lealtad* el *Programa de Puntos* esté en *Inactivo*'
  const WARNING = 'no agregues el cliente desde esa pantalla ni lo intentes otra vez'
  const cite = (g: LibraryGuide, quote: string, text = quote): DraftLine => ({ text, guideId: g.id, quote })
  // Todos los pasos de las dos guías y sus dos condiciones: 9 líneas, cada una con su cita literal.
  const sellos: SupportDraft = {
    covered: true,
    intro: null,
    steps: [
      cite(card, 'En *Clientes* › *Tarjeta digital*, en *Tu programa de sellos*, prende *Tarjeta de sellos activa*.'),
      cite(card, 'Escribe los *Sellos para llenar la cartilla* y, en *Cómo se lee el premio*, el nombre del premio.'),
      cite(card, 'En *Qué se gana*, elige *Un producto gratis*, *Un porcentaje* o *Un monto fijo*.'),
      cite(card, 'Toca *Guardar programa*: sale «Programa de sellos guardado».'),
      cite(card, ACTIVE, `Con la tarjeta prendida, ${ACTIVE}.`),
      cite(stamp, 'Si a la venta le faltó el cliente, toca *Agregar cliente*, arriba a la derecha de esa pantalla.'),
      cite(stamp, 'Búscalo y tócalo. Si queda ligado, sale «Cliente agregado: …»'),
      cite(stamp, 'Revisa lo que dice esa pantalla sobre el sello'),
      cite(
        stamp,
        `«Cancelación pendiente», «¿Se cobró …?» o «La terminal sí cobró este pago…», o alguien declaró que no se cobró, ${WARNING}`,
        `Si aparece «Cobro sin confirmar» o «Cancelación pendiente», ${WARNING}.`,
      ),
    ],
  }

  it('the drafter states the cap the schema accepts', () => {
    expect(DRAFT_INSTRUCTIONS).toContain('- steps: de 1 a 12 pasos en el orden de la guía')
    // and keeps «todos los pasos» (T-F4)
    expect(DRAFT_INSTRUCTIONS).toContain('da todos los pasos de la guía hasta terminarlo, sin saltarte ninguno')
  })

  it("Codex's repro: every step of both guides and both conditions fit the schema, the review and 1,500, and go out", async () => {
    const { client } = fakeClient({ covered: true, intro: null, steps: sellos.steps.map(lineJson) })
    const { draft } = await draftSupportAnswer(
      client,
      { question: '¿Cómo configuro los sellos y agrego el cliente después de cobrar?', guides: [card, stamp], history: [] },
      pricing,
    )
    expect(draft).toEqual(sellos)
    expect(reviewSupportDraft(sellos, [card, stamp])).toEqual({ ok: true })
    const text = renderSupportAnswer(sellos, [card, stamp], null)!
    expect(text.length).toBeLessThanOrEqual(1500)
    expect(text).toContain(ACTIVE)
    expect(text).toContain(WARNING)
  })

  it("Codex's repro: the literal guide shows the steps of a guide only with its conditions, in both orders", () => {
    const first = literalSupportAnswer([card, stamp], null)
    expect(first).toContain(wholeGuide(card.body)) // its 4 steps and «Programa de Puntos … Inactivo»
    expect(first).toContain(ACTIVE)
    expect(first).not.toContain('toca *Agregar cliente*') // the POS guide goes as its card: no step without its warning
    expect(first).not.toContain(stamp.summary) // T-F6 (H3): nor its summary
    expect(first).toContain(`${stamp.title}\n${supportWarnings(stamp, null)}\n${SUPPORT_GUIDE_TOO_LONG_MANUAL}`)
    // T-F10c: up to 3,500 the POS guide (2,555) goes whole, so its step goes with its warning; the panel guide, second, as its card.
    const second = literalSupportAnswer([stamp, card], null)
    expect(second).toContain(wholeGuide(stamp.body))
    expect(second).toContain('toca *Agregar cliente*')
    expect(second).toContain(WARNING)
    expect(second).not.toContain('prende *Tarjeta de sellos activa*')
    // Alone, the POS guide goes whole with its warning (in 1,500 it went only as its card).
    const alone = literalSupportAnswer([stamp], null)
    expect(alone).toContain(wholeGuide(stamp.body))
    expect(alone).toContain(WARNING)
  })

  it('every guide of the real library, alone or in any pair: a block that shows a step shows the whole guide', () => {
    const guides = library.filter((g, i) => library.findIndex(o => o.id === g.id) === i)
    expect(guides.length).toBeGreaterThan(100)
    // The block of each guide in the literal: from its title to the next guide's title (titles are unique: library.test).
    const blocks = (text: string, shown: LibraryGuide[]) =>
      shown.map((g, i) => {
        const start = text.indexOf(`${g.title}\n`)
        const next = shown[i + 1] ? text.indexOf(`\n\n${shown[i + 1].title}\n`, start) : text.length
        return text.slice(start, next)
      })
    const leaks: string[] = []
    const check = (shown: LibraryGuide[]) => {
      const text = literalSupportAnswer(shown, null)
      expect(text.length).toBeLessThanOrEqual(SUPPORT_LITERAL_CAP)
      blocks(text, shown).forEach((block, i) => {
        const g = shown[i]
        // A guide without «## Pasos» has its summary as its only step: that one is not a step.
        const step = g.steps.some(st => st !== g.summary && (block.includes(st) || block.includes(wholeGuide(st))))
        if (step && !block.includes(wholeGuide(g.body))) leaks.push(shown.map(o => o.id).join(' + '))
      })
    }
    for (const a of guides) {
      check([a])
      for (const b of guides) if (b.id !== a.id) check([a, b])
    }
    expect(leaks).toEqual([])
  })
})

// T-F6: la lista completa de la pasada exhaustiva de Codex (codex-tf-exhaustiva.md), con la biblioteca real.
describe('T-F6: what the code writes never drops what the guide attaches (Codex exhaustive)', () => {
  const library = loadSupportLibrary({ allowDraft: true })
  const real = (id: string) => library.find(g => g.id === id)!
  const stamp = real('android/lealtad/sello-que-no-se-sumo')

  // H1: «Cuando diga "Venta sincronizada", toca Agregar cliente» se parecía al paso «Toca Agregar cliente» y se borraba.
  it('H1: an intro with a condition is never dropped because it looks like the only step (Venta sincronizada)', () => {
    const introQuote = stamp.body.split('\n').find(x => x.includes('espera a que esa pantalla diga'))!
    const actionQuote = stamp.body.split('\n').find(x => /^1\./.test(x))!
    const draft: SupportDraft = {
      covered: true,
      intro: { text: 'Cuando diga «Venta sincronizada», toca *Agregar cliente*.', guideId: stamp.id, quote: introQuote },
      steps: [{ text: 'Toca *Agregar cliente*.', guideId: stamp.id, quote: actionQuote }],
    }
    expect(reviewSupportDraft(draft, [stamp])).toEqual({ ok: true })
    const text = renderSupportAnswer(draft, [stamp], null)!
    expect(text).toContain('Cuando diga «Venta sincronizada», toca *Agregar cliente*.')
    expect(text).toContain('\n\nToca *Agregar cliente*.')
  })
  it('H1: an intro the step holds whole (punctuation and case aside) is still dropped', () => {
    const quote = stamp.body.split('\n').find(x => /^1\./.test(x))!
    const step = { text: 'Toca *Agregar cliente*, arriba a la derecha.', guideId: stamp.id, quote }
    const draft: SupportDraft = { covered: true, intro: { text: 'toca agregar cliente', guideId: stamp.id, quote }, steps: [step] }
    expect(renderSupportAnswer(draft, [stamp], null)).not.toContain('toca agregar cliente\n')
    expect(renderSupportAnswer(draft, [stamp], null)).toContain('Toca *Agregar cliente*, arriba a la derecha.')
  })
})

// T-F6 (Codex H2) puso en ES FALSO «un paso sin la condición o la advertencia que la guía le pone». T-F7 la mudó a missing (lo que
// falta se completa en vez de tirar la respuesta): su prueba, con el mismo sha256 de las demás reglas, está en «T-F7: the judge…».

// T-F6 (Codex H3): si una guía no cabe entera, su resumen tampoco sale: el resumen da instrucciones sin las advertencias de la guía
// («confírmalo para ajustar el inventario» sin «no repitas el conteo»). Sale su tarjeta: título, avisos de acceso, que es larga
// y su enlace (una interna, su fuente del manual).
describe('T-F6: a guide that does not fit whole goes as its card, never as summarised instructions (H3)', () => {
  const library = loadSupportLibrary({ allowDraft: true })
  const real = (id: string) => library.find(g => g.id === id)!
  const contar = real('android/inventario/contar-existencia')
  const cardOf = (g: LibraryGuide, access: HelpAccess | null) =>
    [
      g.title,
      supportWarnings(g, access),
      g.internal ? SUPPORT_GUIDE_TOO_LONG_MANUAL : SUPPORT_GUIDE_TOO_LONG,
      g.internal ? supportManualSource(g.title) : g.publicUrl,
    ]
      .filter(Boolean)
      .join('\n')

  it('the fixed texts', () => {
    expect(SUPPORT_GUIDE_TOO_LONG).toBe('Esta guía es larga para WhatsApp; ábrela para ver los pasos y advertencias.')
    expect(SUPPORT_GUIDE_TOO_LONG_MANUAL).toBe(
      'Esta guía es larga para WhatsApp. Si quieres, te paso con una persona del equipo: escribe PERSONA.',
    )
  })

  // T-F10c: Codex's repro did not fit whole in 1,500 and went as its card; up to 3,500 it goes whole, with the warning its summary
  // lacked («no repitas el conteo»), and still never as its summary. The card of a guide over the cap is pinned in «T-F10c».
  it("Codex's repro (contar-existencia): whole, with the warning «no repitas el conteo»; never the summary that says to confirm", () => {
    expect(wholeGuide(contar.body).length).toBeGreaterThan(1500)
    for (const access of [null, emptyAccess, fullAccess]) {
      const text = literalSupportAnswer([contar], access)
      expect(text).toBe(
        [contar.title, supportWarnings(contar, access), wholeGuide(contar.body), supportManualSource(contar.title)]
          .filter(Boolean)
          .join('\n'),
      )
      expect(text).toContain('no repitas el conteo')
      expect(text).not.toContain(contar.summary)
      expect(text).not.toContain('confírmalo para ajustar el inventario')
      expect(cardOf(contar, access)).not.toContain(contar.summary)
    }
  })

  it('every guide of the real library, alone or in any pair: each block is the whole guide or its card, never its summary', () => {
    const guides = library.filter((g, i) => library.findIndex(o => o.id === g.id) === i)
    const bad: string[] = []
    const check = (shown: LibraryGuide[]) => {
      const text = literalSupportAnswer(shown, null)
      const blocks = shown.map(g =>
        [g.title, supportWarnings(g, null), wholeGuide(g.body), g.internal ? supportManualSource(g.title) : g.publicUrl]
          .filter(Boolean)
          .join('\n'),
      )
      const cards = shown.map(g => cardOf(g, null))
      const fits = (kinds: ('whole' | 'card')[]) =>
        text === kinds.map((k, i) => (k === 'whole' ? blocks[i] : cards[i])).join('\n\n') ||
        text === `${kinds.map((k, i) => (k === 'whole' ? blocks[i] : cards[i])).join('\n\n')}\n\n${SUPPORT_LINK}`
      const shapes: ('whole' | 'card')[][] =
        shown.length === 1
          ? [['whole'], ['card']]
          : [
              ['whole', 'whole'],
              ['whole', 'card'],
              ['card', 'card'],
            ]
      if (!shapes.some(fits)) bad.push(shown.map(g => g.id).join(' + '))
      // A summary only shows up where the whole guide carries it.
      for (const g of shown) if (text.includes(g.summary) && !wholeGuide(g.body).includes(g.summary)) bad.push(`summary ${g.id}`)
    }
    for (const a of guides) {
      check([a])
      for (const b of guides) if (b.id !== a.id) check([a, b])
    }
    expect(bad).toEqual([])
  })

  it('composeSupportAnswer (hybrid off) follows the same rule: a verified section goes whole, or as its card; never its steps', () => {
    const { body: _body, general: _general, internal: _internal, hash: _hash, ...section } = products
    const card = [products.title, supportWarnings(products, null), SUPPORT_GUIDE_TOO_LONG, products.publicUrl].join('\n')
    expect(composeSupportAnswer([section], null)).toBe(card)
    expect(composeSupportAnswer([section], null)).not.toContain(products.steps[0])
    expect(composeSupportAnswer([section], null)).not.toContain(products.summary)
    const whole = wholeGuide(PRODUCTS_BODY)
    expect(composeSupportAnswer([{ ...section, whole }], null)).toBe(
      [products.title, supportWarnings(products, null), whole, products.publicUrl].join('\n'),
    )
  })
})

// T-F10c (ruling T-F10c, «lo seguro debe ser lo completo»): the literal guide goes WHOLE up to SUPPORT_LITERAL_CAP (3,500) instead
// of 1,500, where 66 of 138 guides went only as a card. Measured offline on the real library: alone, 135 of 138 go whole, also with
// the venue line, the resend notice and the old-version notice with the offer. Over the cap, the card as before. Drafted answers
// keep 1,500, or 2,000 with «Importante».
describe('T-F10c: the literal guide goes whole up to SUPPORT_LITERAL_CAP', () => {
  const library = loadSupportLibrary({ allowDraft: true })
  const unique = library.filter((g, i) => library.findIndex(o => o.id === g.id) === i)
  const real = (id: string) => library.find(g => g.id === id)!
  const source = (g: LibraryGuide) => (g.internal ? supportManualSource(g.title) : g.publicUrl)
  const whole = (g: LibraryGuide, access: HelpAccess | null = null) =>
    [g.title, supportWarnings(g, access), wholeGuide(g.body), source(g)].filter(Boolean).join('\n')
  const card = (g: LibraryGuide, access: HelpAccess | null = null) =>
    [g.title, supportWarnings(g, access), g.internal ? SUPPORT_GUIDE_TOO_LONG_MANUAL : SUPPORT_GUIDE_TOO_LONG, source(g)]
      .filter(Boolean)
      .join('\n')
  // 2,868 whole: the longest real guide under the cap.
  const liga = real('dashboard/ventas/crear-liga-pago')
  const sucursal = real('dashboard/inicio/cambiar-sucursal')
  const over = [
    'general/facturacion-y-contabilidad',
    'dashboard/configuracion/conectar-avoqado-con-claude-o-chatgpt',
    'general/overview',
  ].map(real)
  const OLD = `${supportOldVersion('2.25.10')}\n\n${SUPPORT_HANDOFF_OFFER}`

  // T-F13: the 2,000 of T-F8.3 for an answer with «Importante» is gone with the block: a drafted answer is 1,500 everywhere.
  it('the caps: the literal 3,500, with room under WhatsApp 4,096; a drafted answer 1,500, whatever it says', () => {
    expect(SUPPORT_LITERAL_CAP).toBe(3500)
    expect(SUPPORT_LITERAL_CAP).toBeLessThanOrEqual(4096 - 500)
    expect(SUPPORT_DRAFT_CAP).toBe(1500)
    // What a composed text was held to, read from the text: the drafted cap while it fits it; longer, only the literal guide can be.
    expect(supportTextCap('x'.repeat(1500))).toBe(1500)
    expect(supportTextCap('x'.repeat(1501))).toBe(SUPPORT_LITERAL_CAP)
    // A paragraph that starts with «Importante:» buys nothing any more.
    const block = '\n\nImportante: Si no aparece, revisa que esté activo.'
    expect(supportTextCap(`${'x'.repeat(1800 - block.length)}${block}`)).toBe(SUPPORT_LITERAL_CAP)
  })

  it('a real guide of ~2,800 (crear-liga-pago) goes whole: alone, with the resend notice or the old-version notice and offer, and hybrid off', () => {
    expect(whole(liga).length).toBeGreaterThan(2800)
    for (const access of [null, emptyAccess, fullAccess]) {
      expect(literalSupportAnswer([liga], access)).toBe(whole(liga, access))
      for (const notice of [SUPPORT_SEND_RETRY_NOTICE, OLD])
        expect(literalSupportAnswer([liga], access, notice)).toBe(`${notice}\n\n${whole(liga, access)}`)
    }
    // Hybrid off: a verified section that carries the same whole guide goes through the same composer.
    expect(composeSupportAnswer([{ ...liga, whole: wholeGuide(liga.body) }], null)).toBe(whole(liga))
  })

  it('a guide over the cap goes as its card: never its steps nor its summary', () => {
    for (const g of over) {
      expect(whole(g).length).toBeGreaterThan(SUPPORT_LITERAL_CAP)
      const text = literalSupportAnswer([g], null)
      expect(text).toBe(card(g))
      expect(text).not.toContain(g.summary)
      expect(text).not.toMatch(/^\d+\. /m)
    }
  })

  it('the order is fixed: both whole, else the first whole and the second as its card, else cards; never the second whole alone', () => {
    const [a, b] = [...unique].sort((x, y) => whole(x).length - whole(y).length || x.id.localeCompare(y.id))
    expect(literalSupportAnswer([a, b], null)).toBe(`${whole(a)}\n\n${whole(b)}`)
    expect(whole(liga).length + 2 + whole(sucursal).length).toBeGreaterThan(SUPPORT_LITERAL_CAP)
    expect(literalSupportAnswer([liga, sucursal], null)).toBe(`${whole(liga)}\n\n${card(sucursal)}`)
    expect(literalSupportAnswer([sucursal, liga], null)).toBe(`${whole(sucursal)}\n\n${card(liga)}`)
    // The first one, the one that answers best, does not fit whole: both as cards, although the second alone would.
    expect(literalSupportAnswer([over[1], liga], null)).toBe(`${card(over[1])}\n\n${card(liga)}`)
  })

  it('every real guide alone, with the worst notices and any access: within the cap, and whole whenever its whole fits', () => {
    const notice = [SUPPORT_SEND_RETRY_NOTICE, OLD].join('\n\n')
    const bad: string[] = []
    for (const g of unique)
      for (const n of ['', notice])
        for (const access of [null, emptyAccess, fullAccess]) {
          const text = literalSupportAnswer([g], access, n)
          const want = [n, whole(g, access)].filter(Boolean).join('\n\n')
          const expected = want.length <= SUPPORT_LITERAL_CAP ? want : [n, card(g, access)].filter(Boolean).join('\n\n')
          if (text !== expected || text.length > SUPPORT_LITERAL_CAP) bad.push(`${g.id} ${n ? 'notice' : ''} ${text.length}`)
        }
    expect(bad).toEqual([])
  })
})

// T-F8 (ruling T-F8.1): the judge reads the cited guides with numbered lines (one per sentence) and answers what is missing as
// {guideId, line}; the code takes the exact text of that line. T-F7 to T-F12 appended those lines in an «Importante» block; T-F13
// (PARADA) removed it: a real line of a cited guide is only a SIGNAL, and the answer becomes the literal guide (whole up to
// SUPPORT_LITERAL_CAP, else its card). A number that is not a line of a cited guide says nothing: the draft goes as drafted.
/** A missing line as the judge gives it: its number (T-F13: no `inicio`). */
const missingAt = (g: LibraryGuide, line: number): MissingLine => ({ guideId: g.id, line })

describe('T-F7 to T-F13: what the judge says is missing, by line number, sends the literal guide instead of the draft', () => {
  const library = loadSupportLibrary({ allowDraft: true })
  const real = (id: string) => library.find(g => g.id === id)!
  /** The 7 drafts the judge rejected in the exam b-tf6-r1 (`salida.rechazada` of c04, c05, c21, c23, c29, c63 and c65), as they were. */
  const REJECTED: Record<string, SupportDraft> = {
    c04: {
      covered: true,
      intro: null,
      steps: [
        {
          text: 'Entra a *Configuración > Información del local > Contacto e Imágenes*.',
          guideId: 'dashboard/configuracion/configurar-imagenes-contacto',
          quote: 'Entra a **Configuración > Información del local > Contacto e Imágenes**.',
        },
        {
          text: 'Actualiza el logo según lo que permita la pantalla.',
          guideId: 'dashboard/configuracion/configurar-imagenes-contacto',
          quote: 'Actualiza logo, imagen principal o fotos del local según lo que permita la pantalla.',
        },
        {
          text: 'Guarda y valida la información desde otra sesión o con otro usuario si el cambio afecta canales públicos.',
          guideId: 'dashboard/configuracion/configurar-imagenes-contacto',
          quote: 'Guarda y valida la información desde otra sesión o con otro usuario si el cambio afecta canales públicos.',
        },
      ],
    },
    c05: {
      covered: true,
      intro: null,
      steps: [
        {
          text: 'En *Facturación* › *Facturas*, toca *Nueva factura*.',
          guideId: 'dashboard/facturas/facturar-una-venta',
          quote: 'En *Facturación* › *Facturas*, toca *Nueva factura*.',
        },
        {
          text: 'Busca la venta por folio, monto, o nombre o teléfono del cliente, y toca *Facturar* en su renglón.',
          guideId: 'dashboard/facturas/facturar-una-venta',
          quote: 'Busca la venta por folio, monto, o nombre o teléfono del cliente, y toca *Facturar* en su renglón.',
        },
        {
          text: 'Llena *RFC*, *Código postal*, *Razón social* (como está ante el SAT, sin «S.A. de C.V.»), *Régimen fiscal* y *Uso del CFDI*.',
          guideId: 'dashboard/facturas/facturar-una-venta',
          quote:
            'Llena *RFC*, *Código postal*, *Razón social* (como está ante el SAT, sin «S.A. de C.V.»), *Régimen fiscal* y *Uso del CFDI*.',
        },
        {
          text: 'Toca *Emitir factura*. Si sale «Factura emitida correctamente.», ya quedó.',
          guideId: 'dashboard/facturas/facturar-una-venta',
          quote: 'Toca *Emitir factura*. Si sale «Factura emitida correctamente.», ya quedó.',
        },
        {
          text: 'Necesitas permiso para facturar y para ver pedidos, y que tu plan incluya facturación.',
          guideId: 'dashboard/facturas/facturar-una-venta',
          quote: 'Necesitas permiso para facturar y para ver pedidos, y que tu plan incluya facturación.',
        },
      ],
    },
    c21: {
      covered: true,
      intro: {
        text: 'Puedes revisar las ventas del periodo en los indicadores principales de Inicio.',
        guideId: 'dashboard/inicio/entender-inicio-dashboard',
        quote: 'Revisa los indicadores principales del periodo: ventas, pedidos, pagos recientes y actividad operativa.',
      },
      steps: [
        {
          text: 'Entra al Dashboard y abre *Inicio*.',
          guideId: 'dashboard/inicio/entender-inicio-dashboard',
          quote: 'Entra al Dashboard y abre **Inicio**.',
        },
        {
          text: 'Confirma que la sucursal activa sea la correcta.',
          guideId: 'dashboard/inicio/entender-inicio-dashboard',
          quote: 'Confirma la sucursal activa.',
        },
        {
          text: 'Si quieres ver las ventas de hoy, cambia el periodo.',
          guideId: 'dashboard/inicio/entender-inicio-dashboard',
          quote: 'Cambia el periodo si quieres comparar contra otro día o semana.',
        },
      ],
    },
    c23: {
      covered: true,
      intro: {
        text: 'Con *No rastrear inventario*, las ventas del producto no descuentan su receta.',
        guideId: 'dashboard/inventario/por-que-una-receta-no-descuenta',
        quote: 'Con *No rastrear inventario*, las ventas del producto no descuentan su receta.',
      },
      steps: [
        {
          text: 'Confirma que tu negocio tenga incluida la función de inventario.',
          guideId: 'dashboard/inventario/por-que-una-receta-no-descuenta',
          quote: 'El inventario es para los negocios que tienen incluida la función de inventario.',
        },
        {
          text: 'Necesitas permiso para ver el menú y el inventario de *Recetas*.',
          guideId: 'dashboard/inventario/por-que-una-receta-no-descuenta',
          quote:
            'Necesitas permiso para ver el menú: de ahí salen los productos. Para *Recetas* también necesitas permiso para ver el inventario, y para crear la receta, permiso para crear en él.',
        },
        {
          text: 'Si todavía no tiene receta, necesitas permiso para crearla en el inventario.',
          guideId: 'dashboard/inventario/por-que-una-receta-no-descuenta',
          quote: 'Para *Recetas* también necesitas permiso para ver el inventario, y para crear la receta, permiso para crear en él.',
        },
        {
          text: 'En *Inventario* › *Recetas*, busca el producto. Si aparece *Agregar Receta* en lugar de *Editar*, créala.',
          guideId: 'dashboard/inventario/por-que-una-receta-no-descuenta',
          quote:
            'En *Inventario* › *Recetas*, busca el producto. Si en su renglón sale *Agregar Receta* en lugar de *Editar*, todavía no tiene receta: créala.',
        },
        {
          text: 'Abre el producto en *Productos*, dentro del menú de tu catálogo, y entra a la pestaña *Inventario*.',
          guideId: 'dashboard/inventario/por-que-una-receta-no-descuenta',
          quote:
            'Abre el producto en *Productos*, dentro del menú de tu catálogo (su nombre cambia según tu giro, por ejemplo *Menú* o *Catálogo*), y entra a la pestaña *Inventario*.',
        },
        {
          text: 'En *Seguimiento de Inventario*, elige *Rastrear por receta* y toca *Guardar*.',
          guideId: 'dashboard/inventario/por-que-una-receta-no-descuenta',
          quote: 'En *Seguimiento de Inventario*, elige *Rastrear por receta* y toca *Guardar*.',
        },
      ],
    },
    c29: {
      covered: true,
      intro: null,
      steps: [
        {
          text: 'Entra a *Reservaciones* › *Lista de espera*.',
          guideId: 'dashboard/reservaciones/agregar-a-lista-de-espera',
          quote: 'En *Reservaciones* › *Lista de espera*, toca *Agregar a Lista*.',
        },
      ],
    },
    c63: {
      covered: true,
      intro: null,
      steps: [
        {
          text: 'Abre el *Dashboard* y ubica el selector de sucursal.',
          guideId: 'dashboard/inicio/cambiar-sucursal',
          quote: 'Abre el Dashboard y ubica el selector de sucursal.',
        },
        { text: 'Haz clic en el local activo.', guideId: 'dashboard/inicio/cambiar-sucursal', quote: 'Haz clic en el local activo.' },
        {
          text: 'Elige la sucursal Norte.',
          guideId: 'dashboard/inicio/cambiar-sucursal',
          quote: 'Elige la sucursal que quieres consultar.',
        },
        {
          text: 'Espera a que el Dashboard recargue datos.',
          guideId: 'dashboard/inicio/cambiar-sucursal',
          quote: 'Espera a que el Dashboard recargue datos.',
        },
      ],
    },
    c65: {
      covered: true,
      intro: null,
      steps: [
        {
          text: 'En la barra lateral, abre el menú de tu catálogo, entra a *Productos* y toca *Nuevo producto*.',
          guideId: 'dashboard/menu/crear-producto',
          quote:
            'En la barra lateral, abre el menú de tu catálogo (su nombre cambia según tu giro, por ejemplo *Menú* o *Catálogo*), entra a *Productos* y toca *Nuevo producto*.',
        },
        {
          text: 'Elige el tipo de artículo y toca *Siguiente*.',
          guideId: 'dashboard/menu/crear-producto',
          quote: 'Elige el tipo de artículo y toca *Siguiente*.',
        },
        {
          text: 'Escribe el *Nombre del Producto* y el *Precio* y, si aparece, elige la *Categoría*.',
          guideId: 'dashboard/menu/crear-producto',
          quote: 'Escribe el *Nombre del Producto* y el *Precio* y, si aparece, elige la *Categoría*.',
        },
        { text: 'Toca *Finalizar*.', guideId: 'dashboard/menu/crear-producto', quote: 'Toca *Finalizar*.' },
        {
          text: 'Para guardar un producto nuevo necesitas permiso para crear productos y para editar el inventario, aunque no le cuentes piezas.',
          guideId: 'dashboard/menu/crear-producto',
          quote:
            'Para guardar un producto nuevo necesitas permiso para crear productos y para editar el inventario, aunque no le cuentes piezas.',
        },
      ],
    },
  }
  /** What a judge would plausibly report as missing: sentences copied from each guide's body. */
  const MISSING: Record<string, string[]> = {
    c04: ['Antes de cambiarla, confirma que estás en la sucursal correcta y que el negocio aprobó el texto o imagen final.'],
    c05: [
      '«Factura emitida correctamente.» no confirma que el correo haya llegado. Si no le llega, no la vuelvas a emitir: reenvíala o descárgala con el botón ⋯ de la factura en *Facturas*.',
    ],
    c21: ['La información depende de la sucursal activa, del rango de fechas y de los permisos de tu usuario.'],
    c23: ['Para cambiar el producto necesitas permiso para editar el menú.'],
    c29: [
      'Reservaciones es para los negocios que tienen incluida esa función.',
      'Si después de tocar *Agregar a Lista* sale cualquier error, incluidos los dos de arriba, no lo agregues otra vez: pudo quedar anotado en un primer intento.',
    ],
    c63: ['Si no ves una sucursal, tu usuario no está asignado o el local no está disponible para tu cuenta.'],
    c65: [
      'Si al tocar *Finalizar* sale cualquier otro «Error», no lo vuelvas a crear ni le pidas a otra persona que lo cree: pudo quedar creado aunque saliera el error.',
    ],
  }
  /** T-F8: the line numbers of a guide whose texts, joined, are exactly this quote (one sentence, or two in a row). */
  const numbersOf = (g: LibraryGuide, quote: string): number[] => {
    const lines = numberedGuide(g.body).lines
    for (let i = 0; i < lines.length; i++)
      for (let j = i; j < Math.min(lines.length, i + 3); j++)
        if (lines.slice(i, j + 1).join(' ') === quote) return lines.slice(i, j + 1).map((_l, k) => i + k + 1)
    return []
  }
  const cases = Object.entries(REJECTED).map(([id, draft]) => {
    const g = real(draft.steps[0].guideId)
    return { id, draft, g, missing: MISSING[id].flatMap(quote => numbersOf(g, quote)).map(line => missingAt(g, line)) }
  })
  /** The judge with a fake provider: its verdict and how many calls it made. */
  const judge = async (draft: SupportDraft, g: LibraryGuide, verdict: unknown) => {
    const { client, create } = fakeClient(verdict)
    return {
      ...(await judgeSupportDraft(client, { question: '¿Cómo lo hago?', draft, guides: [g] }, pricing)),
      calls: create.mock.calls.length,
    }
  }

  it('T-F8: a guide is numbered one sentence per line, never inside «…» or parentheses; a heading or a rule has no number', () => {
    const body = `## Antes de empezar

Reservaciones es para los negocios que la tienen. Para agregar necesitas permiso.

## Pasos

1. En *Reservaciones* › *Lista*, toca *Agregar*: sale «Agregado. Listo para avisar».
2. Si sale un error (por ejemplo «No se pudo. Intenta otra vez.»), no lo repitas. Pide ayuda.
   - Una viñeta    con sangría y espacios de más.

| Plan | Precio |
| --- | --- |
| Pro | $999 / mes |

Un párrafo partido en dos
renglones que sigue aquí. ¿Y otra oración? Sí.`
    const { lines, numbered } = numberedGuide(body)
    expect(lines).toEqual([
      'Reservaciones es para los negocios que la tienen.',
      'Para agregar necesitas permiso.',
      'En *Reservaciones* › *Lista*, toca *Agregar*: sale «Agregado. Listo para avisar».',
      'Si sale un error (por ejemplo «No se pudo. Intenta otra vez.»), no lo repitas.',
      'Pide ayuda.',
      'Una viñeta con sangría y espacios de más.',
      '| Plan | Precio |',
      '| Pro | $999 / mes |',
      'Un párrafo partido en dos renglones que sigue aquí.',
      '¿Y otra oración?',
      'Sí.',
    ])
    // T-F10: the guide as it is (spaces, line breaks and indentation kept), with «[n] » before each line or its bullet, and nothing else
    expect(numbered).toBe(`## Antes de empezar

[1] Reservaciones es para los negocios que la tienen. [2] Para agregar necesitas permiso.

## Pasos

[3] 1. En *Reservaciones* › *Lista*, toca *Agregar*: sale «Agregado. Listo para avisar».
[4] 2. Si sale un error (por ejemplo «No se pudo. Intenta otra vez.»), no lo repitas. [5] Pide ayuda.
   [6] - Una viñeta    con sangría y espacios de más.

[7] | Plan | Precio |
| --- | --- |
[8] | Pro | $999 / mes |

[9] Un párrafo partido en dos
renglones que sigue aquí. [10] ¿Y otra oración? [11] Sí.`)
    expect(numbered.replace(/\[\d+\] /g, '')).toBe(body)
    // A line number gives back exactly that text; the judge's guides are the ones it reads.
    const g = guide('dashboard/reservaciones/lista-de-prueba', 'dashboard', body)
    lines.forEach((text, i) => expect(missingLineText([g], { guideId: g.id, line: i + 1 })).toBe(text))
    expect(numberedGuide(PRODUCTS_BODY).numbered).toBe(PRODUCTS_NUMBERED)
  })

  it('T-F8: every quote the judge wrote for these drafts is one or two whole numbered lines, and the numbers give it back exactly', () => {
    for (const { id, g, missing } of cases) {
      expect([id, missing.map(m => missingLineText([g], m)).join(' ')]).toEqual([id, MISSING[id].join(' ')])
    }
    // c05 quoted two sentences: two numbers.
    expect(cases.find(c => c.id === 'c05')!.missing).toHaveLength(2)
  })

  // T-F13: the 7 drafts were completed with an «Importante» block from T-F7 to T-F12; now each one goes as its literal guide, whole
  // (all 7 fit in SUPPORT_LITERAL_CAP), with the missing lines where the guide has them: next to their own conditions.
  it('the 7 real drafts the judge said lacked a condition in b-tf6-r1 now go as the whole guide, never with an appended line (T-F13)', async () => {
    expect(cases.map(c => c.id)).toEqual(['c04', 'c05', 'c21', 'c23', 'c29', 'c63', 'c65'])
    for (const { id, draft, g, missing } of cases) {
      // The drafts were good: only the judge stopped them.
      expect([id, reason(draft, [g])]).toEqual([id, 'ok'])
      const verdict = await judge(draft, g, { supported: true, missing })
      expect(verdict).toMatchObject({ supported: true, calls: 1 })
      expect(verdict.missing.map(m => m.line)).toEqual(missing.map(m => m.line))
      expect([id, judgeMissingSignal(draft, [g], verdict.missing)]).toEqual([id, true])
      expect([id, hybridDraftOutcome(draft, [g], verdict.supported, verdict.missing)]).toEqual([
        id,
        { reply: 'literal', fallback: 'judge-rejected' },
      ])
      const text = hybridFallback({ reply: 'literal' }, [g]).compose(null)
      expect(text).toBe(literalSupportAnswer([g], null))
      expect([id, text.includes(wholeGuide(g.body))]).toEqual([id, true])
      expect(text).not.toContain('Importante:')
    }
  })

  it('T-F13: a line out of range, of a guide the draft does not cite or of an unknown guide says nothing: the draft goes as drafted', () => {
    const { draft, g, missing } = cases[0]
    const other = real(cases[1].g.id)
    const n = numberedGuide(g.body).lines.length
    expect(missingLineText([g, other], { guideId: other.id, line: 1 })).toBe(numberedGuide(other.body).lines[0])
    for (const line of [0, -1, 1.5, n + 1, Number.NaN]) expect(missingLineText([g], { guideId: g.id, line })).toBeNull()
    expect(missingLineText([g], { guideId: 'dashboard/no/existe', line: 1 })).toBeNull()
    const bogus: MissingLine[][] = [
      [{ guideId: g.id, line: 0 }],
      [{ guideId: g.id, line: n + 1 }],
      [{ guideId: g.id, line: 1.5 }],
      [{ guideId: other.id, line: 1 }], // a real line, but of a guide the draft does not cite
      [{ guideId: 'dashboard/no/existe', line: 1 }],
    ]
    // T-F13b (fail-safe): even a bogus number means the judge saw something missing, so the literal guide goes out.
    for (const m of bogus) {
      expect(judgeMissingSignal(draft, [g, other], m)).toBe(true)
      expect(hybridDraftOutcome(draft, [g, other], true, m)).not.toBeNull()
    }
    expect(judgeMissingSignal(draft, [g, other], [])).toBe(false)
    expect(hybridDraftOutcome(draft, [g, other], true, [])).toBeNull()
    // One real line among bogus ones is enough: the literal guide.
    expect(hybridDraftOutcome(draft, [g, other], true, [...bogus.flat(), ...missing])).toEqual({
      reply: 'literal',
      fallback: 'judge-rejected',
    })
    expect(hybridDraftOutcome(draft, [g, other], true, [])).toBeNull()
  })

  it('a false claim still falls back, whatever the judge says is missing', async () => {
    for (const { draft, g, missing } of cases) {
      const verdict = await judge(draft, g, { supported: false, missing })
      expect(verdict.supported).toBe(false)
      expect(hybridDraftOutcome(draft, [g], verdict.supported, verdict.missing)).toEqual({ reply: 'literal', fallback: 'judge-rejected' })
    }
  })

  // T-F8.3 let a completed answer reach 2,000. T-F13: what is missing is never rendered, so a drafted answer is 1,500 as always and a
  // missing line sends the whole guide (here ~2,100, within SUPPORT_LITERAL_CAP).
  it('T-F13: a drafted answer is capped at 1,500 also when the judge says something is missing: the whole guide instead', () => {
    const condition = (k: string) =>
      `Si al guardar sale el aviso ${k}, revisa ${'que la opción esté activa en tu sucursal y en tu menú, '.repeat(9)}y vuelve a entrar.`
    const body = `## Pasos

1. Abre *Ajustes* y toca *Guardar*.

## Problemas frecuentes

- ${condition('uno')}
- ${condition('dos')}
- ${condition('tres')}
- ${condition('cuatro')}`
    const g = guide('dashboard/configuracion/ajustes-largos', 'dashboard', body)
    const draft: SupportDraft = {
      covered: true,
      intro: null,
      steps: [line(g, 'Abre Ajustes y toca Guardar', 'Abre *Ajustes* y toca *Guardar*.')],
    }
    const upTo = (k: number) => [2, 3, 4, 5].slice(0, k).map(n => missingAt(g, n))
    for (const k of [1, 3, 4]) {
      expect(hybridDraftOutcome(draft, [g], true, upTo(k))).toEqual({ reply: 'literal', fallback: 'judge-rejected' })
      const text = hybridFallback({ reply: 'literal' }, [g]).compose(null)
      expect(text.length).toBeGreaterThan(1500)
      expect(text.length).toBeLessThanOrEqual(SUPPORT_LITERAL_CAP)
      expect(text).toContain(wholeGuide(body))
    }
    // Without anything missing the draft renders, within 1,500.
    const drafted = hybridAnswerText(draft, [g], null)
    expect(drafted.fallback).toBeUndefined()
    expect(drafted.text.length).toBeLessThanOrEqual(SUPPORT_DRAFT_CAP)
    expect(drafted.text).not.toContain('Importante:')
  })

  // T-F10a/T-F10b sorted the lines of a guide into conditions (appended) and operations (refused). T-F13: there is nothing to sort:
  // every real line of a cited guide is the same signal, the whole guide.
  it('every line of a real guide (c23), given as missing: the literal guide, whatever line it is (T-F13)', () => {
    const { draft, g } = cases.find(c => c.id === 'c23')!
    const all = numberedGuide(g.body).lines.map((_l, i) => missingAt(g, i + 1))
    for (const m of all)
      expect([m.line, hybridDraftOutcome(draft, [g], true, [m])]).toEqual([m.line, { reply: 'literal', fallback: 'judge-rejected' }])
    expect(literalSupportAnswer([g], null)).toContain(wholeGuide(g.body))
  })

  it('the judge schema asks for {guideId, line} with the same shape for every message (no id enum, T-F13: no inicio), and the verdict is validated', async () => {
    const { client, create } = fakeClient({ supported: true, missing: [] })
    expect(await judgeSupportDraft(client, { question: '¿Cómo agrego un producto?', draft: draftOf(), guides }, pricing)).toEqual({
      supported: true,
      missing: [],
      usage,
      requestId: 'req_fixture',
      called: true,
    })
    const schema = (create.mock.calls[0][0] as Record<string, any>).text.format.schema
    expect(schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['supported', 'missing'],
      properties: {
        supported: { type: 'boolean' },
        missing: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['guideId', 'line'],
            properties: { guideId: { type: 'string' }, line: { type: 'integer' } },
          },
        },
      },
    })
    // T-F8: a line number comes back as it was sent.
    const numbered = fakeClient({ supported: true, missing: [{ guideId: products.id, line: 4 }] })
    expect(
      await judgeSupportDraft(numbered.client, { question: '¿Cómo agrego un producto?', draft: draftOf(), guides }, pricing),
    ).toMatchObject({ supported: true, missing: [{ guideId: products.id, line: 4 }] })
    // Another draft with other guides: the same schema, so the provider can reuse the judge's prefix.
    const other = fakeClient({ supported: true, missing: [] })
    await judgeSupportDraft(
      other.client,
      { question: '¿Y la sucursal?', draft: draftOf({ intro: line(branch, 'Abre el selector que está arriba') }), guides },
      pricing,
    )
    expect(other.create.mock.calls[0][0].text).toEqual((create.mock.calls[0][0] as Record<string, any>).text)
    for (const bad of [
      { supported: true }, // missing absent
      { supported: true, missing: [{ guideId: products.id }] },
      { supported: true, missing: [{ guideId: products.id, line: '4' }] },
      { supported: true, missing: [{ guideId: products.id, line: 1.5 }] },
      { supported: true, missing: [{ guideId: products.id, quote: 'Guarda con el botón Guardar' }] }, // the T-F7 shape
      { supported: true, missing: [{ guideId: products.id, line: 4, inicio: 'No puedes borrar un' }] }, // the T-F10a shape
      { supported: true, missing: [{ guideId: products.id, line: 4, why: 'x' }] },
      { supported: true, missing: 4 },
    ]) {
      const fresh = fakeClient(bad)
      expect(await judgeSupportDraft(fresh.client, { question: '¿Cómo agrego un producto?', draft: draftOf(), guides }, pricing)).toEqual({
        supported: false,
        missing: [],
        usage,
        requestId: 'req_fixture',
        called: true,
      })
    }
  })

  // The pieces that ask for the missing line numbers; every other rule is the one of T-F5 (and of T-F6 without its H2 pieces), byte
  // for byte. T-F8 replaced the quotes of T-F7 by line numbers; T-F10 put them in body, the judge's only copy, and says the quotes
  // were already checked. T-F13: no `inicio`, and the line is no longer «added as is to the answer».
  const QUESTION =
    ' Aparte, en missing, da el renglón de cada condición o advertencia que la guía le pone a un paso que se da y que ninguna línea trae.'
  const SECTION = `LO QUE FALTA (missing)
- En el cuerpo (body) de cada guía, cada oración empieza con su número de renglón entre corchetes ([1], [2]…). El número no es parte de la guía: úsalo sólo para dar los números de missing. Las citas (quote) ya las comprobó el sistema, letra por letra, contra la guía sin esos números: no las vuelvas a buscar.
- Por cada paso que se da, la condición o la advertencia que la guía le pone a ese paso (lo que tiene que pasar o estar activo antes, un «no repitas…» o un «no lo intentes otra vez», qué hacer si al hacerlo aparece un aviso) y que ni esa línea ni otra traen, salvo que la duda de la persona ya la cumpla: eso no es un detalle.
- Cada una lleva guideId (la guía de ese paso) y line: el número del renglón que la dice (si son dos renglones seguidos, uno por cada uno). Da sólo los renglones de lo que falta.
- Lo que falta no hace falsa la respuesta: supported sólo mira ES FALSO. Si no falta nada, missing es una lista vacía.

`
  it('the judge instructions ask for the missing line numbers apart from supported; every other rule is byte-identical (sha256)', () => {
    const [question, rest] = JUDGE_INSTRUCTIONS.split('\n\nESTÁ BIEN')
    expect(question).toContain(QUESTION)
    expect(rest).toContain(`\n\n${SECTION}SEGURIDAD`)
    // The H2 rule left ES FALSO: a missing condition is reported in missing, not as a false claim.
    const [, bad] = rest.split('ES FALSO')
    expect(bad.split('LO QUE FALTA')[0]).not.toContain('no es un detalle')
    expect(JUDGE_INSTRUCTIONS).not.toContain('Y cada paso que se da lleva, en su línea o en otra')
    // T-F8: the judge no longer copies the text of what is missing. T-F13: nor its first words, and nothing is appended.
    expect(JUDGE_INSTRUCTIONS).not.toContain('copiada LITERAL')
    expect(JUDGE_INSTRUCTIONS).not.toContain('inicio')
    expect(JUDGE_INSTRUCTIONS).not.toContain('se agrega tal cual')
    const before = JUDGE_INSTRUCTIONS.replace(QUESTION, '').replace(SECTION, '')
    expect(crypto.createHash('sha256').update(before).digest('hex')).toBe(
      'd0a1073628d8a76e47a5231640a9ecada59334c5df2c85fa13b9aa17d72da1a4',
    )
  })

  it('the understand and draft instructions do not change (the judge is not part of the T8 golden)', () => {
    expect(UNDERSTAND_INSTRUCTIONS).not.toContain('missing')
    expect(DRAFT_INSTRUCTIONS).not.toContain('missing')
    expect(DRAFT_INSTRUCTIONS).not.toContain('[1]')
  })

  it('T-F8: the draft still reads the guides as they are, without line numbers', async () => {
    const { client, create } = fakeClient(draftJson())
    await draftSupportAnswer(client, { question: '¿Cómo agrego un producto?', guides, history: [] }, pricing)
    expect(sentInput(create).guides[0]).toEqual({ id: products.id, title: products.title, body: PRODUCTS_BODY })
  })
})

// T-F9 (ruling T-F9): with T-F8 the judge read a numbered COPY of each guide as its body, and that copy is not the text the draft
// quoted: joining the spaces cut the padded cells of a table and the [n] cut every quote that crosses a sentence or a list item. The
// judge mini-exam rejected exactly the two correct pairs that kept no quote (j15 and j21, «$999 al mes + IVA»). T-F9 sent the guide
// twice (+44 % of the judge's input). T-F10 (ruling T-F10.1): ONE copy, the guide byte for byte with «[n] » before each line, so a
// quote inside a sentence or a table row stays whole (j21), and the judge is told the quotes were already checked letter by letter
// (the fixed review). These pin what the judge RECEIVES; what it decides is the exam's.
describe('T-F10: the judge reads ONE copy of each guide: as it is, with the number of each line inserted', () => {
  const library = loadSupportLibrary({ allowDraft: true })
  const real = (id: string) => library.find(g => g.id === id)!
  const judgeRequest = async (question: string, draft: SupportDraft, cited: LibraryGuide[]) => {
    const { client, create } = fakeClient({ supported: true, missing: [] })
    await judgeSupportDraft(client, { question, draft, guides: cited }, pricing)
    return { request: create.mock.calls[0][0] as Record<string, any>, input: sentInput(create) }
  }
  const quotesOf = (draft: SupportDraft) => [...(draft.intro ? [draft.intro] : []), ...draft.steps].map(l => l.quote)
  // The juez.json mini-exam: draft = its lines, all citing its one guide (as run.ts builds it).
  type Pair = {
    id: string
    question: string
    guideId: string
    intro: { text: string; quote: string } | null
    steps: { text: string; quote: string }[]
    supported: boolean
    alteracion: string
    /** T-F13: the warning of the guide the draft leaves out (a «correct but missing the key warning» pair). */
    falta?: string
  }
  const pairs: Pair[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../scripts/support-eval/juez.json'), 'utf8'))
  const draftOfPair = (p: Pair): SupportDraft => ({
    covered: true,
    intro: p.intro ? { ...p.intro, guideId: p.guideId } : null,
    steps: p.steps.map(s => ({ ...s, guideId: p.guideId })),
  })

  it('j21: «El plan Pro cuesta $999 al mes + IVA.» reaches the judge with its quote whole, the whole Pro row and both «+ IVA» rules', async () => {
    const pair = pairs.find(p => p.id === 'j21')!
    const draft = draftOfPair(pair)
    const overview = real('general/overview')
    expect(reason(draft, [overview])).toBe('ok')
    const { request, input } = await judgeRequest(pair.question, draft, [overview])
    const [sent] = input.guides
    // one copy: the guide with its numbers; the quote keeps its padding («**Pro**        | $999 / mes»), as the draft copied it
    expect(Object.keys(sent)).toEqual(['id', 'title', 'body'])
    expect(sent.body).toBe(numberedGuide(overview.body).numbered)
    expect(sent.body.replace(/\[\d+\] /g, '')).toBe(overview.body)
    expect(sent.body).toContain('**Pro**        | $999 / mes')
    expect(sent.body).toMatch(/\[\d+\] \| \*\*Pro\*\* {8}\| \$999 \/ mes/)
    // a table row is ONE line, whole, and «sin IVA» is a line of its own
    const lines = numberedGuide(overview.body).lines
    const pro = lines.filter(l => l.includes('$999 / mes'))
    expect(pro).toHaveLength(1)
    // T-F21: the price cell carries «+ IVA» (c06 of b-tf19-r1); the quote of j21 is still its start
    expect(pro[0]).toMatch(/^\| \*\*Pro\*\* \| \$999 \/ mes \+ IVA \| Todo Free \+ .+ \|$/)
    expect(lines).toContain('Precios de referencia en pesos mexicanos, sin IVA.')
    // the house rule reaches the judge: «+ IVA» next to a price the guide gives «sin IVA» is fine; a price without it is false
    const [fine, bad] = String(request.instructions).split('ES FALSO')
    expect(fine).toContain('- Escribir «+ IVA» junto a un precio que la guía da «sin IVA».')
    expect(bad).toContain('da un precio con el IVA sumado o dado como total, o da un precio (con $, «pesos» o «MXN») sin «+ IVA» junto.')
  })

  it('c10 (b-tf8-r1, judged false): its 4 quotes are in the guide the judge reads, without its numbers, and line 5 is still the condition', async () => {
    const terminals = real('dashboard/terminales/gestionar-terminales')
    const id = terminals.id
    // `salida.rechazada` of c10 in b-tf8-r1, as it was
    const draft: SupportDraft = {
      covered: true,
      intro: {
        text: 'Puede que la terminal no esté asignada al local correcto.',
        guideId: id,
        quote: 'Si la terminal no aparece, puede no estar asignada al local correcto.',
      },
      steps: [
        {
          text: 'Cambia primero al local donde está la terminal; los datos dependen del local activo.',
          guideId: id,
          quote:
            'Los datos siempre dependen del local activo. Si administras varias sucursales, cambia primero a la sucursal donde está la terminal.',
        },
        {
          text: 'Abre *Dispositivos* y busca la terminal por nombre, identificador o estado.',
          guideId: id,
          quote: 'Abre **Dispositivos**.\n2. Busca la terminal por nombre, identificador o estado.',
        },
        {
          text: 'Si sigue sin aparecer asignada, contacta a soporte.',
          guideId: id,
          quote: 'Contacta soporte si la terminal no aparece asignada',
        },
      ],
    }
    expect(reason(draft, [terminals])).toBe('ok')
    const { input } = await judgeRequest('la maqinita no aparese en el sistema', draft, [terminals])
    const [sent] = input.guides
    const numbered = numberedGuide(terminals.body).numbered
    expect(sent).toEqual({ id, title: terminals.title, body: numbered })
    // without its numbers it is the guide, with the 4 quotes; the two that cross a sentence ([5]) and a list item ([7]) have a number
    // inside, and the instructions say the quotes were already checked (the fixed review: `reason` above is ok)
    for (const quote of quotesOf(draft)) expect(numbered.replace(/\[\d+\] /g, '')).toContain(quote)
    expect(quotesOf(draft).filter(q => !numbered.includes(q))).toEqual([draft.steps[0].quote, draft.steps[1].quote])
    expect(numbered).toContain('Los datos siempre dependen del local activo. [5] Si administras varias sucursales')
    expect(numbered).toContain('Abre **Dispositivos**.\n[7] 2. Busca la terminal')
    // what the judge said was missing (line 5) is still that line; T-F13: the whole guide goes, with that line in its place
    expect(missingLineText([terminals], { guideId: id, line: 5 })).toBe(
      'Si administras varias sucursales, cambia primero a la sucursal donde está la terminal.',
    )
    expect(numbered).toContain('[5] Si administras varias sucursales, cambia primero a la sucursal donde está la terminal.')
    expect(hybridDraftOutcome(draft, [terminals], true, [missingAt(terminals, 5)])).toEqual({
      reply: 'literal',
      fallback: 'judge-rejected',
    })
    expect(hybridFallback({ reply: 'literal' }, [terminals]).compose(null)).toContain(wholeGuide(terminals.body))
  })

  it('every pair of the judge mini-exam (juez.json) reaches the judge with ONE copy of its guide and every quote in it, without its numbers', async () => {
    expect(pairs).toHaveLength(30)
    let whole = 0
    let total = 0
    for (const pair of pairs) {
      const g = real(pair.guideId)
      const draft = draftOfPair(pair)
      const { input } = await judgeRequest(pair.question, draft, [g])
      expect([pair.id, input.guides]).toEqual([pair.id, [{ id: g.id, title: g.title, body: numberedGuide(g.body).numbered }]])
      const read = input.guides[0].body as string
      for (const quote of quotesOf(draft)) {
        total++
        if (read.includes(quote)) whole++
        expect([pair.id, read.replace(/\[\d+\] /g, '').includes(quote)]).toEqual([pair.id, true])
      }
    }
    // T-F10b: j15 and j16 quote the price sentence as T-F10.2 left it in general/overview, without its link (and j16 keeps its
    // altered amount, $899)
    const price =
      'Precios de referencia en pesos mexicanos, sin IVA. Confirma siempre el precio vigente en la página de precios de Avoqado.'
    for (const id of ['j15', 'j16']) expect([id, quotesOf(draftOfPair(pairs.find(p => p.id === id)!)).includes(price)]).toEqual([id, true])
    expect(pairs.find(p => p.id === 'j16')!.steps[0].text).toBe('El plan Pro cuesta $899 al mes.')
    expect(JSON.stringify(pairs)).not.toContain('avoqado.io/pricing')
    // measured on 17-nov: with T-F8's copy 34 of the 46 quotes were whole; now 38 (the 8 that are not cross a sentence: j05, j06,
    // j15, j16, j19 and j20). T-F13 adds 8 pairs (49 quotes, 41 whole: the 8 others cross a sentence of their step). Encargo 553f45
    // (24-nov): j26 also quotes the new step 4 of crear-producto (the pieces), one more whole quote.
    expect([whole, total]).toEqual([80, 96])
  })

  // T-F13 (ruling T-F13.3): the mini-exam measured only `supported`. These pairs measure `missing`: every claim is true, every step
  // is the guide's, and the draft leaves out a warning the guide attaches to those steps; the expected verdict is supported with a
  // real line in missing. Real guides and real warnings (c05 and c65 of b-tf6-r1, the Codex repro of contar-existencia, two of
  // money). The pair keeps the warning it leaves out, verbatim, in `falta`.
  it('the «correct but missing the key warning» pairs: true and verbatim, and their warning is a real line of the guide that no line brings', () => {
    const faltan = pairs.filter(p => p.falta)
    expect(faltan.map(p => p.id)).toEqual(['j23', 'j24', 'j25', 'j26', 'j27', 'j28', 'j29', 'j30'])
    expect(pairs.filter(p => !p.falta)).toHaveLength(22)
    for (const pair of faltan) {
      const g = real(pair.guideId)
      const draft = draftOfPair(pair)
      expect([pair.id, pair.supported, pair.alteracion]).toEqual([pair.id, true, 'falta-advertencia'])
      expect([pair.id, reason(draft, [g])]).toEqual([pair.id, 'ok'])
      // every step is the guide's text as it is
      for (const s of pair.steps) expect([pair.id, s.text]).toEqual([pair.id, s.quote])
      const at = numberedGuide(g.body).lines.indexOf(pair.falta!) + 1
      expect([pair.id, at > 0]).toEqual([pair.id, true])
      const left = normalizeForTest(pair.falta!)
      for (const l of quotesOf(draft)) expect([pair.id, normalizeForTest(l).includes(left)]).toEqual([pair.id, false])
      // what the judge should answer: the literal guide, whole, with that warning
      expect(hybridDraftOutcome(draft, [g], true, [missingAt(g, at)])).toEqual({ reply: 'literal', fallback: 'judge-rejected' })
      expect([pair.id, literalSupportAnswer([g], null).includes(wholeGuide(g.body))]).toEqual([pair.id, true])
    }
  })

  // T-F10.2 (c06): the drafter copied «Confirma siempre el precio vigente en `avoqado.io/pricing`.» as a step and the fixed review
  // stopped it (review-contact). The sentence says the same without the link; a draft that copies it now passes. T-F13: if the judge
  // gives it as missing, the literal goes, and general/overview does not fit whole: its card, never its «Planes» section.
  it('c06: the price sentence of general/overview has no link; a draft that copies it passes the fixed review', () => {
    const overview = real('general/overview')
    const sentence = 'Confirma siempre el precio vigente en la página de precios de Avoqado.'
    expect(overview.body).toContain(`Precios de referencia en pesos mexicanos, sin IVA. ${sentence}`)
    expect(overview.body).not.toContain('avoqado.io/pricing')
    const draft: SupportDraft = {
      covered: true,
      // T-F21: the Pro row as it is now, with «+ IVA» in its price cell
      intro: { text: 'El plan Pro cuesta $999 / mes + IVA.', guideId: overview.id, quote: '| **Pro**        | $999 / mes + IVA |' },
      steps: [{ text: 'Confirma el precio vigente en la página de precios de Avoqado.', guideId: overview.id, quote: sentence }],
    }
    expect(reason(draft, [overview])).toBe('ok')
    const line = numberedGuide(overview.body).lines.indexOf(sentence) + 1
    expect(line).toBeGreaterThan(0)
    const missing = [missingAt(overview, line)]
    // only the price as a step, and the judge says the sentence is missing: the literal guide, which for overview is its card
    const priceOnly: SupportDraft = { covered: true, intro: null, steps: [draft.intro!] }
    expect(hybridDraftOutcome(priceOnly, [overview], true, missing)).toEqual({ reply: 'literal', fallback: 'judge-rejected' })
    const text = hybridFallback({ reply: 'literal' }, [overview]).compose(null)
    expect(text).toBe(literalSupportAnswer([overview], null))
    expect(text).toContain(SUPPORT_GUIDE_TOO_LONG)
    expect(text).not.toContain('$999 / mes')
  })

  // T-F21 (c06 of b-tf19-r1): the drafter quoted only the price cell, «$999 / mes» (10 characters), and the fixed review stopped it
  // (review-quote: a quote measures at least 12); the literal of general/overview is its card, without the price. Each price of the
  // plans table now carries «+ IVA» (founder, 5-nov: «+ IVA» next to what Avoqado sells, never the total), so the cell cited alone
  // measures 16 and passes. The 12-character rule did not change: the quote of b-tf19-r1 is still rejected.
  it('c06 (b-tf19-r1): a price cell of the plans table cited alone passes the fixed review; the 10-character quote still does not', () => {
    const overview = real('general/overview')
    const draftWith = (quote: string): SupportDraft => ({
      covered: true,
      intro: { text: 'El plan Pro cuesta $999 / mes + IVA.', guideId: overview.id, quote },
      steps: [
        {
          text: 'Confirma siempre el precio vigente en la página de precios de Avoqado.',
          guideId: overview.id,
          quote: 'Confirma siempre el precio vigente en la página de precios de Avoqado.',
        },
      ],
    })
    expect(reason(draftWith('$999 / mes + IVA'), [overview])).toBe('ok')
    expect(reason(draftWith('$999 / mes'), [overview])).toBe('quote')
    for (const cell of ['$499 / mes + IVA', '$999 / mes + IVA', '$1,699 / mes + IVA']) expect(overview.body).toContain(`| ${cell} |`)
  })

  // T-F21 (c72 of b-tf19-r1): «no me llegan los pedidos de Uber» is a keyword of the delivery guide, but no line of it said what to
  // check: the drafter stitched «revisa que el canal de Uber Eats esté activo» from the description of Tus canales, the judge said
  // false, and the literal is the card (the guide does not fit). Problemas frecuentes now answers it with what the guide already
  // says (Recibir pedidos, Horario de pedidos, escalate); a draft that copies that answer passes the fixed review.
  // T-F22: that answer moved, word for word, to its own guide (problemas-con-pedidos-de-delivery), with the keyword; next test.
  it('c72 (b-tf19-r1): the delivery guide answers its keyword «no me llegan los pedidos de Uber»; a draft that copies it passes the fixed review', () => {
    const delivery = real('dashboard/ventas/problemas-con-pedidos-de-delivery')
    expect(delivery.keywords).toContain('no me llegan los pedidos de Uber')
    const step = (text: string, quote: string): DraftLine => ({ text, guideId: delivery.id, quote })
    const draft: SupportDraft = {
      covered: true,
      intro: null,
      steps: [
        step(
          'En *Ventas > Delivery*, revisa en *Tus canales* que el canal diga *Activo*.',
          'En Ventas > Delivery, revisa en Tus canales que el canal diga Activo.',
        ),
        step(
          'Si dice *Pausado*, el dueño o el administrador prende *Recibir pedidos* en su tarjeta.',
          'Si dice Pausado, el dueño o el administrador prende Recibir pedidos en su tarjeta.',
        ),
        step(
          'Revisa también su *Horario de pedidos* en *Horario, precios, productos e impresión*: fuera de ese horario la app no te manda pedidos.',
          'Revisa también su Horario de pedidos en Horario, precios, productos e impresión: fuera de ese horario la app no te manda pedidos.',
        ),
        step(
          'Si un pedido de la app nunca llegó a la pantalla de cocina, escala el caso.',
          'Si un pedido de la app nunca llegó a la pantalla de cocina, escala el caso',
        ),
      ],
    }
    expect(reason(draft, [delivery])).toBe('ok')
  })

  // T-F22 (c72 of b-tf21-r1): the judge rejected the draft and the literal of vender-por-delivery (9,000 characters whole) was its
  // card: title, «es larga» and the link, without the cause. T-F22b (ruling): the guide is split into six public guides that each go
  // WHOLE in the literal, word for word; the old id is gone. The connection goes by channel, so a Rappi answer never carries Uber's
  // steps (c71) and an Uber one never carries Rappi's (c72).
  const DELIVERY = [
    'dashboard/ventas/conectar-rappi',
    'dashboard/ventas/solicitar-activacion-uber-eats',
    'dashboard/ventas/horario-margen-y-modo-de-aceptacion',
    'dashboard/ventas/productos-en-delivery',
    'dashboard/ventas/agotados-por-inventario-en-delivery',
    'dashboard/ventas/problemas-con-pedidos-de-delivery',
  ]
  it('T-F22b: Delivery is six guides, each whole in the literal with title, warning and link (and with the worst notices); keywords split, same gate', () => {
    expect(library.some(g => g.id === 'dashboard/ventas/vender-por-delivery')).toBe(false)
    const guides = DELIVERY.map(real)
    expect(guides.every(Boolean)).toBe(true)
    const notice = [SUPPORT_SEND_RETRY_NOTICE, `${supportOldVersion('2.25.10')}\n\n${SUPPORT_HANDOFF_OFFER}`].join('\n\n')
    for (const g of guides) {
      expect([g.id, g.featureCode, g.gateKind, g.requiredPermissions]).toEqual([g.id, 'DELIVERY_CHANNELS', 'FEATURE', []])
      for (const access of [null, emptyAccess, fullAccess])
        for (const n of ['', notice]) {
          const text = literalSupportAnswer([g], access, n)
          expect([g.id, text.includes(wholeGuide(g.body)), text.length <= SUPPORT_LITERAL_CAP]).toEqual([g.id, true, true])
        }
    }
    const keywords = guides.flatMap(g => g.keywords)
    expect(keywords.filter((k, i) => keywords.indexOf(k) !== i)).toEqual([])
  })

  // T-F22c (Codex, codex-tf20-22.md): the sold-out switch only changes a draft that the dialog's «Guardar» sends
  // (ChannelSettingsDialog.tsx, settings.save; origin/main 6632a3e7), and «Solicitar activación» only lives in the first screen
  // (DeliveryTeaser): with another channel active or paused the page shows the channels panel (DeliveryPage.tsx:48).
  it('T-F22c: the sold-out guide says to press Guardar; the Uber guide says what to do when Solicitar activación does not show', () => {
    const soldOut = real('dashboard/ventas/agotados-por-inventario-en-delivery')
    expect(soldOut.body).toContain(
      'Presiona **Guardar**: sale «Ajustes guardados». Si cierras la pantalla sin guardar, el cambio no se aplica.',
    )
    const uber = real('dashboard/ventas/solicitar-activacion-uber-eats')
    expect(uber.body).toContain(
      'Si ya tienes otro canal activo o pausado (por ejemplo, Rappi), la pantalla muestra **Tus canales** y no aparece **Solicitar activación**: pídele la activación de Uber Eats al equipo de Avoqado (ve **Cuándo pedir ayuda**).',
    )
    for (const g of [soldOut, uber])
      expect([g.id, /https?:|www\.|\d{3}[ -]?\d{4}|\d+ (horas|días|minutos)/.test(g.body)]).toEqual([g.id, false])
  })

  it('c71 and c72 (b-tf21-r1): «cómo conecto Rappi» and «no me llegan los pedidos de Uber» have their own guides, without the other channel', () => {
    const [rappi, uber] = [real('dashboard/ventas/conectar-rappi'), real('dashboard/ventas/solicitar-activacion-uber-eats')]
    const problems = real('dashboard/ventas/problemas-con-pedidos-de-delivery')
    expect(rappi.keywords).toContain('cómo conecto Rappi')
    expect(uber.keywords).toContain('cómo conecto Uber Eats')
    for (const k of ['no me llegan los pedidos de Uber', 'no me llegan los pedidos de Rappi', 'me saturé', 'aceptación baja'])
      expect([k, problems.keywords.includes(k)]).toEqual([k, true])
    // c71's noDebeDecir: no Uber Eats or DiDi Food step in the Rappi guide; and no Rappi step in Uber's.
    for (const step of ['Solicitar activación', 'Enviar solicitud', 'Recibimos tu solicitud', 'DiDi'])
      expect([step, rappi.body.includes(step)]).toEqual([step, false])
    for (const step of ['Conectar Rappi', 'Esperando confirmación de Rappi', 'Desconectar de todos modos'])
      expect([step, uber.body.includes(step)]).toEqual([step, false])
    // c72: the cause goes whole in the literal, and no step that is only Rappi's connection.
    const literal = literalSupportAnswer([problems], null)
    for (const cause of ['que el canal diga *Activo*', 'prende *Recibir pedidos*', 'fuera de ese horario la app no te manda pedidos'])
      expect(literal).toContain(cause)
    for (const step of ['Conectar Rappi', '¿No se abrió Rappi?', 'Esperando confirmación de Rappi', 'Desconectar de todos modos'])
      expect(problems.body).not.toContain(step)
    // c71: the Rappi steps go whole in its literal.
    for (const step of ['Presiona *Conectar Rappi*', 'La tienda dice *Esperando confirmación de Rappi* y luego *Conectada*'])
      expect(literalSupportAnswer([rappi], null)).toContain(step)
  })

  it('every guide of the library: its one copy without the numbers is the guide byte for byte, and every line has its number in order', () => {
    const all = loadSupportLibrary({ allowDraft: true })
    expect(all.length).toBeGreaterThanOrEqual(138)
    for (const g of all) {
      expect([g.id, /\[\d+\] /.test(g.body)]).toEqual([g.id, false])
      const { lines, numbered } = numberedGuide(g.body)
      expect([g.id, numbered.replace(/\[\d+\] /g, '') === g.body]).toEqual([g.id, true])
      expect([g.id, [...numbered.matchAll(/\[(\d+)\] /g)].map(m => Number(m[1]))]).toEqual([g.id, lines.map((_l, i) => i + 1)])
    }
  })
})

// T-F10a and T-F10b sorted what the judge said was missing into conditions (appended as «Importante») and operations (refused), to
// stop Codex's two repros on the real reservations guide: the cancel STEP (line 9) given for a check-in question, and line 14 given
// for the warning of line 13. T-F13 (PARADA): nothing is appended, so there is nothing to sort: any real line of the cited guide sends
// the whole guide, where line 9 comes with its own warnings and line 13 next to 14.
describe('T-F13: Codex repros on the reservations guide: any real line the judge gives sends the whole guide', () => {
  const library = loadSupportLibrary({ allowDraft: true })
  const reservations = library.find(g => g.id === 'dashboard/reservaciones/confirmar-o-cancelar-reservacion')!
  const id = reservations.id
  const at = (n: number) => numberedGuide(reservations.body).lines[n - 1]
  const open: DraftLine = {
    text: 'En *Reservaciones* › *Resumen*, toca la reservación para abrirla.',
    guideId: id,
    quote: 'En *Reservaciones* › *Resumen*, toca la reservación para abrirla.',
  }
  const checkIn: SupportDraft = {
    covered: true,
    intro: null,
    steps: [open, { text: 'Cuando el cliente llegue, toca *Check-in*.', guideId: id, quote: 'Cuando el cliente llegue, toca *Check-in*.' }],
  }
  const cancel: SupportDraft = {
    covered: true,
    intro: null,
    steps: [
      open,
      {
        text: 'Toca *Cancelar* y luego *Confirmar Cancelación*.',
        guideId: id,
        quote: 'Para cancelarla, toca *Cancelar* y luego *Confirmar Cancelación*',
      },
    ],
  }
  const whole = literalSupportAnswer([reservations], null)
  const literal = (draft: SupportDraft, missing: MissingLine[]) => {
    expect(hybridDraftOutcome(draft, [reservations], true, missing)).toEqual({ reply: 'literal', fallback: 'judge-rejected' })
    expect(hybridFallback({ reply: 'literal' }, [reservations]).compose(null)).toBe(whole)
  }

  it('repro 1: the cancel step (line 9) given as missing for a check-in question: the whole guide, the step with every warning of its own', async () => {
    expect(at(9)).toBe('Para cancelarla, toca *Cancelar* y luego *Confirmar Cancelación*: sale «Reservación cancelada».')
    expect(reason(checkIn, [reservations])).toBe('ok')
    const { client } = fakeClient({ supported: true, missing: [{ guideId: id, line: 9 }] })
    const verdict = await judgeSupportDraft(
      client,
      { question: '¿Cómo registro que ya llegó el cliente?', draft: checkIn, guides: [reservations] },
      pricing,
    )
    expect(verdict).toMatchObject({ supported: true, missing: [{ guideId: id, line: 9 }] })
    literal(checkIn, verdict.missing)
    expect(whole).toContain(wholeGuide(reservations.body))
    expect(whole).not.toContain('Importante:')
  })

  it('repro 2: line 14 given for the warning of line 13, or both: the whole guide, with 13 and 14 together', () => {
    expect(at(13)).toBe(
      'Si al cancelar sale un error, no lo repitas: la reservación pudo quedar cancelada, con su depósito o sus créditos en proceso.',
    )
    expect(at(14)).toBe('Pide que lo revise una persona del equipo de Avoqado.')
    expect(reason(cancel, [reservations])).toBe('ok')
    literal(cancel, [missingAt(reservations, 14)])
    literal(cancel, [missingAt(reservations, 13), missingAt(reservations, 14)])
    expect(whole).toContain(`${at(13)} ${at(14)}`)
  })

  it('every line of the guide, a step or a condition, with or without a button: the same signal, the whole guide', () => {
    const n = numberedGuide(reservations.body).lines.length
    expect(n).toBe(14)
    for (let line = 1; line <= n; line++) literal(cancel, [missingAt(reservations, line)])
  })
})

// T-F11 (ruling T-F11.3): desde T-F10c la guía literal sale ENTERA hasta 3,500, y safeHistory descarta un turno de más de 2,000
// (scrubSupportText): en la vuelta siguiente entender y la redacción veían la pregunta, pero no que se le mandó una guía. Ahora esa
// respuesta entra al historial como los títulos de sus guías, nunca como su texto. Lo que cabe en el historial no cambia.
describe('T-F11: a literal answer too long for the history reaches the next turn as the titles of its guides, never its text', () => {
  const library = loadSupportLibrary({ allowDraft: true })
  const real = (id: string) => library.find(g => g.id === id)!
  // 2,868 whole: over the 2,000 a history turn may have.
  const liga = real('dashboard/ventas/crear-liga-pago')
  // 986: fits the history as it is.
  const pausar = real('dashboard/ligas-de-pago/pausar-o-archivar-liga-de-pago')
  const QUESTION = '¿Cómo creo una liga de pago?'
  const sentHelp = (answer: string, sourceIds: string[]) => ({ body: QUESTION, answer, sourceIds })
  const historyOf = (create: jest.Mock) => aiInput(create.mock.calls[0][0].input).history

  it('a follow-up turn: understand and the draft see the question and «[Se mandó la guía «…» completa]», not the guide', async () => {
    const answer = literalSupportAnswer([liga], null)
    expect(answer).toContain(wholeGuide(liga.body))
    expect(answer.length).toBeGreaterThan(2000)
    const { history } = hybridHistory([sentHelp(answer, [sourceRef(liga)])], library)
    const understand = fakeClient({ kind: 'question', standalone: '¿Cómo le cambio el monto a una liga?', guideIds: [liga.id] })
    await understandSupportMessage(
      understand.client,
      { message: '¿y cómo le cambio el monto?', app: 'dashboard', history, library: [liga, pausar] },
      pricing,
    )
    const draft = fakeClient(draftJson())
    await draftSupportAnswer(draft.client, { question: '¿Cómo le cambio el monto a una liga?', guides: [liga], history }, pricing)
    for (const create of [understand.create, draft.create]) {
      const sent = historyOf(create)
      expect(sent).toEqual([
        { role: 'user', text: QUESTION },
        { role: 'assistant', text: `[Se mandó la guía «${liga.title}» completa]` },
      ])
      // Never a line of the guide that went out.
      for (const l of wholeGuide(liga.body)
        .split('\n')
        .filter(l => l.trim().length > 20))
        expect(JSON.stringify(sent)).not.toContain(l)
    }
  })

  it('two guides: the first went whole, the second is named too', () => {
    const answer = literalSupportAnswer([liga, pausar], null)
    expect(answer.length).toBeGreaterThan(2000)
    expect(hybridHistory([sentHelp(answer, [sourceRef(liga), sourceRef(pausar)])], library).history[1]).toEqual({
      role: 'assistant',
      text: `[Se mandó la guía «${liga.title}» completa y la guía «${pausar.title}»]`,
    })
  })

  it('an answer that fits the history goes as it is; a long one whose guides are not in the library stays as today (dropped)', async () => {
    const short = literalSupportAnswer([pausar], null)
    expect(short.length).toBeLessThanOrEqual(2000)
    expect(hybridHistory([sentHelp(short, [sourceRef(pausar)])], library).history[1].text).toBe(short)
    const long = literalSupportAnswer([liga], null)
    const unknown = hybridHistory([sentHelp(long, ['dashboard/ventas/ya-no-existe@0123abcd'])], library).history
    expect(unknown[1].text).toBe(long)
    const { client, create } = fakeClient({ kind: 'greeting', standalone: '', guideIds: [] })
    await understandSupportMessage(client, { message: 'gracias', app: 'dashboard', history: unknown, library: [liga] }, pricing)
    expect(historyOf(create)).toEqual([{ role: 'user', text: QUESTION }])
  })
})

// T-F13 (PARADA, ruling T-F13). T-F7, T-F8, T-F10/a/b and T-F12 kept trying to append or cut pieces of a guide safely, and Codex kept
// finding the same family: a piece separated from the condition it depends on. So nothing is cut any more: when an answer is not good
// as drafted, the person gets the WHOLE guide verbatim, or its card if it does not fit. Codex's two repros of codex-tf12, and the
// promise that no path ever outputs a partial guide section.
describe('T-F13: no appended line and no partial section: the draft, the whole guide or its card', () => {
  const library = loadSupportLibrary({ allowDraft: true })
  const unique = library.filter((g, i) => library.findIndex(o => o.id === g.id) === i)
  const real = (id: string) => library.find(g => g.id === id)!
  const source = (g: LibraryGuide) => (g.internal ? supportManualSource(g.title) : g.publicUrl)
  const card = (g: LibraryGuide, access: HelpAccess | null = null) =>
    [g.title, supportWarnings(g, access), g.internal ? SUPPORT_GUIDE_TOO_LONG_MANUAL : SUPPORT_GUIDE_TOO_LONG, source(g)]
      .filter(Boolean)
      .join('\n')
  const overview = real('general/overview')
  /** The raw «## <heading>» section of a guide, up to the next «## ». */
  const rawSection = (g: LibraryGuide, heading: string) => {
    const from = g.body.indexOf(`## ${heading}\n`)
    expect(from).toBeGreaterThanOrEqual(0)
    const to = g.body.indexOf('\n## ', from + 1)
    return wholeGuide(g.body.slice(from, to < 0 ? undefined : to).trim())
  }

  // Codex P1 (codex-tf12, finding 1): «Importante» appended line 16 of the categories guide («Si sigue ahí, revisa que no tenga
  // productos…»), which belongs to DELETING a category and whose condition is line 15, to an answer about EDITING one.
  it('Codex repro 1: line 16 of the categories guide on an «editar» question sends the whole guide, with line 15 before it', async () => {
    const cat = real('dashboard/menu/crear-o-editar-categoria')
    const lines = numberedGuide(cat.body).lines
    expect(lines[15]).toBe('Si sigue ahí, revisa que no tenga productos (muévelos o bórralos antes) y que tengas permiso para borrar.')
    expect(lines[14]).toMatch(/^Si tocas \*Eliminar\*, confirmas y la categoría sigue en pantalla/)
    const edit: SupportDraft = {
      covered: true,
      intro: null,
      steps: [
        line(cat, 'para cambiarla o pausarla, permiso para editar', 'Para cambiarla necesitas permiso para editar.'),
        line(
          cat,
          'Para cambiar una, ábrela en la lista, haz el cambio y toca *Guardar*.',
          'Ábrela en la lista, haz el cambio y toca *Guardar*.',
        ),
      ],
    }
    expect(reason(edit, [cat])).toBe('ok')
    // the judge's line as Codex gave it (in T-F12 with its first words, «Si sigue ahí, revisa»: they matched, and it was appended)
    const m16 = missingAt(cat, 16)
    expect(hybridDraftOutcome(edit, [cat], true, [m16])).toEqual({ reply: 'literal', fallback: 'judge-rejected' })
    expect(judgeMissingSignal(edit, [cat], [m16])).toBe(true)
    const { client } = fakeClient({ supported: true, missing: [{ guideId: cat.id, line: 16 }] })
    const verdict = await judgeSupportDraft(client, { question: '¿Cómo edito una categoría?', draft: edit, guides: [cat] }, pricing)
    expect(hybridDraftOutcome(edit, [cat], verdict.supported, verdict.missing)).toEqual({ reply: 'literal', fallback: 'judge-rejected' })
    const text = hybridFallback({ reply: 'literal' }, [cat]).compose(null)
    expect(text).toBe(literalSupportAnswer([cat], null))
    expect(text).toContain(wholeGuide(cat.body))
    // line 16 goes right after its own condition, line 15 (deleting a category), as the guide has it
    expect(text).toContain(`${lines[14]} ${lines[15]}`)
    expect(text).not.toContain('Importante:')
  })

  // Codex P1 (codex-tf12, finding 2, a REGRESSION of T-F12): from the quotes of a REJECTED draft, the fallback sent «Módulos
  // principales» of general/overview, where the fiscal accounting is described, without «Planes», where it says it is Premium.
  it('Codex repro 2: a rejected draft that says fiscal accounting is in Gratis, quoting «Módulos principales», sends the card of the guide', () => {
    const fiscal: SupportDraft = {
      covered: true,
      intro: {
        text: 'Sí, el plan Gratis incluye la contabilidad: pólizas de doble partida generadas desde cada venta, cobro y gasto.',
        guideId: overview.id,
        quote: 'pólizas de doble partida generadas desde cada venta, cobro y gasto',
      },
      steps: [
        {
          text: 'La contabilidad genera las pólizas de doble partida desde cada venta, cobro y gasto.',
          guideId: overview.id,
          quote: 'pólizas de doble partida generadas desde cada venta, cobro y gasto',
        },
      ],
    }
    expect(reason(fiscal, [overview])).toBe('ok')
    expect(rawSection(overview, 'Módulos principales')).toContain('pólizas de doble partida generadas desde cada venta, cobro y gasto')
    const outcome = hybridDraftOutcome(fiscal, [overview], false, [])!
    expect(outcome).toEqual({ reply: 'literal', fallback: 'judge-rejected' })
    for (const access of [null, emptyAccess, fullAccess]) {
      const text = hybridFallback(outcome, [overview]).compose(access)
      expect(text).toBe(card(overview, access))
      expect(text).not.toContain('pólizas de doble partida')
    }
  })

  it('c06 and c15 of b-tf11-r1 (T-F12 sent «Planes» and «Módulos principales»): rejected or not rendered, the card of general/overview', () => {
    const c06: SupportDraft = {
      covered: true,
      intro: { text: 'El plan Pro cuesta $999 al mes + IVA.', guideId: overview.id, quote: '| **Pro**        | $999 / mes   |' },
      steps: [
        {
          text: 'Confirma el precio vigente en la página de precios de Avoqado.',
          guideId: overview.id,
          quote: 'Confirma siempre el precio vigente en la página de precios de Avoqado.',
        },
      ],
    }
    const c15Line = {
      text: 'El punto de venta funciona sin internet y sincroniza al reconectar.',
      guideId: overview.id,
      quote: 'Funciona sin internet y sincroniza al reconectar.',
    }
    const c15: SupportDraft = { covered: true, intro: c15Line, steps: [c15Line] }
    for (const draft of [c06, c15]) {
      expect(hybridFallback({ reply: 'literal' }, [overview]).compose(null)).toBe(card(overview))
      // a draft that does not render falls back the same way
      const unsafe = { ...overview, publicUrl: 'https://otro.example/help' }
      expect(hybridAnswerText(draft, [unsafe], null).text).toBe(literalSupportAnswer([unsafe], null))
    }
  })

  it('every real guide alone and in a pair with general/overview, any notice and access: each block is the whole guide or its card, never a section', () => {
    const notice = [SUPPORT_SEND_RETRY_NOTICE, `${supportOldVersion('2.25.10')}\n\n${SUPPORT_HANDOFF_OFFER}`].join('\n\n')
    const planes = rawSection(overview, 'Planes')
    const modulos = rawSection(overview, 'Módulos principales')
    const bad: string[] = []
    for (const g of unique) {
      for (const n of ['', notice])
        for (const access of [null, emptyAccess, fullAccess]) {
          const text = literalSupportAnswer([g], access, n)
          if (text.length > SUPPORT_LITERAL_CAP) bad.push(`${g.id} over ${text.length}`)
          if (!text.includes(wholeGuide(g.body)) && !text.includes(card(g, access))) bad.push(`${g.id} neither whole nor card`)
        }
      if (g.id === overview.id) continue
      for (const pair of [
        [overview, g],
        [g, overview],
      ]) {
        const text = literalSupportAnswer(pair, null)
        if (text.length > SUPPORT_LITERAL_CAP) bad.push(`${pair.map(p => p.id).join('+')} over ${text.length}`)
        if (!text.includes(card(overview))) bad.push(`${pair.map(p => p.id).join('+')} overview`)
        if (text.includes(planes) || text.includes(modulos)) bad.push(`${pair.map(p => p.id).join('+')} a section`)
        if (!text.includes(wholeGuide(g.body)) && !text.includes(card(g))) bad.push(`${pair.map(p => p.id).join('+')} ${g.id}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('history: a long literal still reaches the next turn as «[Se mandó la guía «…» completa]»; «una parte de la guía» is gone', () => {
    expect(supportLongAnswerMark(['A', 'B'])).toBe('[Se mandó la guía «A» completa y la guía «B»]')
    expect(supportLongAnswerMark.length).toBe(1)
    const liga = real('dashboard/ventas/crear-liga-pago')
    const long = literalSupportAnswer([liga], null)
    expect(long.length).toBeGreaterThan(2000)
    expect(hybridHistory([{ body: '¿Cómo creo una liga?', answer: long, sourceIds: [sourceRef(liga)] }], library).history[1]).toEqual({
      role: 'assistant',
      text: `[Se mandó la guía «${liga.title}» completa]`,
    })
  })

  it('what T-F7 to T-F12 added is gone: no «Importante» text, no 2,000 cap, no appender, no sections', () => {
    for (const name of ['SUPPORT_IMPORTANT', 'supportDraftCap']) expect([name, name in textsModule]).toEqual([name, false])
    for (const name of ['verifiedMissing', 'isCondition', 'guidePart']) expect([name, name in hybridModule]).toEqual([name, false])
    expect(SUPPORT_DRAFT_CAP).toBe(1500)
    expect(literalSupportAnswer.length).toBeLessThanOrEqual(3)
    expect(hybridFallback.length).toBe(2)
    expect(renderSupportAnswer.length).toBe(3)
    expect(hybridAnswerText.length).toBe(3)
  })
})
/** The quote check of the review, for the fixtures: lower case, no accents, marks or repeated spaces. */
const normalizeForTest = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
