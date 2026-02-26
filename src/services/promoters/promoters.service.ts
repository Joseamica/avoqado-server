/**
 * Promoters Service
 * Provides promoter tracking, attendance, sales stats, and deposit management
 * for the PlayTelecom/White-Label dashboard.
 */
import prisma from '../../utils/prismaClient'
import { CashDepositStatus } from '@prisma/client'
import { logAction } from '../dashboard/activity-log.service'

// Types for the service responses
export interface PromoterSummary {
  id: string
  name: string
  photo: string | null
  status: 'ACTIVE' | 'INACTIVE' | 'ON_BREAK'
  store: { id: string; name: string }
  todaySales: number
  todayUnits: number
  commission: number
  lastActivity: Date | null
}

export interface PromotersListResponse {
  promoters: PromoterSummary[]
  summary: {
    total: number
    active: number
    onBreak: number
    todayTotalSales: number
    todayTotalCommissions: number
  }
}

export interface PromoterDetail {
  promoter: {
    id: string
    name: string
    email: string | null
    phone: string | null
    photo: string | null
    joinDate: Date
    role: string
  }
  todayMetrics: {
    sales: number
    units: number
    commission: number
    goalProgress: number
    dailyGoal: number
  }
  checkIn: {
    time: Date | null
    method: string | null
    photoUrl: string | null
    location: { lat: number; lng: number } | null
    verified: boolean
  } | null
  attendance: {
    days: Array<{
      date: string
      status: 'PRESENT' | 'ABSENT' | 'LATE' | 'HALF_DAY'
    }>
  }
}

export interface PromoterDeposit {
  id: string
  amount: number
  method: string
  timestamp: Date
  voucherImageUrl: string | null
  status: string
  rejectionReason: string | null
}

