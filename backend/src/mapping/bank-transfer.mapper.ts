import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { LedgerIndex, resolveVoucherCurrency, tallyDateToJsDate } from './voucher-line.shared';

/**
 * Zoho Books "Bank Transfer" import columns — taken from the real template
 * (backend/src/mapping/templates/Deposit and Transfer.xlsx, sheet "Bank
 * Transfer"). Added 2026-10-21, the complementary half of
 * deposit.mapper.ts's Tally-`Contra`-voucher split — see its class doc
 * comment for the full reasoning. Kept here: ONLY a Contra voucher whose
 * BOTH ledger entries resolve (via `GroupHierarchyResolver`) to `Bank
 * Accounts` — a genuine bank-to-bank movement, not a cash deposit.
 *
 * From Account = the CREDITED ledger (the source bank account, decreasing);
 * To Account = the DEBITED ledger (the destination bank account,
 * increasing). Amount = the debited side's own posted amount. The real
 * template has a genuinely duplicate "Reporting Tags" header (once per
 * side, confirmed by reading the file) — same non-issue as Credit
 * Note.xlsx's duplicate "Issued Date"; this mapper has no per-side tag data
 * to put there regardless. Location has no Tally source.
 */
export interface ZohoBankTransferRow {
  'From Account': string;
  'Reporting Tags': '';
  'To Account': string;
  Date: Date | '';
  Amount: number | '';
  'Reference#': string;
  Description: string;
  Currency: string;
  'Exchange Rate': number;
  Location: '';
}

export class BankTransferMapper {
  constructor(
    private readonly ledgerIndex: LedgerIndex,
    private readonly hierarchy: GroupHierarchyResolver,
  ) {}

  toBankTransferRows(vouchers: TallyVoucher[]): ZohoBankTransferRow[] {
    return vouchers
      .map((v) => this.classify(v))
      .filter(
        (c): c is { debit: string; credit: string; amount: number | ''; voucher: TallyVoucher } =>
          c !== null &&
          this.standardGroup(c.debit) === 'Bank Accounts' &&
          this.standardGroup(c.credit) === 'Bank Accounts',
      )
      .map(({ debit, credit, amount, voucher }) => {
        const currency = resolveVoucherCurrency(voucher);
        return {
          'From Account': credit,
          'Reporting Tags': '',
          'To Account': debit,
          Date: tallyDateToJsDate(voucher.date) ?? '',
          Amount: amount,
          'Reference#': voucher.reference ?? '',
          Description: voucher.narration ?? '',
          Currency: currency.currencyCode,
          'Exchange Rate': currency.exchangeRate,
          Location: '',
        };
      });
  }

  private standardGroup(ledgerName: string): string | null {
    const ledger = this.ledgerIndex.get(ledgerName);
    return this.hierarchy.resolveToStandardGroup(ledger?.parent ?? null);
  }

  /** Same shape/caveat as deposit.mapper.ts's identical helper. */
  private classify(
    voucher: TallyVoucher,
  ): { debit: string; credit: string; amount: number | ''; voucher: TallyVoucher } | null {
    const debitEntry = voucher.ledgerEntries.find((e) => e.isDebit === true);
    const creditEntry = voucher.ledgerEntries.find((e) => e.isDebit === false);
    if (!debitEntry || !creditEntry) return null;
    return {
      debit: debitEntry.ledgerName,
      credit: creditEntry.ledgerName,
      amount: debitEntry.amount !== null ? Math.abs(debitEntry.amount) : '',
      voucher,
    };
  }
}
