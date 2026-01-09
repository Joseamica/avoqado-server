/**
 * @temporary
 * TEMPORARY: Dashboard routes for Serialized Inventory demo page.
 * TODO: Delete this file when the final implementation is complete.
 * Created for PlayTelecom demo visualization.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { serializedInventoryService } from '../../services/serialized-inventory/serializedInventory.service'
import { moduleService, MODULE_CODES } from '../../services/modules/module.service'
import prisma from '../../utils/prismaClient'

const router = Router()

/**
 * @temporary
 * GET /dashboard/serialized-inventory/summary
 * Get summary stats for serialized inventory (categories with counts)
 */
router.get(
  '/summary',
  authenticateTokenMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { venueId } = (req as any).authContext

      // Check if module is enabled
      const isEnabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
      if (!isEnabled) {
        return res.status(403).json({
          success: false,
          error: 'module_disabled',
          message: 'Serialized inventory module is not enabled for this venue',
        })
      }

      // Get categories with item counts
      const categories = await serializedInventoryService.getCategories(venueId)

      // Get counts per category and status
      const summary = await Promise.all(
        categories.map(async category => {
          const { total: available } = await serializedInventoryService.listItems({
            venueId,
            categoryId: category.id,
            status: 'AVAILABLE',
            take: 0,
          })
          const { total: sold } = await serializedInventoryService.listItems({
            venueId,
            categoryId: category.id,
            status: 'SOLD',
            take: 0,
          })
          const { total: returned } = await serializedInventoryService.listItems({
            venueId,
            categoryId: category.id,
            status: 'RETURNED',
            take: 0,
          })
          const { total: damaged } = await serializedInventoryService.listItems({
            venueId,
            categoryId: category.id,
            status: 'DAMAGED',
            take: 0,
          })

          return {
            id: category.id,
            name: category.name,
            description: category.description,
            suggestedPrice: category.suggestedPrice ? Number(category.suggestedPrice) : null,
            available,
            sold,
            returned,
            damaged,
            total: available + sold + returned + damaged,
          }
        }),
      )

      // Calculate totals
      const totals = summary.reduce(
        (acc, cat) => ({
          available: acc.available + cat.available,
          sold: acc.sold + cat.sold,
          returned: acc.returned + cat.returned,
          damaged: acc.damaged + cat.damaged,
          total: acc.total + cat.total,
        }),
        { available: 0, sold: 0, returned: 0, damaged: 0, total: 0 },
      )

      res.json({
        success: true,
        data: {
          categories: summary,
          totals,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * @temporary
 * GET /dashboard/serialized-inventory/items
 * Get serialized items with pagination and filtering
 */
router.get(
  '/items',
  authenticateTokenMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { venueId } = (req as any).authContext
      const { categoryId, status, limit = '50', offset = '0' } = req.query

      // Check if module is enabled
      const isEnabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
      if (!isEnabled) {
        return res.status(403).json({
          success: false,
          error: 'module_disabled',
          message: 'Serialized inventory module is not enabled for this venue',
        })
      }

      const { items, total } = await serializedInventoryService.listItems({
        venueId,
        categoryId: categoryId as string | undefined,
        status: status as any,
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      })

      res.json({
        success: true,
        data: {
          items: items.map(item => ({
            id: item.id,
            serialNumber: item.serialNumber,
            status: item.status,
            category: {
              id: item.category.id,
              name: item.category.name,
            },
            createdAt: item.createdAt,
            soldAt: item.soldAt,
            orderItemId: item.orderItemId,
          })),
          total,
          limit: parseInt(limit as string, 10),
          offset: parseInt(offset as string, 10),
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * @temporary
 * GET /dashboard/serialized-inventory/recent-sales
 * Get recent serialized item sales with seller info and sale price
 */
router.get(
  '/recent-sales',
  authenticateTokenMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { venueId } = (req as any).authContext
      const { limit = '10' } = req.query

      // Check if module is enabled
      const isEnabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
      if (!isEnabled) {
        return res.status(403).json({
          success: false,
          error: 'module_disabled',
          message: 'Serialized inventory module is not enabled for this venue',
        })
      }

      // Query with joins to get seller and price info
      const items = await prisma.serializedItem.findMany({
        where: {
          venueId,
          status: 'SOLD',
        },
        include: {
          category: true,
          orderItem: {
            include: {
              order: {
                include: {
                  createdBy: {
                    select: {
                      id: true,
                      firstName: true,
                      lastName: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: {
          soldAt: 'desc',
        },
        take: parseInt(limit as string, 10),
      })

      res.json({
        success: true,
        data: {
          sales: items.map(item => ({
            id: item.id,
            serialNumber: item.serialNumber,
            category: {
              id: item.category.id,
              name: item.category.name,
            },
            soldAt: item.soldAt,
            orderItemId: item.orderItemId,
            // Sale price from OrderItem
            salePrice: item.orderItem?.unitPrice ? Number(item.orderItem.unitPrice) : null,
            // Seller info from Order.createdBy
            seller: item.orderItem?.order?.createdBy
              ? {
                  id: item.orderItem.order.createdBy.id,
                  name: `${item.orderItem.order.createdBy.firstName} ${item.orderItem.order.createdBy.lastName}`.trim(),
                }
              : null,
          })),
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

export default router
