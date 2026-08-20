import { ExtractionType } from '@prisma/client';
import { TunnelAction } from '../tunnel/tunnel-protocol';

/** Which ExtractionType values are queueable as an async job — every value
 *  ExtractionType has, since this project is extraction-only (no writes). */
export const EXTRACTABLE_TYPES = [
  ExtractionType.COMPANIES,
  ExtractionType.LEDGERS,
  ExtractionType.STOCK_ITEMS,
  ExtractionType.GROUPS,
  ExtractionType.COST_CENTRES,
  ExtractionType.VOUCHERS,
  ExtractionType.RAW,
] as const;

export type ExtractableType = (typeof EXTRACTABLE_TYPES)[number];

/** The subset of EXTRACTABLE_TYPES that are Tally masters (not transactional
 *  vouchers, not the RAW escape hatch) — what POST /extractions/fetch-master
 *  accepts as `masterType`. */
export const MASTER_EXTRACTABLE_TYPES = [
  ExtractionType.COMPANIES,
  ExtractionType.LEDGERS,
  ExtractionType.STOCK_ITEMS,
  ExtractionType.GROUPS,
  ExtractionType.COST_CENTRES,
] as const;

export type MasterExtractableType = (typeof MASTER_EXTRACTABLE_TYPES)[number];

const TYPE_TO_ACTION: Record<ExtractableType, TunnelAction> = {
  [ExtractionType.COMPANIES]: 'companies',
  [ExtractionType.LEDGERS]: 'ledgers',
  [ExtractionType.STOCK_ITEMS]: 'stockItems',
  [ExtractionType.GROUPS]: 'groups',
  [ExtractionType.COST_CENTRES]: 'costCentres',
  [ExtractionType.VOUCHERS]: 'vouchers',
  [ExtractionType.RAW]: 'raw',
};

export function toTunnelAction(type: ExtractableType): TunnelAction {
  return TYPE_TO_ACTION[type];
}
