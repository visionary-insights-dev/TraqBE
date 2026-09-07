import { Module } from '@nestjs/common';
import { ProgramsController } from './programs.controller.js';
import { ProgramsService } from './programs.service.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [AuditModule],
  controllers: [ProgramsController],
  providers: [ProgramsService],
  exports: [ProgramsService],
})
export class ProgramsModule {}