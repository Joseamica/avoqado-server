-- D4 (18-nov-2026): el renglón del vale congela el motivo, su comentario y quién aprobó el descuento. Aditiva: columnas opcionales,
-- sin valores por defecto ni índices (no reescribe la tabla); un vale viejo queda en NULL y sale «Sin motivo». El aprobador es una foto
-- del id de StaffVenue SIN llave foránea (Codex D4 r1-r4): al cobrar se usa sólo si esa membresía sigue existiendo, así no hay que
-- validar la tabla ni indexarla, y borrar una membresía no recorre los renglones de vales.
ALTER TABLE "AreaTicketLine" ADD COLUMN "discountReason" TEXT,
ADD COLUMN "discountReasonComment" TEXT,
ADD COLUMN "discountAuthorizedById" TEXT;
