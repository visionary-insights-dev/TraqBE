import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UserManagementService } from './users.service.js';

@Controller('api/v1/users')
@ApiTags('User Management')
export class UserManagementController {
  constructor(
    private readonly userManagementService: UserManagementService,
  ) {}
}
