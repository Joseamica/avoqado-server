import { NextFunction, Request, Response } from 'express'
import * as teamService from '../../services/dashboard/team.dashboard.service'
import { StaffRole } from '@prisma/client'

export async function getTeamMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const page = parseInt(req.query.page as string) || 1
    const pageSize = parseInt(req.query.pageSize as string) || 10
    const search = req.query.search as string

    const result = await teamService.getTeamMembers(venueId, page, pageSize, search)
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export async function getTeamMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const teamMemberId: string = req.params.teamMemberId

    const teamMember = await teamService.getTeamMember(venueId, teamMemberId)
    res.status(200).json(teamMember)
  } catch (error) {
    next(error)
  }
}

export async function inviteTeamMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const inviterStaffId = req.authContext?.userId

    if (!inviterStaffId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const { email, firstName, lastName, role, message } = req.body

    // Validate required fields
    if (!email || !firstName || !lastName || !role) {
      res.status(400).json({
        error: 'Missing required fields: email, firstName, lastName, role',
      })
      return
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      res.status(400).json({ error: 'Invalid email format' })
      return
    }

    // Validate role
    if (!Object.values(StaffRole).includes(role)) {
      res.status(400).json({ error: 'Invalid role' })
      return
    }

    const result = await teamService.inviteTeamMember(venueId, inviterStaffId, {
      email,
      firstName,
      lastName,
      role,
      message,
    })

    res.status(201).json({
      message: 'Team member invited successfully',
      invitation: result.invitation,
      emailSent: result.emailSent,
    })
  } catch (error) {
    next(error)
  }
}

export async function updateTeamMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const teamMemberId: string = req.params.teamMemberId

    const { role, active, pin } = req.body

    // Validate role if provided
    if (role && !Object.values(StaffRole).includes(role)) {
      res.status(400).json({ error: 'Invalid role' })
      return
    }

    const updatedTeamMember = await teamService.updateTeamMember(venueId, teamMemberId, {
      role,
      active,
      pin,
    })

    res.status(200).json({
      message: 'Team member updated successfully',
      data: updatedTeamMember,
    })
  } catch (error) {
    next(error)
  }
}

export async function removeTeamMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const teamMemberId: string = req.params.teamMemberId

    await teamService.removeTeamMember(venueId, teamMemberId)

    res.status(200).json({
      message: 'Team member removed successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function getPendingInvitations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId

    const invitations = await teamService.getPendingInvitations(venueId)

    res.status(200).json({
      data: invitations,
    })
  } catch (error) {
    next(error)
  }
}

export async function resendInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const invitationId: string = req.params.invitationId
    const invitedById = req.authContext?.userId

    if (!invitedById) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    await teamService.resendInvitation(venueId, invitationId, invitedById)

    res.status(200).json({
      message: 'Invitation resent successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function cancelInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const invitationId: string = req.params.invitationId

    await teamService.cancelInvitation(venueId, invitationId)

    res.status(200).json({
      message: 'Invitation cancelled successfully',
    })
  } catch (error) {
    next(error)
  }
}
