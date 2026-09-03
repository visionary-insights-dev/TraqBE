import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class AssignmentSubmissionsService {
  constructor(private readonly prisma: PrismaService) {}
}
