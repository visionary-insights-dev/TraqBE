import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service.js';

@Controller('api/v1/audit-logs')
@ApiTags('Audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}
}
