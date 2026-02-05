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

    const { email, firstName, lastName, role, message, type, pin, inviteToAllVenues } = req.body

    const isTPVOnly = type === 'tpv-only'

    // Validate required fields
    if (!firstName || !lastName || !role) {
      res.status(400).json({
        error: 'Missing required fields: firstName, lastName, role',
      })
      return
    }

    // For standard invitations, email is required
    if (!isTPVOnly && !email) {
      res.status(400).json({
        error: 'Email is required for standard invitations',
      })
      return
    }

    // For TPV-only, PIN is required
    if (isTPVOnly && !pin) {
      res.status(400).json({
        error: 'PIN is required for TPV-only staff members',
      })
      return
    }

    // Validate email format (only if provided)
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(email)) {
        res.status(400).json({ error: 'Invalid email format' })
        return
      }
    }

    // Validate PIN format (only if provided)
    if (pin && !/^\d{4,10}$/.test(pin)) {
      res.status(400).json({ error: 'PIN must be between 4 and 10 digits' })
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
      type,
      pin,
      inviteToAllVenues,
    })

    res.status(201).json({
      message: isTPVOnly ? 'TPV-only team member created successfully' : 'Team member invited successfully',
      invitation: result.invitation,
      emailSent: result.emailSent,
      isTPVOnly: result.isTPVOnly,
      inviteLink: result.inviteLink,
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

/**
 * Hard delete team member - SUPERADMIN ONLY
 * Permanently deletes all data associated with a team member from the venue.
 */
export async function hardDeleteTeamMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const teamMemberId: string = req.params.teamMemberId
    const { confirmDeletion } = req.body

    if (confirmDeletion !== true) {
      res.status(400).json({
        error: 'Must explicitly confirm deletion by setting confirmDeletion: true',
      })
      return
    }

    const result = await teamService.hardDeleteTeamMember(venueId, teamMemberId, confirmDeletion)

    res.status(200).json({
      message: 'Team member permanently deleted',
      deletedRecords: result.deletedRecords,
    })
  } catch (error) {
    next(error)
  }
}
