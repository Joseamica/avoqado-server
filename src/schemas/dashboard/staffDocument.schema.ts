import { z } from 'zod'
import { StaffDocumentType } from '@prisma/client'

export const StaffDocumentsParamsSchema = z.object({
  params: z.object({ venueId: z.string().cuid(), staffId: z.string().cuid() }),
})

export const StaffDocumentIdParamsSchema = z.object({
  params: z.object({ venueId: z.string().cuid(), documentId: z.string().cuid() }),
})

export const AddStaffDocumentSchema = z.object({
  params: z.object({ venueId: z.string().cuid(), staffId: z.string().cuid() }),
  body: z.object({
    type: z.nativeEnum(StaffDocumentType),
    label: z.string().trim().max(120).optional().nullable(),
    fileName: z.string().trim().min(1).max(255),
    fileUrl: z.string().url().max(2048),
    mimeType: z.string().trim().min(1).max(120),
    // 20 MB. Un expediente son fotos y PDFs, no video.
    sizeBytes: z.coerce
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
    expiresAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
    notes: z.string().trim().max(500).optional().nullable(),
  }),
})
