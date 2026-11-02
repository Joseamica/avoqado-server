// src/schemas/dashboard/customerDisplay.schema.ts
import { z } from 'zod'
import { BadRequestError } from '@/errors/AppError'
import type { AssetKind } from '@/services/customer-display/customerDisplayAsset.service'
import { DEVICES_PAGE_MAX, MAX_COPY_TARGETS, MAX_SLIDES } from '@/services/customer-display/customerDisplayDesign.validation'

/**
 * La FORMA de las rutas de la pantalla del cliente (spec §5.5). Sólo forma y en español: las reglas del negocio —el
 * plan, la pertenencia de la terminal, el tope de textos— viven en los servicios.
 */

const params = z.object({
  venueId: z.string().min(1, { message: 'Falta el negocio' }),
  terminalId: z.string().min(1, { message: 'Falta el dispositivo' }),
})

/**
 * 🔴 Todo `z.object` lleva su mensaje, y el `.strict()` también: sin él, Zod suelta su texto por defecto EN INGLÉS
 * («Expected object, received string», «Unrecognized key(s) in object»), y `validateRequest` se lo enseña tal cual al
 * usuario (revisión de la Task 11, hallazgo menor 1). `required_error` e `invalid_type_error` por separado: «falta» y «no
 * es válido» se arreglan distinto.
 */
const objeto = (falta: string, noValido: string) => ({ required_error: falta, invalid_type_error: noValido })

/** El borrador ESTRICTO. Lo comparten las rutas y el MCP (Task 12): una sola definición de qué campos existen. */
export const customerDisplayDesignDraftSchema = z
  .object(
    {
      theme: z.enum(['LIGHT', 'DARK'], { message: 'El tema sólo puede ser claro u oscuro' }).optional(),
      accentColor: z.string({ message: 'El color no es válido' }).nullable().optional(),
      logoAssetId: z.string({ message: 'El logo no es válido' }).min(1, { message: 'El logo no es válido' }).nullable().optional(),
      welcomeText: z.string({ message: 'El texto de bienvenida no es válido' }).nullable().optional(),
      thanksText: z.string({ message: 'El texto de agradecimiento no es válido' }).nullable().optional(),
      slides: z
        .array(
          z.object(
            { assetId: z.string({ message: 'La imagen no es válida' }).min(1, { message: 'La imagen no es válida' }) },
            objeto('La imagen no es válida', 'La imagen no es válida'),
          ),
          { message: 'Las imágenes no son válidas' },
        )
        .max(MAX_SLIDES, { message: `No caben más de ${MAX_SLIDES} imágenes` })
        .optional(),
      slideSeconds: z
        .number({ message: 'Los segundos por imagen no son válidos' })
        .int({ message: 'Los segundos tienen que ser enteros' })
        .optional(),
      showPromotions: z.boolean({ message: 'El interruptor de promociones no es válido' }).optional(),
    },
    objeto('Falta el diseño', 'El diseño no es válido'),
  )
  // 🔴 nada de lo que no esté aquí pasa. El `venueId` sale de la URL, nunca del cuerpo.
  .strict({ message: 'El diseño trae un campo que no existe' })

const expectedEditToken = z.string({ message: 'Falta el token de edición' }).min(1, { message: 'Falta el token de edición' })
const destinoCon = (falta: string, noValido: string) =>
  z.object(
    {
      terminalId: z.string({ message: 'Falta el dispositivo' }).min(1, { message: 'Falta el dispositivo' }),
      editToken: z.string({ message: 'Falta el token de edición' }).min(1, { message: 'Falta el token de edición' }),
    },
    objeto(falta, noValido),
  )
const cuerpo = objeto('Falta el cuerpo de la petición', 'El cuerpo de la petición no es válido')

export const getCustomerDisplaySchema = z.object({ params })

export const previewCustomerDisplaySchema = z.object({
  params,
  body: z.object(
    {
      design: customerDisplayDesignDraftSchema,
      // El número lo pone el EDITOR y el servidor lo devuelve tal cual (Task 5): así descarta respuestas viejas.
      previewSeq: z
        .number({ message: 'Falta el número de vista previa' })
        .int({ message: 'El número de vista previa no es válido' })
        .min(0, { message: 'El número de vista previa no es válido' }),
    },
    cuerpo,
  ),
})

export const putCustomerDisplaySchema = z.object({
  params,
  body: z.object({ expectedEditToken, design: customerDisplayDesignDraftSchema }, cuerpo),
})

export const resetCustomerDisplaySchema = z.object({ params, body: z.object({ expectedEditToken }, cuerpo) })

export const copyCustomerDisplaySchema = z.object({
  params,
  body: z.object(
    {
      source: destinoCon('Falta el dispositivo de origen', 'El dispositivo de origen no es válido'),
      targets: z
        .array(destinoCon('Falta un dispositivo de destino', 'Un dispositivo de destino no es válido'), {
          message: 'Los dispositivos de destino no son válidos',
        })
        .min(1, { message: 'Elige al menos un dispositivo' })
        // M5 (revisión final): el MISMO tope que usa el servicio y el MCP — un `20` a mano aquí divergiría en silencio
        // si alguien cambiara sólo `MAX_COPY_TARGETS`.
        .max(MAX_COPY_TARGETS, { message: `No puedes copiar a más de ${MAX_COPY_TARGETS} dispositivos a la vez` }),
    },
    cuerpo,
  ),
})

export const uploadAssetSchema = z.object({
  params,
  query: z.object({ kind: z.enum(['slide', 'logo'], { message: 'El tipo tiene que ser slide o logo' }) }),
})

/**
 * 🔴 UNA sola traducción del `kind` de la consulta (C9): la usan el candado del plan de la ruta Y el controlador, así que
 * el plan y el servicio no pueden recibir tipos distintos. Falla CERRADO: lo que no sea exactamente `slide` o `logo` es
 * un 400 — antes era `kind === 'slide' ? 'SLIDE' : 'LOGO'`, que convertía cualquier otra cosa en un logo (gratis).
 */
export function assetKindFromQuery(kind: unknown): AssetKind {
  if (kind === 'slide') return 'SLIDE'
  if (kind === 'logo') return 'LOGO'
  throw new BadRequestError('El tipo tiene que ser slide o logo', 'INVALID_ASSET_KIND')
}

export const listDevicesSchema = z.object({
  params: z.object({ venueId: z.string().min(1, { message: 'Falta el negocio' }) }),
  query: z.object({
    // Con `message` en el tipo: `?cursor=a&cursor=b` llega como ARREGLO y, sin él, el error saldría en inglés.
    cursor: z.string({ message: 'El cursor no es válido' }).min(1, { message: 'El cursor no es válido' }).optional(),
    // 🔴 UNA política: el servidor TOPA (regla del workspace, «bounded queries»), no rechaza. Un cliente viejo que pida
    // de más recibe la página máxima y el `nextCursor` para seguir.
    take: z.coerce
      .number({ message: 'take tiene que ser un número' })
      .int({ message: 'take tiene que ser entero' })
      .min(1, { message: 'take tiene que ser al menos 1' })
      .default(25)
      .transform(n => Math.min(n, DEVICES_PAGE_MAX)),
  }),
})
