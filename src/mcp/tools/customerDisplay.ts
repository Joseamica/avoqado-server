import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { customerDisplayDesignDraftSchema } from '@/schemas/dashboard/customerDisplay.schema'
import {
  copyCustomerDisplayDesign,
  getCustomerDisplayForDashboard,
  listCustomerDisplayDevices,
  MAX_COPY_TARGETS,
  previewCopyCustomerDisplay,
  previewCustomerDisplay,
  resetCustomerDisplayDesign,
  saveCustomerDisplayDesign,
} from '@/services/customer-display/customerDisplayDesign.service'
import {
  DEVICES_PAGE_MAX,
  FACTORY_DESIGN,
  validateDesignDraft,
  type DesignValues,
} from '@/services/customer-display/customerDisplayDesign.validation'
import { enLaTablet } from '@/services/customer-display/customerDisplayAckView'

/**
 * El diseño de la PANTALLA DEL CLIENTE de una tablet Android (spec §5.2): 1 lectura y 3 escrituras.
 *
 * 🔴 `customer-display:read` para leer y `customer-display:update` para escribir: el MISMO gate que las rutas del
 * dashboard (MANAGER sí lo tiene, por decisión del founder, spec §5.8).
 * 🔴 Escribir va en DOS PASOS y con `requireWriteScopeAlways`: es lo que ve el cliente del negocio mientras le cobran,
 * y una conexión de sólo lectura no lo cambia aunque la bandera de despliegue esté apagada.
 * 🔴 El CAS no es opcional: sin el token, la IA pisaría en silencio lo que una persona acaba de guardar.
 * 🔴 Se valida ANTES de pedir confirmación, con las MISMAS reglas que el dashboard —el esquema estricto compartido y la
 * vista previa del servidor, plan incluido— y con el token vigente: nunca se confirma algo que el servidor va a rechazar.
 *
 * La bitácora del cambio la escriben los servicios (igual que desde el dashboard); `auditMcpWrite` agrega la fila con
 * `source: 'customer-mcp'` que distingue lo que hizo un agente — el mismo par que las demás tools de escritura.
 */

const PORQUE = 'cambia lo que ve el cliente del negocio mientras le cobran'

/**
 * Un rechazo ESCRITO para el operador (los `AppError` del servicio: 400/403/404/409/422, en español) vuelve como
 * `ok:false` con su código y sus detalles —qué dispositivo, qué imagen—, que es lo que la IA necesita para corregir.
 * Cualquier otra cosa se LANZA: `instrument.ts` la sanea, y un fallo interno nunca le llega crudo a la IA.
 */
function rechazoDelServidor(e: unknown) {
  const err = e as { isOperational?: unknown; message?: string; code?: string; details?: unknown }
  if (typeof e !== 'object' || e === null || err.isOperational !== true) throw e
  return text({
    ok: false,
    error: err.message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.details !== undefined ? { detalles: err.details } : {}),
  })
}

/** El error de forma, en español y nombrando las llaves que sobran (el mensaje del esquema no las dice). */
function errorDeForma(error: z.ZodError): string {
  return error.errors
    .map(e => {
      const donde = e.path.length > 0 ? `${e.path.join('.')}: ` : ''
      const llaves = e.code === 'unrecognized_keys' ? ` (${e.keys.join(', ')})` : ''
      return `${donde}${e.message}${llaves}`
    })
    .join('; ')
}

/** Guardar con un token viejo da 409: se dice ANTES de ofrecer confirmar, con el token vigente para releer. */
function tokenViejo(editTokenActual: string) {
  return text({
    ok: false,
    code: 'CUSTOMER_DISPLAY_CONFLICT',
    error:
      'El diseño cambió desde que lo leíste (alguien más lo guardó). Vuelve a leerlo con customer_display_design y usa el token vigente.',
    editTokenActual,
  })
}

const sinCambios = (mensaje: string) => text({ ok: false, code: 'NO_CHANGES', error: mensaje })

