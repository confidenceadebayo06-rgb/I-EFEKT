CREATE TABLE `UserNotification` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `type` VARCHAR(40) NOT NULL,
  `title` VARCHAR(120) NOT NULL,
  `body` VARCHAR(500) NOT NULL,
  `link` VARCHAR(255) NULL,
  `readAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `UserNotification_userId_readAt_createdAt_idx`(`userId`, `readAt`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `UserNotification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;