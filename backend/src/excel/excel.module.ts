import { Module } from '@nestjs/common';
import { ExcelGeneratorService } from './excel-generator.service';

@Module({
  providers: [ExcelGeneratorService],
  exports: [ExcelGeneratorService],
})
export class ExcelModule {}