/** Los valores completos de un diseño leído (el servicio siempre los da completos; esto sólo evita tronar con uno parcial). */
const valoresDe = (d: Partial<DesignValues> | undefined): DesignValues => ({ ...FACTORY_DESIGN, ...d, slides: [...(d?.slides ?? [])] })

const ETIQUETA: Record<keyof DesignValues, string> = {
  theme: 'Tema',
  accentColor: 'Color de acento',
  logoAssetId: 'Logo',
  welcomeText: 'Texto de bienvenida',
  thanksText: 'Texto de agradecimiento',
  slides: 'Imágenes en reposo',
  slideSeconds: 'Segundos por imagen',
  showPromotions: 'Tarjetas de promociones en reposo',
}

const imagenes = (n: number) => (n === 0 ? 'ninguna' : n === 1 ? '1 imagen' : `${n} imágenes`)

/** Lo que un destino CONSERVA de sus propias imágenes al copiar (0, 1 o N — nunca «conserva sus ninguna»). */
const conservaSusImagenesTexto = (n: number) =>
  n === 0 ? 'no tiene imágenes propias que conservar' : n === 1 ? 'conserva su imagen' : `conserva sus ${imagenes(n)}`

/** Un valor como lo diría una persona. `null` es «el de fábrica» (o el logo del negocio): nunca «null». */
function legible(campo: keyof DesignValues, v: DesignValues): string {
  switch (campo) {
    case 'theme':
      return v.theme === 'DARK' ? 'oscuro' : 'claro'
    case 'accentColor':
      return v.accentColor ?? 'el de fábrica'
    case 'logoAssetId':
      return v.logoAssetId === null ? 'el logo del negocio' : `una imagen subida (${v.logoAssetId})`
    case 'welcomeText':
    case 'thanksText':
      return v[campo] === null ? 'el de fábrica' : `«${v[campo]}»`
    case 'slides':
      return imagenes(v.slides.length)
    case 'slideSeconds':
      return `${v.slideSeconds} s`
    case 'showPromotions':
      return v.showPromotions ? 'encendidas' : 'apagadas'
  }
}

/** La vista legible `antes → después`, sólo de lo que de verdad cambia (regla del MCP para toda escritura confirmada). */
function describirCambios(antes: DesignValues, despues: DesignValues): string[] {
  return (Object.keys(ETIQUETA) as (keyof DesignValues)[]).flatMap(campo => {
    if (JSON.stringify(antes[campo]) === JSON.stringify(despues[campo])) return []
    if (campo === 'slides' && antes.slides.length === despues.slides.length) {
      return [`${ETIQUETA.slides}: cambian cuáles o su orden (${imagenes(despues.slides.length)})`]
    }
    return [`${ETIQUETA[campo]}: ${legible(campo, antes)} → ${legible(campo, despues)}`]
  })
}

