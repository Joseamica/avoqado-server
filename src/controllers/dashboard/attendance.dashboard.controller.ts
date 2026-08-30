import * as workShiftService from '../../services/dashboard/workShift.service'
import { NextFunction, Request, Response } from 'express'
import * as attendanceService from '../../services/dashboard/attendance.dashboard.service'
import * as attendancePayrollService from '../../services/dashboard/attendancePayroll.service'
import * as overtimeApprovalService from '../../services/dashboard/overtimeApproval.service'
import * as workScheduleService from '../../services/dashboard/workSchedule.service'
import type { TimeEntryStatus } from '@prisma/client'

export async function getTimeEntries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const result = await attendanceService.getVenueTimeEntries(venueId, {
      staffId: req.query.staffId as string | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      status: req.query.status as TimeEntryStatus | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    })
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export async function getActiveStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await attendanceService.getVenueActiveStaff(req.params.venueId)
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export async function getStaffTimeSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, staffId } = req.params
    const result = await attendanceService.getVenueStaffTimeSummary(
      venueId,
      staffId,
      req.query.startDate as string,
      req.query.endDate as string,
    )
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

/** GET /venues/:venueId/attendance/report — puntualidad: retardos, faltas y salidas tempranas. */
export async function getReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await attendanceService.getAttendanceReport(
      req.params.venueId,
      req.query.startDate as string,
      req.query.endDate as string,
    )
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

/** GET /venues/:venueId/attendance/payroll-summary — fase 3: los números del periodo para la nómina. */
export async function getPayrollSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await attendancePayrollService.getPayrollSummary(
      req.params.venueId,
      req.query.startDate as string,
      req.query.endDate as string,
    )
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /venues/:venueId/team/:staffVenueId/overtime-approval — autorizar horas extra de un día.
 *
 * Quién autoriza sale de `authContext`, NUNCA del cuerpo: si viniera del cuerpo, cualquiera
 * podría firmar la autorización con el nombre de otro.
 */
export async function approveOvertime(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, userId } = (req as any).authContext
    const result = await overtimeApprovalService.approveOvertime({
      venueId: req.params.venueId,
      staffVenueId: req.params.staffVenueId,
      date: req.body.date,
      minutesApproved: req.body.minutesApproved,
      approvedById: userId,
      note: req.body.note,
    })
    // `venueId` del token y de la ruta deben ser el mismo negocio; el middleware de permiso ya
    // lo resolvió, y el servicio vuelve a acotar la membresía por venue.
    void venueId
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

/** GET /venues/:venueId/team/:staffVenueId/work-schedule — el cuadrante de una persona. */
export async function getWorkSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await workScheduleService.getWorkSchedule(req.params.venueId, req.params.staffVenueId)
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

/** PUT /venues/:venueId/team/:staffVenueId/work-schedule — reemplaza el cuadrante completo. */
export async function replaceWorkSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = (req as any).authContext?.userId
    if (!actorId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    const result = await workScheduleService.replaceWorkSchedule(req.params.venueId, req.params.staffVenueId, req.body, actorId)
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

// ─── Turnos rotativos (fase 1 "como Sesame") ────────────────────────────────────────────
export const listWorkShiftTemplates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const includeInactive = String((req.query as any)?.includeInactive) === 'true'
    res.json({ success: true, data: await workShiftService.listTemplates(req.params.venueId, includeInactive) })
  } catch (e) {
    next(e)
  }
}
export const createWorkShiftTemplate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const t = await workShiftService.createTemplate(req.params.venueId, req.body, req.authContext?.userId || '')
    res.status(201).json({ success: true, data: t })
  } catch (e) {
    next(e)
  }
}
export const updateWorkShiftTemplate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const t = await workShiftService.updateTemplate(req.params.venueId, req.params.templateId, req.body, req.authContext?.userId || '')
    res.json({ success: true, data: t })
  } catch (e) {
    next(e)
  }
}
export const getWorkShiftAssignments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = req.query as { from: string; to: string }
    res.json({ success: true, data: await workShiftService.getAssignments(req.params.venueId, from, to) })
  } catch (e) {
    next(e)
  }
}
export const replaceWorkShiftAssignments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: await workShiftService.replaceAssignments(req.params.venueId, req.body, req.authContext?.userId || ''),
    })
  } catch (e) {
    next(e)
  }
}
export const publishWorkShiftAssignments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: await workShiftService.publishAssignments(req.params.venueId, req.body, req.authContext?.userId || ''),
    })
  } catch (e) {
    next(e)
  }
}
