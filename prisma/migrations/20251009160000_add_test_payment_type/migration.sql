-- Add TEST value to PaymentType enum
ALTER TYPE "public"."PaymentType" ADD VALUE IF NOT EXISTS 'TEST';
