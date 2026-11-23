-- D677 (22-nov-2026): el correo de contacto del canal de pago en línea ya no es único en toda la plataforma.
-- Una dueña con varias sucursales usa el mismo correo en el canal de cada una. Se conserva el índice normal
-- "EcommerceMerchant_contactEmail_idx" para las búsquedas.

-- DropIndex
DROP INDEX "EcommerceMerchant_contactEmail_key";
