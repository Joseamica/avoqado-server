-- AlterEnum: add terminal "REJECTED" sale-verification status (PlayTelecom).
-- "Rechazada" = a sale that was started but the line could not be linked/ported
-- and the customer was lost. Distinct from FAILED ("Revisar", which the promoter
-- can still correct on the TPV): REJECTED is terminal in the normal flow; only an
-- admin can reopen it via the edit dialog. Only add the value here (do not use it
-- in the same transaction).
ALTER TYPE "SaleVerificationStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
