import { Module } from '@nestjs/common';
import { UserManagementController } from './users.controller.js';
import { UserManagementService } from './users.service.js';

@Module({
  controllers: [UserManagementController],
  providers: [UserManagementService],
  exports: [UserManagementService],
})
export class UserManagementModule {}
