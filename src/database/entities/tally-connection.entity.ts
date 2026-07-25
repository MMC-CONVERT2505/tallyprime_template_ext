import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A registered TallyPrime endpoint. In Phase 1 the active endpoint comes from
 * env (TALLY_HOST/PORT), but modelling it now means multi-company / multi-client
 * support later is a data change, not a schema migration. Mirrors the
 * `connections` table in the architecture doc.
 */
@Entity({ name: 'tally_connections' })
export class TallyConnection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Human label, e.g. "ABC Traders — reception PC". */
  @Column({ type: 'varchar', length: 200 })
  label!: string;

  @Column({ type: 'varchar', length: 255, default: '127.0.0.1' })
  host!: string;

  @Column({ type: 'int', default: 9000 })
  port!: number;

  /** Exact company name as it appears in Tally, when the endpoint is scoped. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  defaultCompany!: string | null;

  @Index()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /** Last successful reachability check. */
  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
