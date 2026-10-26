import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { LedgerIndex, resolveVoucherCurrency, tallyDateToJsDate } from './voucher-line.shared';

/**
 * Zoho Books "Deposit" import columns — taken from the real template
 * (backend/src/mapping/templates/Deposit and Transfer.xlsx, sheet
 * "Desposit" — Zoho's own spelling, kept as-is rather than "corrected",
 * since ExcelGeneratorService.writeIntoTemplate matches by the template's
 * real header/sheet text). Added 2026-10-21, for Tally's `Contra` voucher
 * type — SPLIT with bank-transfer.mapper.ts, since Tally has one voucher
 * type (Contra) covering both "cash deposited into bank" and "bank-to-bank
 * transfer." A Contra voucher has exactly 2 ledger entries and no party
 * (both sides are the company's own accounts) — classified here by
 * resolving EITHER side's ledger group (via the existing
 * `GroupHierarchyResolver`, same as CustomerMapper/VendorMapper's own
 * Sundry-Debtors/-Creditors split) to `Cash-in-Hand`; the complementary
 * "both sides resolve to Bank Accounts" case is bank-transfer.mapper.ts's.
 * A Contra voucher matching neither (e.g. an unresolvable ledger group) is
 * dropped from BOTH sheets rather than guessed into one.
 *
 * To Account = the DEBITED ledger (money increasing — the bank account
 * receiving the deposit); From Account = the CREDITED ledger (money
 * decreasing — the cash account the deposit came from) — Tally's
 * Dr-increases/Cr-decreases convention for asset accounts. Amount = the
 * debited side's own posted amount. Paid Via/Received From/Received Via
 * have no reliable Tally source (free-text payment-method/payer concepts a
 * bare Contra voucher doesn't carry) and stay blank. Reporting Tags/
 * Location have no Tally source either.
 */
export interface ZohoDepositRow {
  'To Account': string;
  'Deposit Date': Date | '';
  'Paid Via': '';
  'Reference#': string;
  Description: string;
  Currency: string;
  'Exchange Rate': number;
  'From Account': string;
  'Received From': '';
  'Received Via': '';
  'Amount (AED)': number | '';
  'Reporting Tags': '';
  Location: '';
}

export class DepositMapper {
  constructor(
    private readonly ledgerIndex: LedgerIndex,
    private readonly hierarchy: GroupHierarchyResolver,
  ) {}

  toDepositRows(vouchers: TallyVoucher[]): ZohoDepositRow[] {
    return vouchers
      .map((v) => this.classify(v))
      .filter((c): c is { debit: string; credit: string; amount: number | ''; voucher: TallyVoucher } =>
        c !== null && (this.standardGroup(c.debit) === 'Cash-in-Hand' || this.standardGroup(c.credit) === 'Cash-in-Hand'),
      )
      .map(({ debit, credit, amount, voucher }) => {
        const currency = resolveVoucherCurrency(voucher);
        return {
          'To Account': debit,
          'Deposit Date': tallyDateToJsDate(voucher.date) ?? '',
          'Paid Via': '',
          'Reference#': voucher.reference ?? '',
          Description: voucher.narration ?? '',
          Currency: currency.currencyCode,
          'Exchange Rate': currency.exchangeRate,
          'From Account': credit,
          'Received From': '',
          'Received Via': '',
          'Amount (AED)': amount,
          'Reporting Tags': '',
          Location: '',
        };
      });
  }

  private standardGroup(ledgerName: string): string | null {
    const ledger = this.ledgerIndex.get(ledgerName);
    return this.hierarchy.resolveToStandardGroup(ledger?.parent ?? null);
  }

  /** A Contra voucher's 2 sides, by Dr/Cr — null if it doesn't have exactly
   *  the shape a Contra voucher should (defensive; genuinely malformed data
   *  is dropped rather than guessed at). */
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
