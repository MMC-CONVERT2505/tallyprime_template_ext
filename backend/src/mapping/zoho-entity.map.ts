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
 * built — see docs/tally-zoho-function-mapping.md for the full 33-row list.
 * As of 2026-10-21, templates exist for every voucher type that genuinely
 * has one: Sales/Purchase/Credit Note/Stock Journal (original 4) plus
 * Journal/Debit Note/Receipt/Payment/Contra (added this pass, closing the
 * gap this comment used to describe as "deliberately out of scope"). Still
 * genuinely out of scope (no template file exists at all): Tax, Currencies,
 * Company/Organizations, Sales/Purchase Order, Delivery Note/Challan,
 * Estimates.
 *
 * `Payment` and `Contra` each split across TWO entity keys (see
 * `zohoEntityForVoucherType`'s doc comment): `VENDOR_PAYMENT`/`EXPENSE` both
 * read `Payment` vouchers, classified by whether the party resolves to
 * Sundry Creditors (see vendor-payment.mapper.ts); `DEPOSIT`/`BANK_TRANSFER`
 * both read `Contra` vouchers, classified by ledger group (see
 * deposit.mapper.ts/bank-transfer.mapper.ts).
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
  | 'STOCK_JOURNAL'
  | 'JOURNAL'
  | 'VENDOR_CREDIT'
  | 'CUSTOMER_PAYMENT'
  | 'VENDOR_PAYMENT'
  | 'EXPENSE'
  | 'DEPOSIT'
  | 'BANK_TRANSFER';

export interface ZohoEntityDefinition {
  /** Filename inside TEMPLATES_DIR. */
  templateFile: string;
  /**
   * The sheet's REAL name inside that file — confirmed by opening each
   * workbook; several differ from what the filename would suggest
   * (COA.xlsx's sheet is "sample_accounts", Class.xlsx's is "Sheet1",
   * Stock Journal.xlsx's is "Inventory Adjustment", "Deposit and
   * Transfer.xlsx" has 2 sheets — "Desposit" (Zoho's own spelling, kept
   * as-is) and "Bank Transfer").
   */
  sheetName: string;
  /**
   * Set for every entity sourced from a VOUCHERS extraction — the Tally
   * voucher type this entity is filtered to at fetch time (see
   * TransactionExtractionService.getVouchers/ExtractVouchersDto). NOT
   * unique: `Payment` and `Contra` each appear on 2 entities — see this
   * file's top doc comment and `zohoEntityForVoucherType`'s doc comment.
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
  JOURNAL: { templateFile: 'Journal.xlsx', sheetName: 'Journal', voucherType: 'Journal' },
  VENDOR_CREDIT: {
    templateFile: 'Vendor_Credits.xlsx',
    sheetName: 'Vendor_Credits',
    voucherType: 'Debit Note',
  },
  CUSTOMER_PAYMENT: {
    templateFile: 'Customer_Payment.xlsx',
    sheetName: 'Customer_Payment',
    voucherType: 'Receipt',
  },
  VENDOR_PAYMENT: {
    templateFile: 'Vendor_Payment.xlsx',
    sheetName: 'Vendor_Payment',
    voucherType: 'Payment',
  },
  EXPENSE: { templateFile: 'Expense.xlsx', sheetName: 'Expense', voucherType: 'Payment' },
  DEPOSIT: {
    templateFile: 'Deposit and Transfer.xlsx',
    sheetName: 'Desposit',
    voucherType: 'Contra',
  },
  BANK_TRANSFER: {
    templateFile: 'Deposit and Transfer.xlsx',
    sheetName: 'Bank Transfer',
    voucherType: 'Contra',
  },
};

export function templatePathFor(key: ZohoEntityKey): string {
  return path.join(TEMPLATES_DIR, ZOHO_ENTITIES[key].templateFile);
}

/**
 * The filename a given entity's exported buffer should be zipped under —
 * almost always `templateFile` itself, EXCEPT `DEPOSIT`/`BANK_TRANSFER`,
 * which share one real template file (2 sheets) and would otherwise
 * collide as the same zip entry name. Used by every "bundle every entity
 * into one zip" consumer (BulkExportService.generateAllTemplates,
 * TallyFullSyncExportService.doBuildMappedZip,
 * scripts/generate-sample-export.ts) so the split-template naming fix lives
 * in exactly one place.
 */
export function zipFilenameFor(key: ZohoEntityKey): string {
  if (key === 'DEPOSIT') return 'Deposit.xlsx';
  if (key === 'BANK_TRANSFER') return 'Bank Transfer.xlsx';
  return ZOHO_ENTITIES[key].templateFile;
}

/**
 * Reverse lookup for the VOUCHERS-derived entities: a VOUCHERS
 * ExtractionJob only knows the voucher type it was fetched with
 * (job.params.voucherType), not which Zoho entity that maps to — this
 * resolves that at export time. Returns undefined for a voucher type with no
 * matching template at all, OR for `Payment`/`Contra` specifically — those
 * each match 2 entities (VENDOR_PAYMENT/EXPENSE and DEPOSIT/BANK_TRANSFER
 * respectively), so this single-result reverse lookup is genuinely
 * ambiguous for them; callers needing a single-job export for one of those
 * 4 entities must disambiguate explicitly (see ExtractionsService.
 * getExcelResult's `voucherEntity` parameter) rather than relying on this
 * function.
 */
export function zohoEntityForVoucherType(
  voucherType: string | null | undefined,
): ZohoEntityKey | undefined {
  if (!voucherType) return undefined;
  const matches = (Object.entries(ZOHO_ENTITIES) as [ZohoEntityKey, ZohoEntityDefinition][]).filter(
    ([, def]) => def.voucherType === voucherType,
  );
  return matches.length === 1 ? matches[0][0] : undefined;
}
