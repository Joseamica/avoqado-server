import { z } from 'zod'
import { StaffDocumentType } from '@prisma/client'

export const StaffDocumentsParamsSchema = z.object({
  params: z.object({ venueId: z.string().cuid(), staffId: z.string().cuid() }),
})

export const StaffDocumentIdParamsSchema = z.object({
  params: z.object({ venueId: z.string().cuid(), documentId: z.string().cuid() }),
})

// multipart/form-data: el ARCHIVO lo valida multer (tipo y tamaño); aquí sólo los campos.
export const AddStaffDocumentSchema = z.object({
  params: z.object({ venueId: z.string().cuid(), staffId: z.string().cuid() }),
  body: z.object({
    type: z.nativeEnum(StaffDocumentType),
    label: z.string().trim().max(120).optional().nullable(),
    expiresAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
    notes: z.string().trim().max(500).optional().nullable(),
  }),
})
