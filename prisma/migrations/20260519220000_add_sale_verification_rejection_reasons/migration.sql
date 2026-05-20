-- AlterEnum: add new rejection reasons for back-office (PlayTelecom / Walmart) documentation review
-- "Imágenes ilegibles" and "Falta imagen de vinculación" added so back-office can flag these specific issues
-- instead of falling back to OTHER + free-text notes.

ALTER TYPE "SaleVerificationRejectionReason" ADD VALUE IF NOT EXISTS 'REVIEW_ILLEGIBLE_IMAGES';
ALTER TYPE "SaleVerificationRejectionReason" ADD VALUE IF NOT EXISTS 'REVIEW_MISSING_LINKING_IMAGE';