export function registerCustomerDisplayTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'customer_display_design',
    "How the CUSTOMER-FACING screen of a venue's Android POS tablet looks today: theme, brand color, logo, welcome and thank-you texts, idle images, and whether the device is actually reporting that second screen. enLaTablet.estado says what the tablet does with the saved design: MOSTRADO (shown), GUARDADO (stored, not shown yet), RECIBIDO (received, not stored yet), PENDIENTE (it still has an older design), KIOSCO (stored, the tablet is in kiosk mode), NO_SOPORTADO (its app version can't draw this design), SIN_ACUSE (the tablet hasn't confirmed anything yet) or APP_SIN_DISENOS (the app needs updating to show designs). Returns the editToken you need to change it. Omit terminalId to LIST the venue's Android POS tablets (paged, with total) — not only the ones with a customer screen, since not every tablet has one and some haven't reported yet; each one in the list says whether it actually has that screen, doesn't, or it's unknown — and pick one by id; never guess which. Answers \"¿cómo se ve la pantalla del cliente?\", \"¿por qué no sale mi logo en la segunda pantalla?\". Requires customer-display:read.",
    {
      venueId: z.string().describe('Venue that owns the device (must be in your scope)'),
      terminalId: z.string().min(1).optional().describe('The Android POS tablet. Omit it to list the venue devices and choose one'),
      cursor: z.string().min(1).optional().describe('nextCursor from the previous page of the device list'),
    },
    async ({ venueId, terminalId, cursor }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('customer-display:read', venueId)

      // Resolver, no adivinar: sin decir CUÁL dispositivo se listan los del negocio (acotado, con total y cursor).
      if (!terminalId) {
        const lista = await listCustomerDisplayDevices({ venueId, cursor, take: DEVICES_PAGE_MAX })
        return text({
          mensaje: 'Elige el dispositivo por su id y vuelve a llamar con terminalId.',
          total: lista.total,
          nextCursor: lista.nextCursor,
          dispositivos: lista.devices,
        })
      }

      const vista = await getCustomerDisplayForDashboard(venueId, terminalId)
      return text({
        dispositivo: vista.terminal,
        editToken: vista.editToken,
        diseno: vista.design,
        loQueVeElCliente: vista.ficha,
        plan: vista.entitlements,
        imagenesRechazadas: vista.assetRejected,
        aparato: vista.device,
        // Qué muestra la tablet AHORA, decidido al leer con la regla del panel (R4): la IA no compara huellas.
        enLaTablet: enLaTablet(vista.device.ack, vista.ficha.fingerprint, vista.device.designVersion),
      })
    },
  )

  server.tool(
    'update_customer_display_design',
    'Change the CUSTOMER-FACING screen design of one Android POS tablet: theme, brand color, logo, welcome and thank-you texts, idle images, seconds per image, promotion cards. Send ONLY the fields you want to change. TWO STEPS — the first call validates with the same rules as the dashboard (plan included) and shows, in Spanish, each field before → after and what the customer would see; nothing is saved until you call again with the same arguments, confirm:true and the confirmationToken returned by the first call. Needs the editToken from customer_display_design. Requires customer-display:update.',
    {
      venueId: z.string().describe('Venue that owns the device (must be in your scope)'),
      terminalId: z.string().min(1).describe('The Android POS tablet'),
      expectedEditToken: z.string().min(1).describe('Token you are editing from — get it from customer_display_design'),
      design: customerDisplayDesignDraftSchema.describe(
        'Only the fields to change: theme (LIGHT|DARK), accentColor (#RRGGBB or null), logoAssetId, welcomeText, thanksText (null = factory text), slides [{assetId}], slideSeconds (5-30), showPromotions',
      ),
      confirm: z.boolean().optional().describe('Set true on the SECOND call to actually save'),
    },
    async ({ venueId, terminalId, expectedEditToken, design, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('customer-display:update', venueId)
      requireWriteScopeAlways(scope, 'customer-display:update', PORQUE)

      // 1. La FORMA, con el mismo esquema estricto que el dashboard. En producción el SDK del MCP ya valida la forma
      //    de `design` ANTES de invocar este handler (la IA recibiría el error genérico del SDK, no éste) — este
      //    `safeParse` es defensa en profundidad para quien llame al handler directo (pruebas, otros llamadores).
      const forma = customerDisplayDesignDraftSchema.safeParse(design)
      if (!forma.success) return text({ ok: false, code: 'INVALID_DESIGN', error: errorDeForma(forma.error) })

      // 2. Las REGLAS (valores, plan, pertenencia de las imágenes), con la vista previa del servidor: no persiste nada.
      let vista: Awaited<ReturnType<typeof previewCustomerDisplay>>
      try {
        vista = await previewCustomerDisplay(venueId, terminalId, forma.data, 0)
      } catch (e) {
        return rechazoDelServidor(e)
      }
      // La vista previa DEPURA las imágenes que no sirven (así la pinta el editor); guardar las RECHAZA con
      // `ASSET_NOT_USABLE` (la misma regla, `assertAssetsUsable`). Aquí se rechaza ya: no se confirma un error.
      if (vista.assetRejected.length > 0) {
        return text({
          ok: false,
          code: 'ASSET_NOT_USABLE',
          error: 'Estas imágenes no existen en este negocio o no sirven para ese lugar. Súbelas de nuevo.',
          assetIds: vista.assetRejected,
        })
      }

      if (!confirm) {
        let antes: Awaited<ReturnType<typeof getCustomerDisplayForDashboard>>
        try {
          antes = await getCustomerDisplayForDashboard(venueId, terminalId)
        } catch (e) {
          return rechazoDelServidor(e)
        }
        if (antes.editToken !== expectedEditToken) return tokenViejo(antes.editToken)

        // Los valores que quedarían, con la MISMA normalización que el servidor (texto limpio, color en mayúsculas). El
        // plan ya lo decidió la vista previa de arriba; aquí sólo se calcula qué se enseña.
        const actual = valoresDe(antes.design)
        const resultado = validateDesignDraft(forma.data, actual, { puedeUsarPromos: true })
        if (!resultado.ok) return text({ ok: false, code: resultado.code, error: resultado.message })
        const cambios = describirCambios(actual, resultado.value)
        if (cambios.length === 0) return sinCambios('El diseño ya está así: no hay nada que guardar.')

        return text({
          ok: false,
          requiresConfirmation: true,
          mensaje: 'Así lo vería el cliente. Vuelve a llamar con confirm:true para guardarlo.',
          cambios,
          antes: antes.ficha,
          despues: vista.ficha,
          editTokenActual: antes.editToken,
        })
      }

      let guardado: Awaited<ReturnType<typeof saveCustomerDisplayDesign>>
      try {
        guardado = await saveCustomerDisplayDesign({ venueId, terminalId, draft: forma.data, expectedEditToken, staffId: scope.staffId })
      } catch (e) {
        return rechazoDelServidor(e)
      }
      await auditMcpWrite(scope, {
        action: 'CUSTOMER_DISPLAY_DESIGN_UPDATED',
        entity: 'CustomerDisplayDesign',
        entityId: terminalId,
        venueId,
        data: { editToken: guardado.editToken },
      })
      return text({
        ok: true,
        editToken: guardado.editToken,
        loQueVeElCliente: guardado.ficha,
        ...(guardado.assetRejected?.length ? { imagenesRechazadas: guardado.assetRejected } : {}),
      })
    },
  )

  server.tool(
    'copy_customer_display_design',
    `Copy the CUSTOMER-FACING screen design of one Android POS tablet to 1-${MAX_COPY_TARGETS} other tablets of the same venue. All or nothing: if any tablet changed meanwhile, nothing is copied. Without the PRO plan, brand, texts and logo are copied and each tablet KEEPS its own idle images. TWO STEPS — the first call runs the same checks as the copy and lists, per tablet, what would happen; nothing is copied until you call again with the same arguments, confirm:true and the confirmationToken returned by the first call. Needs each editToken from customer_display_design. Requires customer-display:update.`,
    {
      venueId: z.string().describe('Venue that owns the tablets (must be in your scope)'),
      sourceTerminalId: z.string().min(1).describe('The tablet whose design is copied'),
      sourceEditToken: z.string().min(1).describe('editToken of the source tablet'),
      targets: z
        .array(z.object({ terminalId: z.string().min(1), editToken: z.string().min(1) }))
        .min(1)
        .max(MAX_COPY_TARGETS)
        .describe('The tablets that receive the design, each with its own editToken'),
      confirm: z.boolean().optional().describe('Set true on the SECOND call to actually copy'),
    },
    async ({ venueId, sourceTerminalId, sourceEditToken, targets, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('customer-display:update', venueId)
      requireWriteScopeAlways(scope, 'customer-display:update', PORQUE)

      const source = { terminalId: sourceTerminalId, editToken: sourceEditToken }

      if (!confirm) {
        // La MISMA revisión que la copia (pertenencia, compatibilidad, tokens, imágenes por destino), sin escribir.
        let vista: Awaited<ReturnType<typeof previewCopyCustomerDisplay>>
        try {
          vista = await previewCopyCustomerDisplay({ venueId, source, targets })
        } catch (e) {
          return rechazoDelServidor(e)
        }
        // 🔴 El diseño que se enseña es el que la vista previa REVISÓ, no una relectura: entre las dos, otra persona pudo
        // guardar y se estaría pidiendo confirmar algo distinto de lo validado (Codex r9).
        const cambios = vista.destinos.map(d => {
          const nombre = d.nombre || d.terminalId
          return d.conservaSusImagenes
            ? `${nombre}: su diseño se sustituye por el del origen; ${conservaSusImagenesTexto(d.imagenes)}`
            : `${nombre}: su diseño se sustituye por completo por el del origen (${imagenes(d.imagenes)})`
        })
        return text({
          ok: false,
          requiresConfirmation: true,
          mensaje: vista.promosOmitted
            ? `Se copiarían marca, textos y logo a ${targets.length} dispositivo(s); sin el plan PRO, cada uno CONSERVA sus propias imágenes. Vuelve a llamar con confirm:true.`
            : `Se copiaría este diseño completo a ${targets.length} dispositivo(s) y se sustituiría el suyo. Vuelve a llamar con confirm:true.`,
          cambios,
          diseno: vista.origen.diseno,
          promosOmitted: vista.promosOmitted,
          destinos: vista.destinos,
        })
      }

      let r: Awaited<ReturnType<typeof copyCustomerDisplayDesign>>
      try {
        r = await copyCustomerDisplayDesign({ venueId, staffId: scope.staffId, source, targets })
      } catch (e) {
        return rechazoDelServidor(e)
      }
      await auditMcpWrite(scope, {
        action: 'CUSTOMER_DISPLAY_DESIGN_COPIED',
        entity: 'CustomerDisplayDesign',
        entityId: sourceTerminalId,
        venueId,
        data: { copied: r.copied, promosOmitted: r.promosOmitted },
      })
      return text({ ok: true, ...r })
    },
  )

  server.tool(
    'reset_customer_display_design',
    'Put the CUSTOMER-FACING screen of one Android POS tablet back to the factory design (as it looks without customization). Always allowed, with or without the PRO plan. TWO STEPS — the first call only shows, in Spanish, what would be lost (each field before → factory); nothing changes until you call again with the same arguments, confirm:true and the confirmationToken returned by the first call. Needs the editToken from customer_display_design. Requires customer-display:update.',
    {
      venueId: z.string().describe('Venue that owns the device (must be in your scope)'),
      terminalId: z.string().min(1).describe('The Android POS tablet'),
      expectedEditToken: z.string().min(1).describe('Token you are editing from — get it from customer_display_design'),
      confirm: z.boolean().optional().describe('Set true on the SECOND call to actually reset'),
    },
    async ({ venueId, terminalId, expectedEditToken, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('customer-display:update', venueId)
      requireWriteScopeAlways(scope, 'customer-display:update', PORQUE)

      if (!confirm) {
        let antes: Awaited<ReturnType<typeof getCustomerDisplayForDashboard>>
        try {
          antes = await getCustomerDisplayForDashboard(venueId, terminalId)
        } catch (e) {
          return rechazoDelServidor(e)
        }
        if (antes.editToken !== expectedEditToken) return tokenViejo(antes.editToken)
        const cambios = describirCambios(valoresDe(antes.design), valoresDe(FACTORY_DESIGN))
        if (cambios.length === 0) return sinCambios('Ya tiene el diseño de fábrica: no hay nada que restablecer.')
        return text({
          ok: false,
          requiresConfirmation: true,
          mensaje: 'Se perdería este diseño y volvería al de fábrica. Vuelve a llamar con confirm:true.',
          cambios,
          seQuitaria: antes.design,
          editTokenActual: antes.editToken,
        })
      }

      let r: Awaited<ReturnType<typeof resetCustomerDisplayDesign>>
      try {
        r = await resetCustomerDisplayDesign({ venueId, terminalId, expectedEditToken, staffId: scope.staffId })
      } catch (e) {
        return rechazoDelServidor(e)
      }
      await auditMcpWrite(scope, {
        action: 'CUSTOMER_DISPLAY_DESIGN_RESET',
        entity: 'CustomerDisplayDesign',
        entityId: terminalId,
        venueId,
        data: { editToken: r.editToken },
      })
      return text({ ok: true, editToken: r.editToken })
    },
  )
}
