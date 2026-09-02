import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class ResourcesService {
  constructor(private readonly prisma: PrismaService) {}
}
