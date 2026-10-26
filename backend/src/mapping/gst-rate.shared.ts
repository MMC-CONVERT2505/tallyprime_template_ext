import { round2 } from './voucher-tax.shared';

/**
 * Shared GST-rate-to-Zoho-tax-column derivation — used by StockItemMapper's
 * Intra/Inter State columns and by the voucher-line mappers' single Item Tax
 * column. Naming/Type convention ("GST{rate}"/"IGST{rate}", "Group") is
 * taken directly from Item.xlsx's own real sample rows, not guessed — see
 * TallyStockItem.gstRate's doc comment for the full reasoning (one Tally
 * field covers both intra and inter-state since GST law keeps the combined
 * rate equal either way).
 */
export interface DerivedGstTax {
  name: string;
  rate: number | '';
  type: string;
}

const BLANK_TAX: DerivedGstTax = { name: '', rate: '', type: '' };

export function deriveIntraStateTax(gstRate: number | null): DerivedGstTax {
  return gstRate !== null ? { name: `GST${gstRate}`, rate: gstRate, type: 'Group' } : BLANK_TAX;
}

export function deriveInterStateTax(gstRate: number | null): DerivedGstTax {
  return gstRate !== null ? { name: `IGST${gstRate}`, rate: gstRate, type: 'Group' } : BLANK_TAX;
}

/** Case/whitespace-insensitive state-name comparison — Tally's free-text
 *  PLACEOFSUPPLY/GSTREGISTRATION fields have shown no real casing variance
 *  in this project's own data, but this is cheap insurance against it. */
function sameState(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface GstSplit {
  isInterState: boolean;
  cgstRate: number | '';
  sgstRate: number | '';
  igstRate: number | '';
  cgstAmount: number | '';
  sgstAmount: number | '';
  igstAmount: number | '';
}

const BLANK_SPLIT: GstSplit = {
  isInterState: false,
  cgstRate: '',
  sgstRate: '',
  igstRate: '',
  cgstAmount: '',
  sgstAmount: '',
  igstAmount: '',
};

/**
 * Splits a single combined GST rate (Tally's own representation — see
 * deriveIntraStateTax's doc comment, the law keeps CGST+SGST equal to IGST
 * for the same supply) into Invoice.xlsx's separate CGST/SGST/IGST Rate %/
 * amount columns — added 2026-10-20 when the new Invoice.xlsx template
 * replaced the old single "Item Tax" column with this breakdown.
 *
 * Correctly distinguishing an intra-state (CGST+SGST) sale from an
 * inter-state (IGST) one needs the seller's own home state, which nothing
 * in this project extracts from Tally directly (TallyCompany carries no
 * address/GSTIN today). `homeState` is therefore a best-effort heuristic
 * computed by the caller from the voucher batch itself (see
 * InvoiceMapper.resolveHomeState) — NOT independently verified live the way
 * most of this project's field mappings are. When `homeState` can't be
 * determined at all, this defaults to intra-state (the same assumption the
 * single-column "Item Tax" predecessor made for every row, unconditionally,
 * before this split existed) rather than guessing IGST.
 */
/**
 * Best-effort guess at the seller's own home state, from a voucher batch —
 * promoted out of invoice.mapper.ts 2026-10-21 so credit-note.mapper.ts (the
 * same SALES direction — a return against a Sales invoice, same
 * placeOfSupply-vs-home-state meaning) can reuse it. NOT reused by
 * bill.mapper.ts/vendor-credit.mapper.ts (the PURCHASE direction) — see
 * bill.mapper.ts's class doc comment for why that heuristic has only ever
 * been reasoned about/verified for the sales side. Prefers the most common
 * GST Registration's state name (e.g. "Uttar Pradesh Registration" ->
 * "Uttar Pradesh" — VERIFIED live, see deriveGstSplit's doc comment),
 * falling back to the most common Place of Supply when no GST Registration
 * was found on any voucher. Null (never guessed) when neither signal exists.
 */
export function resolveHomeState(
  vouchers: { gstRegistration: string | null; placeOfSupply: string | null }[],
): string | null {
  const fromRegistration = mostCommon(
    vouchers.map((v) => v.gstRegistration).filter((v): v is string => !!v),
  );
  if (fromRegistration) {
    const state = fromRegistration.replace(/\s*Registration\s*$/i, '').trim();
    if (state) return state;
  }
  return mostCommon(vouchers.map((v) => v.placeOfSupply).filter((v): v is string => !!v));
}

function mostCommon(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function deriveGstSplit(
  gstRate: number | null,
  placeOfSupply: string | null,
  homeState: string | null,
  baseAmount: number,
): GstSplit {
  if (gstRate === null) return BLANK_SPLIT;

  const isInterState = !!(homeState && placeOfSupply && !sameState(homeState, placeOfSupply));
  if (isInterState) {
    return {
      isInterState: true,
      cgstRate: '',
      sgstRate: '',
      igstRate: gstRate,
      cgstAmount: '',
      sgstAmount: '',
      igstAmount: round2((baseAmount * gstRate) / 100),
    };
  }

  const half = round2(gstRate / 2);
  const halfAmount = round2((baseAmount * half) / 100);
  return {
    isInterState: false,
    cgstRate: half,
    sgstRate: half,
    igstRate: '',
    cgstAmount: halfAmount,
    sgstAmount: halfAmount,
    igstAmount: '',
  };
}

/**
 * CGST/SGST/IGST split for a ledger-only row, from the REAL posted GST
 * ledger entry's own kind (LedgerTaxSummary.gstKind) rather than a
 * placeOfSupply-vs-homeState guess — promoted out of invoice.mapper.ts
 * 2026-10-21 so bill.mapper.ts/credit-note.mapper.ts/vendor-credit.mapper.ts
 * can all share it: every one of these mappers has the identical two-branch
 * shape (a guessed split for the item-line branch, ground truth here for the
 * ledger-only branch) and this is the ground-truth half.
 */
export function gstSplitFromPostedKind(
  gstKind: 'IGST' | 'GST' | null,
  gstAmount: number | null,
  ratePercentage: number | '',
): GstSplit {
  if (!gstKind || gstAmount === null || ratePercentage === '') {
    return BLANK_SPLIT;
  }
  if (gstKind === 'IGST') {
    return {
      isInterState: true,
      cgstRate: '',
      sgstRate: '',
      igstRate: ratePercentage,
      cgstAmount: '',
      sgstAmount: '',
      igstAmount: gstAmount,
    };
  }
  const halfRate = round2(ratePercentage / 2);
  const halfAmount = round2(gstAmount / 2);
  return {
    isInterState: false,
    cgstRate: halfRate,
    sgstRate: halfRate,
    igstRate: '',
    cgstAmount: halfAmount,
    sgstAmount: halfAmount,
    igstAmount: '',
  };
}