class PromotersService {
  /**
   * Get list of promoters with today's stats for a venue
   */
  async getPromotersList(venueId: string): Promise<PromotersListResponse> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // Get all promoters (staff with CASHIER/WAITER role) for this venue
    const staffVenues = await prisma.staffVenue.findMany({
      where: {
        venueId,
        active: true,
        role: { in: ['CASHIER', 'WAITER'] },
      },
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            photoUrl: true,
          },
        },
        venue: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    })

    // Get today's time entries for status determination (using TimeEntry, not AttendanceRecord)
    const todayTimeEntries = await prisma.timeEntry.findMany({
      where: {
        venueId,
        clockInTime: { gte: todayStart },
      },
      orderBy: { clockInTime: 'desc' },
      include: {
        breaks: {
          orderBy: { startTime: 'desc' },
          take: 1,
        },
      },
    })

    // Group time entries by staff - get latest entry per staff
    const staffAttendance = new Map<string, { status: string; lastTime: Date; photoUrl: string | null }>()
    for (const entry of todayTimeEntries) {
      if (!staffAttendance.has(entry.staffId)) {
        // Determine current status based on TimeEntry status and breaks
        const currentStatus = entry.status // CLOCKED_IN, CLOCKED_OUT, ON_BREAK
        const lastTime = entry.clockOutTime || entry.clockInTime

        staffAttendance.set(entry.staffId, {
          status: currentStatus,
          lastTime,
          photoUrl: entry.checkInPhotoUrl,
        })
      }
    }

    // Get today's sales by staff
    const todayOrders = await prisma.order.findMany({
      where: {
        venueId,
        status: 'COMPLETED',
        createdAt: { gte: todayStart },
        createdById: { not: null },
      },
      include: {
        items: true,
      },
    })

    // Aggregate sales by staff
    const staffSales = new Map<string, { sales: number; units: number }>()
    for (const order of todayOrders) {
      if (!order.createdById) continue
      const existing = staffSales.get(order.createdById) || { sales: 0, units: 0 }
      existing.sales += Number(order.total || 0)
      existing.units += order.items.length
      staffSales.set(order.createdById, existing)
    }

    // Build promoter list
    const promoters: PromoterSummary[] = staffVenues.map(sv => {
      const attendance = staffAttendance.get(sv.staffId)
      const sales = staffSales.get(sv.staffId) || { sales: 0, units: 0 }

      // Map TimeEntry status to PromoterSummary status
      let status: 'ACTIVE' | 'INACTIVE' | 'ON_BREAK' = 'INACTIVE'
      if (attendance) {
        switch (attendance.status) {
          case 'CLOCKED_IN':
            status = 'ACTIVE'
            break
          case 'ON_BREAK':
            status = 'ON_BREAK'
            break
          case 'CLOCKED_OUT':
          default:
            status = 'INACTIVE'
            break
        }
      }

      // Commission is typically a percentage of sales (e.g., 3%)
      const commissionRate = 0.03 // TODO: Make this configurable per venue/promoter
      const commission = sales.sales * commissionRate

      return {
        id: sv.staffId,
        name: `${sv.staff.firstName} ${sv.staff.lastName}`.trim(),
        photo: attendance?.photoUrl || sv.staff.photoUrl, // Prefer check-in photo if available
        status,
        store: { id: sv.venue.id, name: sv.venue.name },
        todaySales: Math.round(sales.sales * 100) / 100,
        todayUnits: sales.units,
        commission: Math.round(commission * 100) / 100,
        lastActivity: attendance?.lastTime || null,
      }
    })

    // Calculate summary
    const summary = {
      total: promoters.length,
      active: promoters.filter(p => p.status === 'ACTIVE').length,
      onBreak: promoters.filter(p => p.status === 'ON_BREAK').length,
      todayTotalSales: Math.round(promoters.reduce((sum, p) => sum + p.todaySales, 0) * 100) / 100,
      todayTotalCommissions: Math.round(promoters.reduce((sum, p) => sum + p.commission, 0) * 100) / 100,
    }

    return { promoters, summary }
  }

  /**
   * Get detailed info for a specific promoter
   */
  async getPromoterDetail(venueId: string, promoterId: string): Promise<PromoterDetail | null> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // Get promoter info
    const staffVenue = await prisma.staffVenue.findFirst({
      where: {
        venueId,
        staffId: promoterId,
        active: true,
      },
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            photoUrl: true,
            createdAt: true,
          },
        },
      },
    })

    if (!staffVenue) {
      return null
    }

    // Get today's orders for this promoter
    const todayOrders = await prisma.order.findMany({
      where: {
        venueId,
        status: 'COMPLETED',
        createdAt: { gte: todayStart },
        createdById: promoterId,
      },
      include: {
        items: true,
      },
    })

    const todaySales = todayOrders.reduce((sum, o) => sum + Number(o.total || 0), 0)
    const todayUnits = todayOrders.reduce((sum, o) => sum + o.items.length, 0)
    const commission = todaySales * 0.03 // TODO: Make configurable

    // Get performance goal for this month
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    const goal = await prisma.performanceGoal.findUnique({
      where: {
        staffId_venueId_month: {
          staffId: promoterId,
          venueId,
          month: monthStart,
        },
      },
    })

    const dailyGoal = goal ? Number(goal.salesGoal) / 30 : 1000 // Default daily goal
    const goalProgress = dailyGoal > 0 ? (todaySales / dailyGoal) * 100 : 0

    // Get today's time entry (check-in) using TimeEntry model
    const todayTimeEntry = await prisma.timeEntry.findFirst({
      where: {
        venueId,
        staffId: promoterId,
        clockInTime: { gte: todayStart },
      },
      orderBy: { clockInTime: 'asc' },
    })

    // Get last 30 days attendance from TimeEntry
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    thirtyDaysAgo.setHours(0, 0, 0, 0)

    const timeEntries = await prisma.timeEntry.findMany({
      where: {
        venueId,
        staffId: promoterId,
        clockInTime: { gte: thirtyDaysAgo },
      },
      orderBy: { clockInTime: 'asc' },
    })

    // Build attendance calendar
    const attendanceDays: Array<{ date: string; status: 'PRESENT' | 'ABSENT' | 'LATE' | 'HALF_DAY' }> = []
    for (let i = 29; i >= 0; i--) {
      const date = new Date()
      date.setDate(date.getDate() - i)
      date.setHours(0, 0, 0, 0)
      const dateStr = date.toISOString().split('T')[0]

      // Find time entry for this day
      const entry = timeEntries.find(r => {
        const recordDate = new Date(r.clockInTime)
        recordDate.setHours(0, 0, 0, 0)
        return recordDate.getTime() === date.getTime()
      })

      let status: 'PRESENT' | 'ABSENT' | 'LATE' | 'HALF_DAY' = 'ABSENT'
      if (entry) {
        const checkInHour = entry.clockInTime.getHours()
        if (checkInHour >= 10) {
          status = 'LATE'
        } else {
          status = 'PRESENT'
        }
      }

      attendanceDays.push({ date: dateStr, status })
    }

    return {
      promoter: {
        id: staffVenue.staff.id,
        name: `${staffVenue.staff.firstName} ${staffVenue.staff.lastName}`.trim(),
        email: staffVenue.staff.email,
        phone: staffVenue.staff.phone,
        photo: todayTimeEntry?.checkInPhotoUrl || staffVenue.staff.photoUrl,
        joinDate: staffVenue.staff.createdAt,
        role: staffVenue.role,
      },
      todayMetrics: {
        sales: Math.round(todaySales * 100) / 100,
        units: todayUnits,
        commission: Math.round(commission * 100) / 100,
        goalProgress: Math.round(goalProgress),
        dailyGoal: Math.round(dailyGoal * 100) / 100,
      },
      checkIn: todayTimeEntry
        ? {
            time: todayTimeEntry.clockInTime,
            method: 'GPS_PHOTO', // TimeEntry always uses GPS + Photo
            photoUrl: todayTimeEntry.checkInPhotoUrl,
            location:
              todayTimeEntry.clockInLatitude && todayTimeEntry.clockInLongitude
                ? { lat: todayTimeEntry.clockInLatitude, lng: todayTimeEntry.clockInLongitude }
                : null,
            verified: true, // TimeEntry check-ins are verified by GPS + Photo
          }
        : null,
      attendance: {
        days: attendanceDays,
      },
    }
  }

  /**
   * Get deposits for a specific promoter
   */
  async getPromoterDeposits(venueId: string, promoterId: string, status?: CashDepositStatus): Promise<PromoterDeposit[]> {
    const deposits = await prisma.cashDeposit.findMany({
      where: {
        venueId,
        staffId: promoterId,
        ...(status && { status }),
      },
      orderBy: { timestamp: 'desc' },
    })

    return deposits.map(d => ({
      id: d.id,
      amount: Number(d.amount),
      method: d.method,
      timestamp: d.timestamp,
      voucherImageUrl: d.voucherImageUrl,
      status: d.status,
      rejectionReason: d.rejectionReason,
    }))
  }

  /**
   * Approve a deposit
   */
  async approveDeposit(venueId: string, depositId: string, approvedById: string): Promise<{ success: boolean; error?: string }> {
    const deposit = await prisma.cashDeposit.findFirst({
      where: {
        id: depositId,
        venueId,
        status: 'PENDING',
      },
    })

    if (!deposit) {
      return { success: false, error: 'Deposit not found or already processed' }
    }

    await prisma.cashDeposit.update({
      where: { id: depositId },
      data: {
        status: 'APPROVED',
        approvedById,
        approvedAt: new Date(),
      },
    })

    logAction({
      staffId: approvedById,
      venueId,
      action: 'CASH_DEPOSIT_APPROVED',
      entity: 'CashDeposit',
      entityId: depositId,
    })

    return { success: true }
  }

  /**
   * Reject a deposit
   */
  async rejectDeposit(venueId: string, depositId: string, reason: string): Promise<{ success: boolean; error?: string }> {
    const deposit = await prisma.cashDeposit.findFirst({
      where: {
        id: depositId,
        venueId,
        status: 'PENDING',
      },
    })

    if (!deposit) {
      return { success: false, error: 'Deposit not found or already processed' }
    }

    await prisma.cashDeposit.update({
      where: { id: depositId },
      data: {
        status: 'REJECTED',
        rejectionReason: reason,
      },
    })

    logAction({
      venueId,
      action: 'CASH_DEPOSIT_REJECTED',
      entity: 'CashDeposit',
      entityId: depositId,
      data: { reason },
    })

    return { success: true }
  }
}

export const promotersService = new PromotersService()
