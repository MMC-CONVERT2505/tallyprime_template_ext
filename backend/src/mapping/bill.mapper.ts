import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { deriveIntraStateTax } from './gst-rate.shared';
import { resolveGstTreatment } from './ledger-contact.shared';
import { StockItemIndex, tallyDateToJsDate } from './voucher-line.shared';
import {
  percentageOf,
  round2,
  summarizeLedgerEntries,
  TAX_TYPE_ITEM_AMOUNT,
} from './voucher-tax.shared';

/**
 * Zoho Books "Bill" import columns actually populated by this project —
 * taken from the real template (Master and Invoice or Bill/Bill.xlsx, sheet
 * "Bill"). One output row per Tally inventory line for an item-based
 * Purchase voucher (Zoho's own flat-per-line convention, same as
 * invoice.mapper.ts), PLUS — unlike Invoice.xlsx — a Purchase voucher
 * recorded with NO inventory lines at all (a pure ledger/service bill: rent,
 * professional fees, subscriptions — anything entered in Tally's "As
 * Voucher" accounting mode rather than item-invoice mode) still gets exactly
 * one row. Silently dropping those was a real, confirmed bug: a Bill's
 * TallyVoucher.inventoryEntries is legitimately empty for any non-stock
 * purchase, and the previous `if (inventoryEntries.length === 0) return []`
 * guard discarded the whole voucher — vendor, GSTIN, amount and all —
 * instead of just skipping the (nonexistent) per-item breakdown.
 *
 * Tax on an item line still comes from the STOCK_ITEMS job's item master
 * (`itemIndex`, keyed by item name) — see invoice.mapper.ts's doc comment
 * for why per-line GST detail isn't parsed off the voucher itself. A
 * service-only row has no item to look up, so its Tax Name/Percentage/Amount
 * are instead read directly off the voucher's own posted ledger entries
 * (whichever line's name matches IGST/CGST/SGST/UTGST) — genuinely more
 * accurate than the item-rate approach where it's available, but only used
 * as a fallback here to avoid changing the already-tested item-line
 * behavior. SubTotal/Total/Balance/TDS/TCS are voucher-level (Zoho's own
 * per-line-repeats-header convention — see invoice.mapper.ts), derived from
 * ledger entries for every voucher regardless of whether it has item lines.
 */
export interface ZohoBillRow {
  'Bill Date': Date | '';
  'Bill Number': string;
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  'Vendor Name': string;
  'Currency Code': string;
  'Purchase Order Number': string;
  'Item Name': string;
  SKU: string;
  'Item Description': string;
  'Usage unit': string;
  Quantity: number | '';
  Rate: number | '';
  'Item Type': string;
  'Tax Name': string;
  'Tax Percentage': number | '';
  'Tax Amount': number | '';
  'Tax Type': string;
  'Item Total': number | '';
  SubTotal: number | '';
  Total: number | '';
  Balance: number | '';
  'TDS Name': string;
  'TDS Percentage': number | '';
  'TDS Amount': number | '';
  'TCS Tax Name': string;
  'TCS Percentage': number | '';
  'TCS Amount': number | '';
  'Vendor Notes': string;
  'HSN/SAC': string;
}

const DEFAULT_CURRENCY_CODE = 'INR';

export class BillMapper {
  constructor(private readonly itemIndex: StockItemIndex) {}

  toBillRows(vouchers: TallyVoucher[]): ZohoBillRow[] {
    return vouchers.flatMap((voucher) => this.toBillRowsForVoucher(voucher));
  }

  private toBillRowsForVoucher(voucher: TallyVoucher): ZohoBillRow[] {
    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);

