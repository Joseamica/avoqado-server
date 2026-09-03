// src/controllers/dashboard/marketingCampaign.dashboard.controller.ts
import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import { NotFoundError } from '@/errors/AppError'
import { guardarBorrador } from '@/services/marketing/campaignDraft.service'
import { previsualizarEnvio, publicarCampana } from '@/services/marketing/campaignPublish.service'

/**
 * Controlador delgado de campañas de correo a clientes — Fase 1C-A, Task 6.
 *
 * Guardar borrador, previsualizar y publicar delegan en los servicios de las tareas
 * 3-5 (`campaignDraft.service.ts`, `campaignPublish.service.ts`) — este archivo no
 * repite ninguna de esas reglas de negocio. Listar y ver el detalle SÍ consultan
 * `CustomerCampaign` directamente (no hay servicio propio para eso todavía): siempre
 * con `venueId` en el `where`, como el resto del repo — nunca `findUnique` por id
 * pelón.
 */

function actorStaffId(req: Request): string | undefined {
  return (req as any).authContext?.userId
}

export async function listCampaigns(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const page = req.query.page ? Number(req.query.page) : 1
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 20

    const [items, total] = await Promise.all([
      prisma.customerCampaign.findMany({
        where: { venueId },
        // 🔴 `select` acotado, NO la fila completa. `htmlBody` y `textBody` son `@db.Text`
        // (el correo renderizado entero) y `contentBlocks` es el JSON del editor: ninguno
        // se pinta en un renglón de lista, y con el pageSize por default se multiplicarían
        // por 20 en cada carga de pantalla. Es la misma familia que el `include` sin tope de
        // `getVenueById` (2026-09-01) y lo que pide
        // `.claude/rules/bounded-queries-and-server-load.md`. El DETALLE (`getCampaign`) sí
        // los devuelve: ahí es una fila y el editor los necesita para reabrir la campaña.
        select: {
          id: true,
          name: true,
          subject: true,
          status: true,
          audience: true,
          customerGroupId: true,
          tags: true,
          totalRecipients: true,
          sentCount: true,
          failedCount: true,
          skippedCount: true,
          scheduledFor: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.customerCampaign.count({ where: { venueId } }),
    ])

    res.json({ items, total, page, pageSize })
  } catch (error) {
    next(error)
  }
}

export async function getCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, id } = req.params
    const campaign = await prisma.customerCampaign.findFirst({ where: { id, venueId } })
    if (!campaign) {
      throw new NotFoundError('La campaña no existe en este negocio.')
    }
    res.json(campaign)
  } catch (error) {
    next(error)
  }
}

export async function createCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const result = await guardarBorrador({ venueId, actorStaffId: actorStaffId(req), ...req.body })
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
}

export async function updateCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, id } = req.params
    const result = await guardarBorrador({ venueId, campaignId: id, actorStaffId: actorStaffId(req), ...req.body })
    res.json(result)
  } catch (error) {
    next(error)
  }
}

export async function previewCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, id } = req.params
    const result = await previsualizarEnvio({ venueId, campaignId: id })
    res.json(result)
  } catch (error) {
    next(error)
  }
}

export async function publishCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, id } = req.params
    const { token } = req.body
    const result = await publicarCampana({ venueId, campaignId: id, token, actorStaffId: actorStaffId(req) })
    res.json(result)
  } catch (error) {
    next(error)
  }
}
