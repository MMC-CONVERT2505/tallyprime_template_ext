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
