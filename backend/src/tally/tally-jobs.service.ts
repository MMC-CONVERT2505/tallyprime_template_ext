import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ExtractionJob, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../database/prisma.service';
import { ExtractionJobData } from '../extractions/extraction-job-data.interface';
import { EXTRACTION_QUEUE, extractionResultKey } from '../extractions/extractions.constants';
import { REDIS_CLIENT } from '../redis/redis.module';
import { CreateTallyJobDto } from './dto/create-tally-job.dto';

/**
 * The async counterpart of TallyController's direct GET /tally/* routes:
 * queue → poll → fetch, same shape as ExtractionsService but deliberately
 * NOT org-scoped — these jobs dispatch straight to the backend's own
 * configured Tally (mode: 'local' in ExtractionJobData), matching the
 * existing unauthenticated, connector-free posture of /tally/* itself.
 * Shares the same EXTRACTION_QUEUE/ExtractionsProcessor/Redis result-caching
 * machinery as the agent-mediated path rather than a second parallel one —
 * see ExtractionJobData's doc comment for the two dispatch modes.
 */
@Injectable()
export class TallyJobsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EXTRACTION_QUEUE) private readonly queue: Queue<ExtractionJobData>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async create(dto: CreateTallyJobDto): Promise<{ id: string; status: string }> {
    const payload = dto.payload ?? {};

    const job = await this.prisma.extractionJob.create({
      data: {
        type: dto.type,
        status: 'PENDING',
        company: (payload.company as string | undefined) ?? null,
        params: payload as Prisma.InputJsonValue,
      },
    });

    await this.queue.add('extract', {
      mode: 'local',
      extractionJobId: job.id,
      type: dto.type,
      payload,
    });

    return { id: job.id, status: job.status };
  }

  async getStatus(id: string): Promise<ExtractionJob> {
    const job = await this.prisma.extractionJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException('Job not found.');
    }
    return job;
  }

  async getResult(id: string): Promise<unknown> {
    const job = await this.getStatus(id);
    if (job.status === 'PENDING') {
      throw new BadRequestException('Job has not finished yet.');
    }
    if (job.status === 'FAILED') {
      throw new BadRequestException(job.error ?? 'Extraction failed.');
    }

    const raw = await this.redis.get(extractionResultKey(id));
    if (!raw) {
      throw new NotFoundException('Result has expired or is no longer available.');
    }
    return JSON.parse(raw);
  }
}