    const common: Pick<
      ZohoBillRow,
      | 'Bill Date'
      | 'Bill Number'
      | 'GST Treatment'
      | 'GST Identification Number (GSTIN)'
      | 'Vendor Name'
      | 'Currency Code'
      | 'Purchase Order Number'
      | 'Vendor Notes'
      | 'TDS Name'
      | 'TDS Amount'
      | 'TCS Tax Name'
      | 'TCS Amount'
    > = {
      'Bill Date': tallyDateToJsDate(voucher.date) ?? '',
      'Bill Number': voucher.voucherNumber ?? '',
      'GST Treatment': resolveGstTreatment(voucher.partyGstin),
      'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
      'Vendor Name': voucher.partyLedgerName ?? '',
      'Currency Code': DEFAULT_CURRENCY_CODE,
      // Tally has no dedicated "linked Purchase Order" field on a Purchase
      // voucher; the Ref# field (`reference`) is the closest genuine source
      // — commonly used for exactly this purpose — but is a free-text field
      // Tally doesn't validate, so treat this as best-effort, not a
      // guaranteed PO number.
      'Purchase Order Number': voucher.reference ?? '',
      'Vendor Notes': voucher.narration ?? '',
      'TDS Name': summary.tdsName,
      'TDS Amount': summary.tdsAmount,
      'TCS Tax Name': summary.tcsName,
      'TCS Amount': summary.tcsAmount,
    };

    if (voucher.inventoryEntries.length > 0) {
      const lines = voucher.inventoryEntries.map((line) => {
        const item = this.itemIndex.get(line.stockItemName);
        const tax = deriveIntraStateTax(item?.gstRate ?? null);
        const taxAmount: number | '' =
          item?.gstRate !== null && item?.gstRate !== undefined && line.amount !== null
            ? round2(line.amount * (item.gstRate / 100))
            : '';
        return { line, item, tax, taxAmount };
      });

      const subTotal = round2(lines.reduce((sum, { line }) => sum + (line.amount ?? 0), 0));
      const taxTotal = round2(
        lines.reduce((sum, { taxAmount }) => sum + (taxAmount === '' ? 0 : taxAmount), 0),
      );
      const total = round2(subTotal + taxTotal);

      return lines.map(({ line, item, tax, taxAmount }) => ({
        ...common,
        'Item Name': line.stockItemName,
        SKU: item?.alias ?? '',
        'Item Description': item?.description ?? '',
        'Usage unit': item?.baseUnit ?? '',
        Quantity: line.quantity ?? '',
        Rate: line.rate ?? '',
        'Item Type': 'goods',
        'Tax Name': tax.name,
        'Tax Percentage': tax.rate,
        'Tax Amount': taxAmount,
        'Tax Type': tax.name ? TAX_TYPE_ITEM_AMOUNT : '',
        'Item Total': line.amount ?? '',
        SubTotal: subTotal,
        Total: total,
        Balance: total,
        'TDS Percentage': percentageOf(summary.tdsAmount, subTotal),
        'TCS Percentage': percentageOf(summary.tcsAmount, subTotal),
        'HSN/SAC': item?.hsnCode ?? '',
      }));
    }

    // No inventory lines — a genuine, ledger-only Purchase voucher (service/
    // expense bill). Emit exactly one row instead of silently dropping the
    // whole bill: this is the actual fix for "Bill records missing".
    if (voucher.ledgerEntries.length === 0) return [];

    const subTotal = summary.nonTaxLedgerTotal;
    const taxAmount = summary.gstAmount ?? '';
    const taxPercentage = percentageOf(taxAmount, subTotal);
    const taxName =
      summary.gstKind && taxPercentage !== '' ? `${summary.gstKind}${taxPercentage}` : '';
    const total = round2(subTotal + (summary.gstAmount ?? 0));

    return [
      {
        ...common,
        'Item Name': '',
        SKU: '',
        'Item Description': '',
        'Usage unit': '',
        Quantity: '',
        Rate: '',
        'Item Type': 'service',
        'Tax Name': taxName,
        'Tax Percentage': taxPercentage,
        'Tax Amount': taxAmount,
        'Tax Type': taxName ? TAX_TYPE_ITEM_AMOUNT : '',
        'Item Total': subTotal || '',
        SubTotal: subTotal || '',
        Total: total,
        Balance: total,
        'TDS Percentage': percentageOf(summary.tdsAmount, subTotal),
        'TCS Percentage': percentageOf(summary.tcsAmount, subTotal),
        'HSN/SAC': '',
      },
    ];
  }
}
