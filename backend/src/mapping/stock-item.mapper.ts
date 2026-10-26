import { TallyStockItem } from '../tally/interfaces/tally.interfaces';
import { deriveInterStateTax, deriveIntraStateTax } from './gst-rate.shared';

/**
 * Zoho Books "Item" import columns actually populated by this project today
 * — taken from the real template (Master and Invoice or Bill/Item.xlsx,
 * sheet "Item"), which has 67 columns total; only the subset Tally's
 * currently-extracted StockItem fields can genuinely supply is listed here.
 *
 * SKU (added 2026-09-05) — the template has both a "SKU" and a separate
 * "Alias Name" column; both get the same TallyStockItem.alias value. Not a
 * duplication invented here — invoice.mapper.ts/bill.mapper.ts/
 * credit-note.mapper.ts already treat this exact field as each of THEIR
 * templates' own "SKU" column, so leaving Item.xlsx's own "SKU" blank while
 * "Alias Name" carries the same value was the actual inconsistency.
 *
 * Account/Purchase Account/Inventory Account (hardcoded 2026-10-20) —
 * TallyStockItem.salesAccount/purchaseAccount (SALESLIST.LIST/
 * PURCHASELIST.LIST, the item's default ledger allocation) are real Tally
 * fields, confirmed live to be genuinely fetched but unconfigured for every
 * item on this company — a previous pass derived these three columns from
 * them anyway, which meant they were always blank in practice. Per
 * reviewer feedback on the generated export, these three are meant to
 * always carry the same fixed ledger regardless of what Tally has
 * configured (every item lands in one Sales/COGS/Inventory Asset bucket),
 * so they're hardcoded constants here rather than a Tally-derived lookup —
 * same treatment as 'Item Type' below. TallyStockItem.salesAccount/
 * purchaseAccount are left as-is on the interface (still used by the raw
 * Full Sync browser) — just no longer read here.
 *
 * Rate/Purchase Rate (added 2026-10-20) — Tally DOES have a Price List
 * feature that could supply a real per-item rate (STANDARDPRICELIST.LIST/
 * STANDARDCOSTLIST.LIST), confirmed live 2026-09-05 to be genuinely
 * unconfigured on this company (came back empty for every item — a real
 * field with no data, not a wrong one) and not even fetched today. Per
 * reviewer feedback, a blank Rate/Purchase Rate should import as 0 rather
 * than blank, so these default to 0 rather than ''. If STANDARDPRICELIST.
 * LIST/STANDARDCOSTLIST.LIST are ever wired up, prefer the real value with
 * `?? 0` over this unconditional default.
 *
 * "Exemption Reason" investigated 2026-09-12, confirmed genuinely absent:
 * fetched GSTDETAILS.LIST's FULL structure live for a real Exempt item
 * (TAXABILITY/SRCOFGSTDETAILS/GSTINELIGIBLEITC/STATEWISEDETAILS.LIST) — no
 * free-text or coded exemption-reason field exists anywhere in it, unlike
 * the sibling fields this project already reads from the same list.
 *
 * Stock Group (added 2026-10-20) — Item.xlsx had no column for Tally's
 * Stock Group concept at all until now (added alongside this change);
 * TallyStockItem.parent IS Tally's real Stock Group for the item (see
 * EnvelopeBuilder.buildStockItemsRequest's own doc comment) and was
 * already being fetched/parsed, just never read by this mapper — unlike
 * ledger.mapper.ts, which does use the equivalent field for Chart-of-
 * Accounts grouping.
 */
const ACCOUNT_SALES = 'Sales';
const ACCOUNT_PURCHASE_COGS = 'Cost of Goods Sold';
const ACCOUNT_INVENTORY_ASSET = 'Inventory Asset';
/** Tally's own sentinel for a stock item with no real unit of measure
 *  (service/subscription line items) — confirmed live on this company's
 *  data (see master-extraction.service.ts's doc comment on period-scoped
 *  Stock Item batching). Importing this literal into Zoho as a "unit" would
 *  be wrong, not just unhelpful — blank is the correct value, same as a
 *  genuinely-unset baseUnit. */
const UNIT_NOT_APPLICABLE = 'not applicable';

