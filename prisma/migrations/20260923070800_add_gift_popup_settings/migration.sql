-- CreateTable
CREATE TABLE "GiftPopupSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "position" TEXT NOT NULL DEFAULT 'bottom-right',
    "width" INTEGER NOT NULL DEFAULT 280,
    "backgroundColor" TEXT NOT NULL DEFAULT '#ffffff',
    "textColor" TEXT NOT NULL DEFAULT '#1a1a1a',
    "fontSize" INTEGER NOT NULL DEFAULT 14,
    "borderRadius" INTEGER NOT NULL DEFAULT 8,
    "borderColor" TEXT NOT NULL DEFAULT '#dddddd',
    "buttonBackgroundColor" TEXT NOT NULL DEFAULT '#fafafa',
    "buttonTextColor" TEXT NOT NULL DEFAULT '#1a1a1a',
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftPopupSettings_shop_key" ON "GiftPopupSettings"("shop");
