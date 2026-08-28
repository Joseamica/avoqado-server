/**
 * Anuncios de plataforma — controlador de superadmin.
 *
 * Protegido por el router padre (`superadmin.routes.ts`), que ya aplica
 * `authenticateTokenMiddleware` + `authorizeRole([StaffRole.SUPERADMIN])`.
 * 🔴 NO repetir el guardia aquí ni en la subruta.
 */
import { uploadAnnouncementImage } from '@/services/announcements/announcementImage.service'
import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { BadRequestError } from '@/errors/AppError'
import { NotificationPriority, StaffRole, PlanTier } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { countAudience } from '../../services/announcements/audience.service'
import { getAnnouncementMetrics } from '../../services/announcements/announcementRead.service'
import {
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  scheduleAnnouncement,
  archiveAnnouncement,
  publishAnnouncement,
} from '../../services/announcements/announcement.service'

const CATEGORIAS = ['FOOD_SERVICE', 'RETAIL', 'SERVICES', 'HOSPITALITY', 'ENTERTAINMENT', 'OTHER'] as const

/**
 * Catálogo de bloques del contenido ampliado.
 *
 * 🔴 `discriminatedUnion` es lo que impide guardar un bloque con un `type` inventado.
 * Un tipo desconocido se rechaza AL ESCRIBIR; ignorarlo al leer es la defensa del
 * cliente viejo, no la del servidor.
 */
const bloque = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: z.string().min(1) }),
  z.object({ type: z.literal('paragraph'), text: z.string().min(1) }),
  z.object({ type: z.literal('bullets'), items: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('image'), url: z.string().url(), alt: z.string().min(1), caption: z.string().optional() }),
  z.object({
    type: z.literal('gallery'),
    images: z.array(z.object({ url: z.string().url(), alt: z.string().min(1), caption: z.string().optional() })).min(1),
  }),
  z.object({ type: z.literal('specs'), rows: z.array(z.object({ label: z.string(), value: z.string() })).min(1) }),
  z.object({ type: z.literal('callout'), tone: z.enum(['info', 'warning', 'success']), text: z.string().min(1) }),
  z.object({ type: z.literal('button'), label: z.string().min(1), url: z.string().url() }),
  z.object({
    type: z.literal('video'),
    provider: z.enum(['youtube', 'vimeo']),
    videoId: z.string().min(1),
    thumbnailUrl: z.string().url().optional(),
  }),
  z.object({ type: z.literal('divider') }),
])

const filtrosSchema = z.object({
  audienceRoles: z.array(z.nativeEnum(StaffRole)).min(1, 'Elige al menos un rol'),
  targetPlanTiers: z.array(z.nativeEnum(PlanTier)).default([]),
  targetCategories: z.array(z.enum(CATEGORIAS)).default([]),
  targetVenueIds: z.array(z.string()).default([]),
})

const announcementSchema = filtrosSchema.extend({
  title: z.string().min(1, 'El título es obligatorio'),
  body: z.string().min(1, 'El texto es obligatorio'),
  imageUrl: z.string().url('La imagen debe ser una URL válida').optional(),
  priority: z.nativeEnum(NotificationPriority).default(NotificationPriority.NORMAL),
  actionLabel: z.string().optional(),
  actionUrl: z.string().optional(),
  contentBlocks: z.array(bloque).optional(),
  showAsBanner: z.boolean().default(false),
  showAsModal: z.boolean().default(false),
  expiresAt: z.coerce.date().optional(),
})

/**
 * Traduce un error de validación a algo que se pueda leer.
 *
 * 🔴 Sin esto el compositor mostraba el JSON crudo de Zod con un 500 —
 * `[{"code":"too_small","path":["contentBlocks",0,"text"]}]` — que no le dice a nadie qué
 * arreglar. Y el status era 500 (falla del servidor) cuando en realidad faltaba un dato
 * del formulario, que es 400. Lo encontró el founder el 2026-08-27 subiendo una foto.
 */
function errorDeValidacion(error: unknown): BadRequestError | null {
  if (!(error instanceof z.ZodError)) return null

  const CAMPOS: Record<string, string> = {
    text: 'el texto',
    alt: 'la descripción de la foto',
    label: 'la etiqueta',
    value: 'el valor',
    url: 'la dirección de la imagen',
    items: 'los puntos',
    title: 'el título',
    body: 'el texto del aviso',
  }

  const detalles = error.issues.map(issue => {
    const ruta = issue.path
    // Los errores de bloques se dicen por su número, que es lo que la persona ve.
    if (ruta[0] === 'contentBlocks' && typeof ruta[1] === 'number') {
      const campo = CAMPOS[String(ruta[2])] ?? String(ruta[2])
      return `Al bloque ${Number(ruta[1]) + 1} le falta ${campo}`
    }
    const campo = CAMPOS[String(ruta[0])] ?? String(ruta[0])
    return `Revisa ${campo}`
  })

  return new BadRequestError(detalles.join('. '))
}

export const list = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { announcements: await listAnnouncements() } })
  } catch (error) {
    next(error)
  }
}

export const create = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req as any).authContext
    const input = announcementSchema.parse(req.body)
    const autor = await prisma.staff.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } })
    const nombre = autor ? `${autor.firstName} ${autor.lastName}`.trim() : 'Avoqado'
    const announcement = await createAnnouncement(input, userId, nombre)
    res.status(201).json({ success: true, data: { announcement } })
  } catch (error) {
    next(errorDeValidacion(error) ?? error)
  }
}

export const update = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = announcementSchema.partial().parse(req.body)
    res.json({ success: true, data: { announcement: await updateAnnouncement(req.params.id, input) } })
  } catch (error) {
    next(errorDeValidacion(error) ?? error)
  }
}

/** Conteo en vivo del compositor: negocios y personas son DOS números distintos. */
export const previewAudience = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await countAudience(filtrosSchema.parse(req.body)) })
  } catch (error) {
    next(error)
  }
}

export const publish = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { scheduledFor } = z.object({ scheduledFor: z.coerce.date().optional() }).parse(req.body ?? {})
    if (scheduledFor) {
      const announcement = await scheduleAnnouncement(req.params.id, scheduledFor)
      return res.json({ success: true, data: { announcement, scheduled: true } })
    }
    res.json({ success: true, data: await publishAnnouncement(req.params.id) })
  } catch (error) {
    next(error)
  }
}

export const archive = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { announcement: await archiveAnnouncement(req.params.id) } })
  } catch (error) {
    next(error)
  }
}

/** Si no hay llave de IA, el compositor esconde el botón en vez de fallar al tocarlo. */
export const capabilities = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { aiCopy: Boolean(process.env.OPENAI_API_KEY) } })
  } catch (error) {
    next(error)
  }
}

export const metrics = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await getAnnouncementMetrics(req.params.id) })
  } catch (error) {
    next(error)
  }
}

/**
 * Sube una foto para usarla en un bloque del anuncio.
 *
 * Devuelve la URL pública, que el compositor pega en el bloque. Las fotos de un anuncio
 * NO son datos personales: las ve cualquier negocio que lo reciba.
 */
export const uploadImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const file = (req as any).file
    if (!file) {
      res.status(400).json({ success: false, message: 'No llegó ninguna imagen' })
      return
    }
    const url = await uploadAnnouncementImage(file.buffer, file.mimetype, file.originalname)
    res.json({ success: true, data: { url } })
  } catch (error) {
    next(error)
  }
}
