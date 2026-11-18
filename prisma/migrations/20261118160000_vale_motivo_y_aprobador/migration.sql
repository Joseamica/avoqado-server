-- D4 (18-nov-2026): el renglón del vale congela el motivo, su comentario y quién aprobó el descuento. Aditiva: columnas opcionales,
-- sin valores por defecto (no reescribe la tabla); un vale viejo queda en NULL y sale «Sin motivo».
ALTER TABLE "AreaTicketLine" ADD COLUMN "discountReason" TEXT,
ADD COLUMN "discountReasonComment" TEXT,
ADD COLUMN "discountAuthorizedById" TEXT;

-- NOT VALID (Codex D4 r1 #5): sin leer las filas que ya existen, el candado del ADD CONSTRAINT dura un instante. La validación va en
-- 20261118160010, en su propio archivo (como 20261028100010), para que no frene las escrituras de los vales ni de StaffVenue.
ALTER TABLE "AreaTicketLine" ADD CONSTRAINT "AreaTicketLine_discountAuthorizedById_fkey" FOREIGN KEY ("discountAuthorizedById") REFERENCES "StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
