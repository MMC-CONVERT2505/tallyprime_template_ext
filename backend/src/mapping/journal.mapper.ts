import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { resolveVoucherCurrency, tallyDateToJsDate } from './voucher-line.shared';
import { round2 } from './voucher-tax.shared';

/**
 * Zoho Books "Journal" import columns — taken from the real template
 * (backend/src/mapping/templates/Journal.xlsx, sheet "Journal"). Added
 * 2026-10-21, the first mapper for Tally's `Journal` voucher type (fetched
 * and cached under VOUCHERS:Journal by every full sync already, but never
 * mapped to any Zoho template until now — see zoho-entity.map.ts's doc
 * comment history).
 *
 * One output row per `ledgerEntries[]` entry — a Journal voucher has no
 * inventory lines at all, so there's no item-line/ledger-only branching like
 * Invoice.xlsx/Bill.xlsx/Credit Note.xlsx; every Journal voucher has exactly
 * this one shape. Debit/Credit split by `entry.isDebit` (both blank, not 0,
 * when Tally couldn't determine a side at all — a real "unknown", not a real
 * zero amount). Account = entry.ledgerName; Account Code has no Tally
 * source. Item Order is the line's own 1-based position within the voucher
 * — real, derivable data (the order Tally itself returned the entries in),
 * not a guess.
 *
 * Contact Name/Contact Type stay blank: a multi-line Journal voucher has no
 * single "the" contact the way a Sales/Purchase voucher has one party
 * ledger — every ledgerName here is just another account being debited or
 * credited, with no distinguished "customer" or "vendor" role. Tax
 * Name/Percentage/Amount/Type also stay blank — unlike
 * summarizeLedgerEntries' voucher-level GST/TDS/TCS classification (built
 * for a voucher with ONE clear non-tax base to attribute tax against), a
 * Journal voucher has no such single base, so attempting a per-line
 * classification here would be new, unverified logic rather than a reuse of
 * something already proven; Total is computed from genuinely real data
 * instead (the sum of every Debit-side entry, which by double-entry
 * bookkeeping equals the sum of Credit-side entries on a balanced voucher).
 *
 * Notes = voucher.narration (the voucher-level note); Description stays
 * blank — Tally's ledger entries carry no per-line free-text field distinct
 * from narration for this project to put there.
 */
export interface ZohoJournalRow {
  'Journal Number': string;
  'Journal Number Prefix': '';
  'Journal Number Suffix': '';
  'Journal Created By': '';
  'Journal Date': Date | '';
  'Journal ID': '';
  'Journal Type': '';
  Status: '';
  'Journal Entity Type': '';
  'Reference Number': string;
  Notes: string;
  'Is Inclusive Tax': '';
  'Exchange Rate': number;
  'Location ID': '';
  'Location Name': '';
  'Item Order': number;
  'Tax Name': '';
  'Tax Percentage': '';
  'Tax Amount': '';
  'Tax Type': '';
  'Project Name': '';
  Debit: number | '';
  Credit: number | '';
  Account: string;
  'Account Code': '';
  'Contact Name': '';
  'Contact Type': '';
  Currency: string;
  Total: number | '';
  Description: '';
  'Cost Centre': '';
}

const BLANK_FIELDS: Omit<
  ZohoJournalRow,
  | 'Journal Number'
  | 'Journal Date'
  | 'Reference Number'
  | 'Notes'
  | 'Exchange Rate'
  | 'Item Order'
  | 'Debit'
  | 'Credit'
  | 'Account'
  | 'Currency'
  | 'Total'
> = {
  'Journal Number Prefix': '',
  'Journal Number Suffix': '',
  'Journal Created By': '',
  'Journal ID': '',
  'Journal Type': '',
  Status: '',
  'Journal Entity Type': '',
  'Is Inclusive Tax': '',
  'Location ID': '',
  'Location Name': '',
  'Tax Name': '',
  'Tax Percentage': '',
  'Tax Amount': '',
  'Tax Type': '',
  'Project Name': '',
  'Account Code': '',
  'Contact Name': '',
  'Contact Type': '',
  Description: '',
  'Cost Centre': '',
};

export class JournalMapper {
  toJournalRows(vouchers: TallyVoucher[]): ZohoJournalRow[] {
    return vouchers.flatMap((voucher) => this.toJournalRowsForVoucher(voucher));
  }

  private toJournalRowsForVoucher(voucher: TallyVoucher): ZohoJournalRow[] {
    if (voucher.ledgerEntries.length === 0) return [];

    const currency = resolveVoucherCurrency(voucher);
    const total = round2(
      voucher.ledgerEntries.reduce(
        (sum, entry) => sum + (entry.isDebit && entry.amount !== null ? Math.abs(entry.amount) : 0),
        0,
      ),
    );

    const common: Omit<ZohoJournalRow, 'Item Order' | 'Debit' | 'Credit' | 'Account'> = {
      ...BLANK_FIELDS,
      'Journal Number': voucher.voucherNumber ?? '',
      'Journal Date': tallyDateToJsDate(voucher.date) ?? '',
      'Reference Number': voucher.reference ?? '',
      Notes: voucher.narration ?? '',
      'Exchange Rate': currency.exchangeRate,
      Currency: currency.currencyCode,
      Total: total || '',
    };

    return voucher.ledgerEntries.map((entry, index) => {
      const amount = entry.amount !== null ? Math.abs(entry.amount) : '';
      return {
        ...common,
        'Item Order': index + 1,
        Debit: entry.isDebit === true ? amount : '',
        Credit: entry.isDebit === false ? amount : '',
        Account: entry.ledgerName,
      };
    });
  }
}
