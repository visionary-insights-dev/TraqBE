import { Module } from '@nestjs/common';
import { MentorPairingController } from './mentor-pairing.controller.js';
import { MentorPairingService } from './mentor-pairing.service.js';

@Module({
  controllers: [MentorPairingController],
  providers: [MentorPairingService],
  exports: [MentorPairingService],
})
export class MentorPairingModule {}
