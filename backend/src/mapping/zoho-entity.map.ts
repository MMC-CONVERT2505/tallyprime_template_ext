import * as path from 'path';

/**
 * Templates are copied into this directory (from the project root's
 * "Master and Invoice or Bill/") so they ship with the build — see
 * backend/nest-cli.json's asset-copy config (plain `nest build`/`nest start`)
 * and package.json's `pkg.assets` (the packaged Windows agent .exe). Resolved
 * relative to this compiled file so it works identically under both.
 */
export const TEMPLATES_DIR = path.join(__dirname, 'templates');

/**
 * Only the Tally->Zoho mapping-doc rows that have a real template file get
 * built — see docs/tally-zoho-function-mapping.md for the full 33-row list;
 * everything without a template here (Tax, Currencies, Company/Organizations,
 * Debit Note, Receipt, Payment, Journal, Contra, Sales/Purchase Order,
 * Delivery Note/Challan, Estimates) is deliberately out of scope: there is no
 * template to write into, and inventing one would mean guessing Zoho's exact
 * import column set instead of reading it from a real file.
 */
export type ZohoEntityKey =
  | 'COA'
  | 'CUSTOMER'
  | 'VENDOR'
  | 'ITEM'
  | 'COST_CENTRE'
  | 'INVOICE'
  | 'BILL'
  | 'CREDIT_NOTE'
  | 'STOCK_JOURNAL';

export interface ZohoEntityDefinition {
  /** Filename inside TEMPLATES_DIR. */
  templateFile: string;
  /**
   * The sheet's REAL name inside that file — confirmed by opening each
   * workbook; 3 of 9 differ from what the filename would suggest
   * (COA.xlsx's sheet is "sample_accounts", Class.xlsx's is "Sheet1",
   * Stock Journal.xlsx's is "Inventory Adjustment").
   */
  sheetName: string;
  /**
   * Set only for the 4 entities sourced from a VOUCHERS extraction —
   * the Tally voucher type this entity is filtered to at fetch time
   * (see TransactionExtractionService.getVouchers/ExtractVouchersDto).
   */
  voucherType?: string;
}

export const ZOHO_ENTITIES: Record<ZohoEntityKey, ZohoEntityDefinition> = {
  COA: { templateFile: 'COA.xlsx', sheetName: 'sample_accounts' },
  CUSTOMER: { templateFile: 'Customer.xlsx', sheetName: 'Customer' },
  VENDOR: { templateFile: 'Vendor.xlsx', sheetName: 'Vendor' },
  ITEM: { templateFile: 'Item.xlsx', sheetName: 'Item' },
  COST_CENTRE: { templateFile: 'Class.xlsx', sheetName: 'Sheet1' },
  INVOICE: { templateFile: 'Invoice.xlsx', sheetName: 'Invoice', voucherType: 'Sales' },
  BILL: { templateFile: 'Bill.xlsx', sheetName: 'Bill', voucherType: 'Purchase' },
  CREDIT_NOTE: {
    templateFile: 'Credit Note.xlsx',
    sheetName: 'Credit Note',
    voucherType: 'Credit Note',
  },
  STOCK_JOURNAL: {
    templateFile: 'Stock Journal.xlsx',
    sheetName: 'Inventory Adjustment',
    voucherType: 'Stock Journal',
  },
};

export function templatePathFor(key: ZohoEntityKey): string {
  return path.join(TEMPLATES_DIR, ZOHO_ENTITIES[key].templateFile);
}

/**
 * Reverse lookup for the 4 VOUCHERS-derived entities: a VOUCHERS
 * ExtractionJob only knows the voucher type it was fetched with
 * (job.params.voucherType), not which Zoho entity that maps to — this
 * resolves that at export time. Returns undefined for a voucher type with no
 * matching template (an in-scope-for-extraction-but-out-of-scope-for-export
 * type, e.g. "Journal" or "Payment").
 */
export function zohoEntityForVoucherType(
  voucherType: string | null | undefined,
): ZohoEntityKey | undefined {
  if (!voucherType) return undefined;
  const match = (Object.entries(ZOHO_ENTITIES) as [ZohoEntityKey, ZohoEntityDefinition][]).find(
    ([, def]) => def.voucherType === voucherType,
  );
  return match?.[0];
}
