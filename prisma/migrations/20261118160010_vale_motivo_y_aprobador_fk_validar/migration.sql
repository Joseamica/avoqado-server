-- Valida la FK que 20261118160000 creó NOT VALID. VALIDATE toma SHARE UPDATE EXCLUSIVE: lee AreaTicketLine sin frenar las
-- escrituras (todas las filas existentes tienen "discountAuthorizedById" NULL). Archivo propio: en el mismo archivo el candado del
-- ADD CONSTRAINT seguiría tomado durante la lectura.
ALTER TABLE "AreaTicketLine" VALIDATE CONSTRAINT "AreaTicketLine_discountAuthorizedById_fkey";
