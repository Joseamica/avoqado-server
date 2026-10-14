import { NextFunction, Request, Response } from 'express'

import { conTurnoDeReporte, generarArchivo } from '@/services/dashboard/settlementReport/settlementReport.export'
import {
  construirReporte,
  contarCandidatos,
  opcionesDeTerminal,
  TOPE_CSV,
  TOPE_XLSX,
} from '@/services/dashboard/settlementReport/settlementReport.service'

type Q = Record<string, unknown>

// validateRequest ya dejó los filtros como arreglo (no se re-parsea: un arreglo no pasa z.string()).
// Acepta también el string crudo, para las pruebas del controlador que lo llaman sin el middleware.
const aLista = (v: unknown): string[] | undefined =>
  Array.isArray(v)
    ? (v as string[])
    : typeof v === 'string' && v
      ? v
          .split(',')
          .map(x => x.trim())
          .filter(Boolean)
      : undefined

const parsear = (query: unknown) => {
  const q = query as Q
  return {
    startDate: String(q.startDate),
    endDate: String(q.endDate),
    dateBasis: q.dateBasis as 'charge' | 'deposit',
    report: q.report as 'transactions' | 'deposits' | undefined,
    format: q.format as 'xlsx' | 'csv' | undefined,
    columns: aLista(q.columns),
    terminalIds: aLista(q.terminalIds),
    cardTypes: aLista(q.cardTypes),
    brands: aLista(q.brands),
    operations: aLista(q.operations),
  }
}
const filtrosDe = (q: ReturnType<typeof parsear>) => ({
  terminalIds: q.terminalIds,
  cardTypes: q.cardTypes as never,
  brands: q.brands,
  operations: q.operations as never,
})

export async function countSettlementReport(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = parsear(req.query)
    const c = await contarCandidatos({
      venueId: req.params.venueId,
      startDate: q.startDate,
      endDate: q.endDate,
      dateBasis: q.dateBasis,
      filtros: filtrosDe(q),
    })
    res.status(200).json({ success: true, data: { ...c, caps: { xlsx: TOPE_XLSX, csv: TOPE_CSV } } })
  } catch (e) {
    next(e)
  }
}

export async function exportSettlementReport(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = parsear(req.query)
    const format = q.format ?? 'xlsx'
    const archivo = await conTurnoDeReporte(async () => {
      const rep = await construirReporte({
        venueId: req.params.venueId,
        startDate: q.startDate,
        endDate: q.endDate,
        dateBasis: q.dateBasis,
        filtros: filtrosDe(q),
        tope: format === 'xlsx' ? TOPE_XLSX : TOPE_CSV,
      })
      return generarArchivo(rep, q.report ?? 'transactions', format, q.columns ?? [])
    })
    res.setHeader('Content-Type', archivo.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${archivo.nombre}"`)
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
    res.setHeader('Content-Length', archivo.buffer.length.toString())
    res.status(200).send(archivo.buffer)
  } catch (e) {
    next(e)
  }
}

export async function settlementReportTerminalOptions(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { search, cursor, limit } = req.query as { search?: string; cursor?: string; limit?: string | number }
    res.status(200).json({ success: true, data: await opcionesDeTerminal(req.params.venueId, search, cursor, Number(limit ?? 50)) })
  } catch (e) {
    next(e)
  }
}
