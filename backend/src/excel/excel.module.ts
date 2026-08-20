import { Module } from '@nestjs/common';
import { ExcelGeneratorService } from './excel-generator.service';
import { ZipService } from './zip.service';

@Module({
  providers: [ExcelGeneratorService, ZipService],
  exports: [ExcelGeneratorService, ZipService],
})
export class ExcelModule {}
