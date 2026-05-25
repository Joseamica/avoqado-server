import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'

interface NagerHoliday {
  date: string
  localName: string
  name: string
}

/**
 * GET /api/v1/superadmin/holidays?year=2026&country=MX
 * Feriados del año para el estimado de fecha de depósito. Cachea en
 * HolidayCalendar: si ya hay filas del año las devuelve; si no, las trae de
 * date.nager.at (feriados civiles ≈ inhábiles bancarios — estimado) y upserta.
 */
export async function getHolidays(req: Request, res: Response, next: NextFunction) {
  try {
    const year = Number(req.query.year)
    const country = (req.query.country as string) || 'MX'
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestError('year inválido')
    }

    const existing = await prisma.holidayCalendar.findMany({
      where: { year },
      select: { date: true, name: true },
      orderBy: { date: 'asc' },
    })
    if (existing.length > 0) {
      res.json({
        success: true,
        data: existing.map(h => ({ date: h.date.toISOString().slice(0, 10), name: h.name })),
      })
      return
    }

    const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(country)}`)
    if (!resp.ok) {
      res.status(502).json({ success: false, error: 'No se pudieron obtener los feriados' })
      return
    }
    const holidays = (await resp.json()) as NagerHoliday[]

    for (const h of holidays) {
      await prisma.holidayCalendar.upsert({
        where: { date_holidayType: { date: new Date(h.date), holidayType: 'BANKING' } },
        create: {
          name: h.localName || h.name,
          date: new Date(h.date),
          year,
          holidayType: 'BANKING',
          isBanking: true,
        },
        update: { name: h.localName || h.name },
      })
    }

    res.json({
      success: true,
      data: holidays.map(h => ({ date: h.date, name: h.localName || h.name })),
    })
  } catch (error) {
    next(error)
  }
}