export interface ZohoItemRow {
  'Item Name': string;
  SKU: string;
  'Alias Name': string;
  Description: string;
  'HSN/SAC': string;
  Rate: number;
  Account: string;
  'Purchase Account': string;
  'Inventory Account': string;
  'Inventory Valuation Method': string;
  'Usage unit': string;
  'Purchase Rate': number;
  'Opening Stock': number | '';
  'Opening Stock Value': number | '';
  'Stock On Hand': number | '';
  /**
   * Zoho's real "Item Type" column on this template is a *usage-scope*
   * concept ("Sales and Purchases" / "Sales" / "Purchases"), not goods/
   * service — confirmed against Zoho's own official Tally migration tool
   * (ZFMigrationTool-v1.9's xml_to_csv_config.yml defaults this exact
   * column to `"Sales and Purchases"`) and against the real template's own
   * two separate columns (this one at column 60, "Product Type" below at
   * column 27 — easy to conflate since Tally has no such usage-scope
   * concept at all). An earlier version of this mapper wrote 'goods' here,
   * which was never a valid value for this column. No per-item Sales-only/
   * Purchases-only signal exists in TallyStockItem (Account/Purchase
   * Account are confirmed unconfigured for every item on this company —
   * see the class doc comment), so "Sales and Purchases" is the correct,
   * Zoho-documented default rather than a guess.
   */
  'Item Type': string;
  /**
   * Added 2026-09-10 — the real goods/service classification, from
   * TallyStockItem.itemType (GSTTYPEOFSUPPLY). Previously entirely
   * unmapped (this template column was missed by an earlier audit that
   * conflated it with the "Item Type" column above). VERIFIED live: 28 of
   * 35 real items are "Services", only 6 "Goods" — defaults to 'goods' for
   * the remainder, matching Zoho's own tool's documented default for a
   * blank GSTTYPEOFSUPPLY.
   */
  'Product Type': string;
  /** No per-item active/inactive flag exists in TallyStockItem yet; a stock
   *  item just extracted from a live company is overwhelmingly likely to be
   *  in current use, so 'Active' is a reasonable default rather than an
   *  invented fact — same reasoning as ledger.mapper.ts's Currency default. */
  Status: string;
  /** Added 2026-09-05 — TallyStockItem.gstTaxability ("Taxable"/"Exempt"),
   *  VERIFIED live: 10 of 35 real items were explicitly Exempt, not merely
   *  unclassified — a plain boolean, distinct from the Intra/Inter State Tax
   *  columns below (which correctly stay blank for an Exempt item; no rate
   *  exists to report). */
  Taxable: boolean | '';
  /** Tally's own taxability value, passed through as-is rather than mapped
   *  to a guessed Zoho enum — see gstTaxability's doc comment. */
  'Taxability Type': string;
  'Intra State Tax Name': string;
  'Intra State Tax Rate': number | '';
  'Intra State Tax Type': string;
  'Inter State Tax Name': string;
  'Inter State Tax Rate': number | '';
  'Inter State Tax Type': string;
  /**
   * Added 2026-09-05 — operational defaults, not fabricated facts: every
   * Tally Stock Item, goods or service (see 'Product Type' above), is
   * usable in both sales and purchase transactions by construction, and
   * Zoho's own item-creation UI defaults a new item to sellable,
   * purchasable, and inventory-tracked unless a user explicitly unchecks
   * one — the same "least surprising assumption absent contrary
   * information" reasoning 'Status: Active' already uses. TallyStockItem
   * has no per-item flag to override any of these with real data yet.
   */
  Sellable: boolean;
  Purchasable: boolean;
  'Track Inventory': boolean;
  'Stock Group': string;
}

export class StockItemMapper {
  toItemRows(items: TallyStockItem[]): ZohoItemRow[] {
    return items.map((item) => this.toItemRow(item));
  }

  private toItemRow(item: TallyStockItem): ZohoItemRow {
    const intra = deriveIntraStateTax(item.gstRate);
    const inter = deriveInterStateTax(item.gstRate);

    return {
      'Item Name': item.name,
      SKU: item.alias ?? '',
      'Alias Name': item.alias ?? '',
      Description: item.description ?? '',
      'HSN/SAC': item.hsnCode ?? '',
      Rate: 0,
      Account: ACCOUNT_SALES,
      'Purchase Account': ACCOUNT_PURCHASE_COGS,
      'Inventory Account': ACCOUNT_INVENTORY_ASSET,
      'Inventory Valuation Method': item.inventoryValuationMethod ?? '',
      'Usage unit':
        item.baseUnit && item.baseUnit.trim().toLowerCase() !== UNIT_NOT_APPLICABLE ? item.baseUnit : '',
      'Purchase Rate': 0,
      'Opening Stock': item.openingBalance ?? '',
      'Opening Stock Value': item.openingValue ?? '',
      // TallyStockItem.closingBalance was already fetched (CLOSINGBALANCE)
      // but never written to this column — confirmed unused elsewhere in
      // this mapper, so wiring it here is a pure gap-fill, not a behavior
      // change to anything already relying on it.
      'Stock On Hand': item.closingBalance ?? '',
      'Item Type': 'Sales and Purchases',
      'Product Type': item.itemType ?? 'goods',
      Status: 'Active',
      Taxable: item.gstTaxability ? item.gstTaxability.toLowerCase() === 'taxable' : '',
      'Taxability Type': item.gstTaxability ?? '',
      'Intra State Tax Name': intra.name,
      'Intra State Tax Rate': intra.rate,
      'Intra State Tax Type': intra.type,
      'Inter State Tax Name': inter.name,
      'Inter State Tax Rate': inter.rate,
      'Inter State Tax Type': inter.type,
      Sellable: true,
      Purchasable: true,
      'Track Inventory': true,
      'Stock Group': item.parent ?? '',
    };
  }
}
