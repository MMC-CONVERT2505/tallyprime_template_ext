import { TallyLedgerEntry } from '../tally/interfaces/tally.interfaces';

/**
 * Shared ledger-entry tax classification for the voucher-derived mappers
 * (bill/invoice/credit-note). Built for bill.mapper.ts first — see its doc
 * comment for the live incident this fixes — then extracted here so
 * Invoice.xlsx/Credit Note.xlsx's identical TCS/TDS columns (and the same
 * "no item lines shouldn't mean no row" bug) can reuse it instead of
 * duplicating the pattern-matching logic.
 */
export interface LedgerTaxSummary {
  /** Sum of all GST-classified ledger entries, or null if none were found
   *  (distinct from 0 — "no GST posted" vs "no GST line exists at all"). */
  gstAmount: number | null;
  /** 'IGST' if any matched entry's name contains "IGST" (inter-state),
   *  else 'GST' if a CGST/SGST/UTGST entry matched (intra-state), else null. */
  gstKind: 'IGST' | 'GST' | null;
  tdsName: string;
  tdsAmount: number | '';
  tcsName: string;
  tcsAmount: number | '';
  /** Sum of debit-side ledger entries that aren't tax/TDS/TCS/round-off/the
   *  party's own ledger — i.e. the actual goods/expense value posted, used
   *  as the line-item base for a voucher with no inventory lines to sum
   *  instead. */
  nonTaxLedgerTotal: number;
  /**
   * The name of that same non-tax ledger — added 2026-09-05, powers
   * Invoice.xlsx/Bill.xlsx/Credit Note.xlsx's "Account" column for a
   * ledger-only (service) row, the same way `line.accountLedgerName` powers
   * it for an item-based line. Empty when more than one distinct non-tax
   * ledger is posted (no single "the" account to report — matches the
   * existing "amount" total's own single-base assumption for this same
   * case) or when none was found.
   */
  nonTaxLedgerName: string;
  /**
   * The party ledger entry's own BILLALLOCATIONS.LIST -> BILLCREDITPERIOD —
   * added 2026-09-05, powers Invoice.xlsx/Bill.xlsx's "Due Date" (voucher
   * date + this many days). Null when the party entry carries no bill-wise
   * credit period (this project's own test company never sets one — see
   * TallyLedgerEntry.billCreditPeriodDays's doc comment).
   */
  partyBillCreditPeriodDays: number | null;
}

/** Zoho's fixed enum for "how was this line's tax computed" — a percentage
 *  of the item/line amount, as opposed to e.g. a flat tax-group amount.
 *  Not reused from gst-rate.shared's DerivedGstTax.type ('Group'), which
 *  describes a different concept (whether the *rate itself* is a composite
 *  CGST+SGST group on the Item import) — confirmed against this project's
 *  own reference Bill.xlsx sample data, which uses "ItemAmount" here.
 *  Extrapolated to Invoice.xlsx/Credit Note.xlsx's equivalent column (same
 *  Zoho Books line-item-tax concept) — not independently reverified against
 *  a reference sample for those two templates specifically. */
export const TAX_TYPE_ITEM_AMOUNT = 'ItemAmount';

const GST_LEDGER_PATTERN = /\b(igst|cgst|sgst|utgst)\b/i;
const IGST_LEDGER_PATTERN = /\bigst\b/i;
const TDS_LEDGER_PATTERN = /\btds\b/i;
const TCS_LEDGER_PATTERN = /\btcs\b/i;
const ROUND_OFF_LEDGER_PATTERN = /round\s*off/i;

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function addAmount(current: number | '', delta: number): number {
  return (current === '' ? 0 : current) + delta;
}

export function summarizeLedgerEntries(
  entries: TallyLedgerEntry[],
  partyLedgerName: string | null,
): LedgerTaxSummary {
  let gstAmount = 0;
  let sawGst = false;
  let gstKind: 'IGST' | 'GST' | null = null;
  let tdsName = '';
  let tdsAmount: number | '' = '';
  let tcsName = '';
  let tcsAmount: number | '' = '';
  let nonTaxLedgerTotal = 0;
  const nonTaxLedgerNames = new Set<string>();
  let partyBillCreditPeriodDays: number | null = null;

  for (const entry of entries) {
    if (partyLedgerName && entry.ledgerName === partyLedgerName) {
      partyBillCreditPeriodDays = entry.billCreditPeriodDays;
    }
    if (entry.amount === null) continue;
    const abs = Math.abs(entry.amount);

    if (GST_LEDGER_PATTERN.test(entry.ledgerName)) {
      gstAmount += abs;
      sawGst = true;
      if (gstKind !== 'IGST') {
        gstKind = IGST_LEDGER_PATTERN.test(entry.ledgerName) ? 'IGST' : 'GST';
      }
      continue;
    }
    if (TDS_LEDGER_PATTERN.test(entry.ledgerName)) {
      tdsName = entry.ledgerName;
      tdsAmount = addAmount(tdsAmount, abs);
      continue;
    }
    if (TCS_LEDGER_PATTERN.test(entry.ledgerName)) {
      tcsName = entry.ledgerName;
      tcsAmount = addAmount(tcsAmount, abs);
      continue;
    }
    if (ROUND_OFF_LEDGER_PATTERN.test(entry.ledgerName)) continue;
    if (partyLedgerName && entry.ledgerName === partyLedgerName) continue;

    nonTaxLedgerTotal += abs;
    nonTaxLedgerNames.add(entry.ledgerName);
  }

  return {
    gstAmount: sawGst ? round2(gstAmount) : null,
    gstKind,
    tdsName,
    tdsAmount: tdsAmount === '' ? '' : round2(tdsAmount),
    tcsName,
    tcsAmount: tcsAmount === '' ? '' : round2(tcsAmount),
    nonTaxLedgerTotal: round2(nonTaxLedgerTotal),
    nonTaxLedgerName: nonTaxLedgerNames.size === 1 ? [...nonTaxLedgerNames][0] : '',
    partyBillCreditPeriodDays,
  };
}

/** A rate genuinely computed from two known currency amounts (not a guess)
 *  — e.g. TDS actually deducted, over the voucher's own base value. Blank
 *  when the base is unusable, rather than dividing by zero or by a
 *  negative. */
export function percentageOf(part: number | '', base: number): number | '' {
  if (part === '' || base <= 0) return '';
  return round2((part / base) * 100);
}
