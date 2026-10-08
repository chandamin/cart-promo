-- AlterTable
ALTER TABLE "PromotionRule" ADD COLUMN "minRequirement" JSONB;
ALTER TABLE "PromotionRule" ADD COLUMN "eligibility" JSONB;
ALTER TABLE "PromotionRule" ADD COLUMN "usageLimit" INTEGER;
ALTER TABLE "PromotionRule" ADD COLUMN "oncePerCustomer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PromotionRule" ADD COLUMN "tags" JSONB;
ALTER TABLE "PromotionRule" ADD COLUMN "cartLabel" TEXT;
