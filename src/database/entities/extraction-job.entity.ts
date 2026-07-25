import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum ExtractionType {
  COMPANIES = 'companies',
  LEDGERS = 'ledgers',
  VOUCHERS = 'vouchers',
  RAW = 'raw',
}

export enum ExtractionStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
}

/**
 * Audit row for every extraction attempt against Tally. Structured job state
 * lives in Postgres (who/what/when/status/counts); the actual bulky payload
 * belongs in an object/document store later. Mirrors `extraction_jobs`.
 */
@Entity({ name: 'extraction_jobs' })
export class ExtractionJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'enum', enum: ExtractionType })
  type!: ExtractionType;

  @Index()
  @Column({ type: 'enum', enum: ExtractionStatus, default: ExtractionStatus.PENDING })
  status!: ExtractionStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  company!: string | null;

  /** Free-form request params (date range, voucher type, report name…). */
  @Column({ type: 'jsonb', default: {} })
  params!: Record<string, unknown>;

  /** Number of top-level records parsed out of the response. */
  @Column({ type: 'int', nullable: true })
  recordCount!: number | null;

  @Column({ type: 'int', nullable: true })
  durationMs!: number | null;

  /** Populated only on failure. Short, human-readable reason. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
