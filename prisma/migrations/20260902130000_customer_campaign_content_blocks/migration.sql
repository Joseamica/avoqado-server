-- Fase 1C, Task 3: guardar el borrador de una campaña necesita reabrirlo después (editor) y
-- re-derivar su huella al publicar (T4 huellaDeCampana). htmlBody/textBody son RENDERS del
-- servidor; sin guardar los bloques de origen no hay forma honesta de reconstruirlos.
ALTER TABLE "CustomerCampaign" ADD COLUMN "contentBlocks" JSONB;
