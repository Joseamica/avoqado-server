// src/controllers/dashboard/customerDisplay.dashboard.controller.ts
import type { NextFunction, Request, Response } from 'express'
import { BadRequestError } from '@/errors/AppError'
import { assetKindFromQuery } from '@/schemas/dashboard/customerDisplay.schema'
import * as disenos from '@/services/customer-display/customerDisplayDesign.service'
import * as activos from '@/services/customer-display/customerDisplayAsset.service'

/**
 * La pantalla del cliente de UN dispositivo, vista desde el dashboard (spec §5.5). Extrae, llama, responde: no decide
 * nada. El `venueId` sale SIEMPRE de `req.params`, nunca del cuerpo; y quien actúa, del `authContext`. La bitácora la
 * escriben los servicios (guardar, restablecer, copiar, subir), así que el MCP audita igual que el dashboard.
 */
const staffDe = (req: Request) => (req as any).authContext.userId as string
const envolver = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next)

/** GET / — el diseño, su `editToken`, la ficha efectiva y el estado del aparato. */
export const get = envolver(async (req, res) => {
  res.json({ data: await disenos.getCustomerDisplayForDashboard(req.params.venueId, req.params.terminalId) })
})

/** POST /preview — la ficha de un borrador, SIN guardar; devuelve el `previewSeq` de la petición tal cual. */
export const preview = envolver(async (req, res) => {
  res.json({ data: await disenos.previewCustomerDisplay(req.params.venueId, req.params.terminalId, req.body.design, req.body.previewSeq) })
})

/** PUT / — guardar con CAS sobre el `editToken`. */
export const put = envolver(async (req, res) => {
  const { venueId, terminalId } = req.params
  res.json({
    data: await disenos.saveCustomerDisplayDesign({
      venueId,
      terminalId,
      draft: req.body.design,
      expectedEditToken: req.body.expectedEditToken,
      staffId: staffDe(req),
    }),
  })
})

/** POST /reset — vuelve al diseño de fábrica (se puede siempre, con plan o sin él). */
export const reset = envolver(async (req, res) => {
  const { venueId, terminalId } = req.params
  res.json({
    data: await disenos.resetCustomerDisplayDesign({
      venueId,
      terminalId,
      expectedEditToken: req.body.expectedEditToken,
      staffId: staffDe(req),
    }),
  })
})

/** POST /copy — copia el diseño de ESTE dispositivo a otros del mismo negocio, todo o nada. */
export const copy = envolver(async (req, res) => {
  const { venueId, terminalId } = req.params
  // La ruta nombra el origen: un cuerpo que diga otro sería una copia desde un dispositivo que la URL no autorizó.
  if (req.body.source.terminalId !== terminalId)
    throw new BadRequestError('El origen tiene que ser el dispositivo de la ruta', 'SOURCE_MISMATCH')
  res.json({
    data: await disenos.copyCustomerDisplayDesign({ venueId, staffId: staffDe(req), source: req.body.source, targets: req.body.targets }),
  })
})

/** POST /assets?kind=slide|logo — la subida ya autorizada; aquí sólo se entrega el archivo que leyó multer. */
export const uploadAsset = envolver(async (req, res) => {
  const archivo = (req as any).file as { buffer: Buffer } | undefined
  if (!archivo) throw new BadRequestError('Falta el archivo', 'ASSET_MISSING')
  const { venueId, terminalId } = req.params
  res.status(201).json({
    data: await activos.uploadCustomerDisplayAsset({
      venueId,
      terminalId,
      kind: assetKindFromQuery(req.query.kind), // la MISMA traducción que usó el candado del plan (C9)
      buffer: archivo.buffer,
      staffId: staffDe(req),
    }),
  })
})

/** GET /customer-display/devices — la lista del negocio, paginada con cursor y con el total. */
export const listDevices = envolver(async (req, res) => {
  const { cursor, take } = req.query as unknown as { cursor?: string; take: number }
  res.json({ data: await disenos.listCustomerDisplayDevices({ venueId: req.params.venueId, cursor, take }) })
})
