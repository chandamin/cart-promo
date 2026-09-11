-- CreateTable
CREATE TABLE "PromotionRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "discountMethod" TEXT NOT NULL,
    "code" TEXT,
    "combinesWith" JSONB NOT NULL,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "shopifyDiscountId" TEXT,
    "triggers" JSONB NOT NULL,
    "triggerMatch" TEXT NOT NULL DEFAULT 'ANY',
    "config" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "PromotionRule_shop_type_idx" ON "PromotionRule"("shop", "type");
