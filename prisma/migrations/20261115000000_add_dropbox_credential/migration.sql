CREATE TABLE `DropboxCredential` (
  `id` INTEGER NOT NULL DEFAULT 1,
  `encryptedRefreshToken` TEXT NOT NULL,
  `iv` VARCHAR(32) NOT NULL,
  `authTag` VARCHAR(32) NOT NULL,
  `accountId` VARCHAR(64) NULL,
  `connectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
