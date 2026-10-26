import {
  TallyCostCentre,
  TallyGroup,
  TallyLedger,
  TallyStockItem,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';

/**
 * A small but realistic single-company dataset spanning every one of the 9
 * built Zoho entities, including values that must stay BLANK in the output
 * (no Tally source for them) so a consumer of this fixture can catch
 * accidental fabrication, not just missing data.
 *
 * Shared by two consumers that both need the exact same fixture to mean the
 * same thing: full-export-pipeline.spec.ts (asserts every cell lands
 * correctly) and scripts/generate-sample-export.ts (produces an actual
 * sample .zip a human can open and eyeball) — defined once here so neither
 * can silently drift from the other.
 */

export const SAMPLE_GROUPS: TallyGroup[] = [
  { name: 'Office Expenses', parent: 'Indirect Expenses', alterId: 1 },
  { name: 'Current Bank Accounts', parent: 'Bank Accounts', alterId: 2 },
];

export const SAMPLE_LEDGERS: TallyLedger[] = [
  {
    name: 'Rohan Traders',
    parent: 'Sundry Debtors',
    description: null,
    openingBalance: -15000,
    closingBalance: -12000,
    alterId: 101,
    reservedName: null,
    gstin: '27AABCU9603R1ZM',
    panNumber: 'AABCU9603R',
    email: 'rohan@traders.in',
    phone: '02212345678',
    mobile: '9876543210',
    billingAddress: '12 MG Road, Andheri',
    billingState: 'Maharashtra',
    billingCountry: 'India',
    billingPincode: '400001',
    bankName: null,
    bankAccountNumber: null,
    ifscCode: null,
    accountHolderName: null,
    website: null,
    creditLimit: null,
    contactPersonName: null,
    gstRegistrationType: null,
    gstPlaceOfSupply: null,
    mailingName: null,
    creditPeriod: null,
  },
  {
    name: 'Priya Distributors',
    parent: 'Sundry Debtors',
    description: null,
    openingBalance: -42000,
    closingBalance: -30500,
    alterId: 105,
    reservedName: null,
    gstin: '19AACPD1122K1ZQ',
    panNumber: 'AACPD1122K',
    email: 'billing@priyadist.in',
    phone: '03322334455',
    mobile: '9830011223',
    billingAddress: '7 Park Street',
    billingState: 'West Bengal',
    billingCountry: 'India',
    billingPincode: '700016',
    bankName: null,
    bankAccountNumber: null,
    ifscCode: null,
    accountHolderName: null,
    website: null,
    creditLimit: null,
    contactPersonName: null,
    gstRegistrationType: null,
    gstPlaceOfSupply: null,
    mailingName: null,
    creditPeriod: null,
  },
  {
    name: 'Global Supplies Pvt Ltd',
    parent: 'Sundry Creditors',
    description: null,
    openingBalance: 8000,
    closingBalance: 6500,
    alterId: 102,
    reservedName: null,
    gstin: '29AAACG1234F1Z5',
    panNumber: 'AAACG1234F',
    email: 'accounts@globalsupplies.in',
    phone: '08098765432',
    mobile: '9123456780',
    billingAddress: '45 Industrial Area, Peenya',
    billingState: 'Karnataka',
    billingCountry: 'India',
    billingPincode: '560001',
    bankName: 'HDFC Bank',
    bankAccountNumber: '50100123456789',
    ifscCode: 'HDFC0000123',
    accountHolderName: 'Global Supplies Pvt Ltd',
    website: null,
    creditLimit: null,
    contactPersonName: null,
    gstRegistrationType: null,
    gstPlaceOfSupply: null,
    mailingName: null,
    creditPeriod: null,
  },
  {
    name: 'Office Rent',
    parent: 'Office Expenses',
    description: 'Monthly office rent',
    openingBalance: 0,
    closingBalance: 0,
    alterId: 103,
    reservedName: null,
    gstin: null,
    panNumber: null,
    email: null,
    phone: null,
    mobile: null,
    billingAddress: null,
    billingState: null,
    billingCountry: null,
    billingPincode: null,
    bankName: null,
    bankAccountNumber: null,
    ifscCode: null,
    accountHolderName: null,
    website: null,
    creditLimit: null,
    contactPersonName: null,
    gstRegistrationType: null,
    gstPlaceOfSupply: null,
    mailingName: null,
    creditPeriod: null,
  },
  {
    name: 'HDFC Bank Current A/c',
    parent: 'Current Bank Accounts',
    description: null,
    openingBalance: -250000,
    closingBalance: -180000,
    alterId: 104,
    reservedName: null,
    gstin: null,
    panNumber: null,
    email: null,
    phone: null,
    mobile: null,
    billingAddress: null,
    billingState: null,
    billingCountry: null,
    billingPincode: null,
    bankName: null,
    bankAccountNumber: null,
    ifscCode: null,
    accountHolderName: null,
    website: null,
    creditLimit: null,
    contactPersonName: null,
    gstRegistrationType: null,
    gstPlaceOfSupply: null,
    mailingName: null,
    creditPeriod: null,
  },
  {
    name: 'Cash',
    parent: 'Cash-in-Hand',
    description: null,
    openingBalance: -15000,
    closingBalance: -9500,
    alterId: 105,
    reservedName: null,
    gstin: null,
    panNumber: null,
    email: null,
    phone: null,
    mobile: null,
    billingAddress: null,
    billingState: null,
    billingCountry: null,
    billingPincode: null,
    bankName: null,
    bankAccountNumber: null,
    ifscCode: null,
    accountHolderName: null,
    website: null,
    creditLimit: null,
    contactPersonName: null,
    gstRegistrationType: null,
    gstPlaceOfSupply: null,
    mailingName: null,
    creditPeriod: null,
  },
  {
    name: 'ICICI Bank Savings A/c',
    parent: 'Current Bank Accounts',
    description: null,
    openingBalance: -500000,
    closingBalance: -680000,
    alterId: 106,
    reservedName: null,
    gstin: null,
    panNumber: null,
    email: null,
    phone: null,
    mobile: null,
    billingAddress: null,
    billingState: null,
    billingCountry: null,
    billingPincode: null,
    bankName: null,
    bankAccountNumber: null,
    ifscCode: null,
    accountHolderName: null,
    website: null,
    creditLimit: null,
    contactPersonName: null,
    gstRegistrationType: null,
    gstPlaceOfSupply: null,
    mailingName: null,
    creditPeriod: null,
  },
];

export const SAMPLE_STOCK_ITEMS: TallyStockItem[] = [
  {
    name: 'Widget A',
    parent: 'Finished Goods',
    description: 'Standard widget',
    baseUnit: 'Nos',
    openingBalance: 100,
    openingValue: 25000,
    closingBalance: 80,
    closingValue: 20000,
    alterId: 201,
    alias: 'WID-A',
    hsnCode: '84819000',
    gstRate: 18,
    gstTaxability: 'Taxable',
    itcIneligible: false,
    itemType: 'goods',
    inventoryValuationMethod: 'Avg. Cost',
    salesAccount: null,
    purchaseAccount: null,
  },
  {
    name: 'Widget B',
    parent: 'Finished Goods',
    description: 'Premium widget',
    baseUnit: 'Nos',
    openingBalance: 50,
    openingValue: 20000,
    closingBalance: 40,
    closingValue: 16000,
    alterId: 202,
    alias: 'WID-B',
    hsnCode: '84819000',
    gstRate: 12,
    gstTaxability: 'Taxable',
    itcIneligible: false,
    itemType: 'goods',
    inventoryValuationMethod: 'Avg. Cost',
    salesAccount: null,
    purchaseAccount: null,
  },
  {
    name: 'Raw Material X',
    parent: 'Raw Materials',
    description: null,
    baseUnit: 'Kg',
    openingBalance: 500,
    openingValue: 50000,
    closingBalance: 300,
    closingValue: 30000,
    alterId: 203,
    alias: null,
    hsnCode: '39269099',
    gstRate: 5,
    gstTaxability: 'Taxable',
    itcIneligible: false,
    itemType: 'goods',
    inventoryValuationMethod: 'Avg. Cost',
    salesAccount: null,
    purchaseAccount: null,
  },
];

export const SAMPLE_COST_CENTRES: TallyCostCentre[] = [
  { name: 'Mumbai Branch', parent: 'Primary', alterId: 301 },
  { name: 'Bangalore Branch', parent: 'Primary', alterId: 302 },
  { name: 'Admin', parent: 'Primary', alterId: 303 },
];

export const SAMPLE_SALES_VOUCHER: TallyVoucher = {
  date: '20260405',
  voucherType: 'Sales',
  voucherNumber: 'INV-1001',
  partyLedgerName: 'Rohan Traders',
  narration: 'Sale of widgets',
  reference: null,
  alterId: 401,
  ledgerEntries: [],
  inventoryEntries: [
    { stockItemName: 'Widget A', quantity: 10, rate: 250, amount: 2500 , discountPercent: null, accountLedgerName: null },
    { stockItemName: 'Widget B', quantity: 5, rate: 400, amount: 2000 , discountPercent: null, accountLedgerName: null },
  ],
  partyGstin: '27AABCU9603R1ZM',
  placeOfSupply: 'Maharashtra',
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

export const SAMPLE_SALES_VOUCHER_2: TallyVoucher = {
  date: '20260408',
  voucherType: 'Sales',
  voucherNumber: 'INV-1003',
  partyLedgerName: 'Priya Distributors',
  narration: 'Sale of finished goods',
  reference: null,
  alterId: 405,
  ledgerEntries: [],
  inventoryEntries: [{ stockItemName: 'Widget B', quantity: 20, rate: 380, amount: 7600 , discountPercent: null, accountLedgerName: null }],
  partyGstin: '19AACPD1122K1ZQ',
  placeOfSupply: 'West Bengal',
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

/** A genuine ledger-only Sales voucher — a service invoice recorded in
 *  Tally's accounting-only mode, no stock item at all. Must still produce
 *  exactly one Invoice.xlsx row (invoice.mapper.ts used to silently drop
 *  any voucher with zero inventory entries — a real, confirmed bug; see
 *  bill.mapper.ts's doc comment for the live incident that surfaced it),
 *  with Item Tax/Item Tax % derived from the posted IGST ledger entry
 *  instead of an item master lookup. */
export const SAMPLE_LEDGER_ONLY_SALES_VOUCHER: TallyVoucher = {
  date: '20260406',
  voucherType: 'Sales',
  voucherNumber: 'INV-1002',
  partyLedgerName: 'Rohan Traders',
  narration: 'Consulting services rendered',
  reference: null,
  alterId: 406,
  ledgerEntries: [
    { ledgerName: 'Consulting Income', amount: -5000, isDeemedPositive: true, isDebit: false , billCreditPeriodDays: null, billAllocations: [] },
    { ledgerName: 'Output IGST', amount: -900, isDeemedPositive: true, isDebit: false , billCreditPeriodDays: null, billAllocations: [] },
    { ledgerName: 'Rohan Traders', amount: 5900, isDeemedPositive: false, isDebit: true , billCreditPeriodDays: null, billAllocations: [] },
  ],
  inventoryEntries: [],
  partyGstin: '27AABCU9603R1ZM',
  placeOfSupply: 'Maharashtra',
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

export const SAMPLE_PURCHASE_VOUCHER: TallyVoucher = {
  date: '20260410',
  voucherType: 'Purchase',
  voucherNumber: 'PUR-2001',
  partyLedgerName: 'Global Supplies Pvt Ltd',
  narration: 'Purchase of raw material',
  reference: 'PO-55',
  alterId: 402,
  // TDS deducted at source (2% of the 20000 item value) — exercises
  // Bill.xlsx's ledger-derived TDS Name/Amount/Percentage columns.
  ledgerEntries: [
    { ledgerName: 'TDS on Contractor', amount: 400, isDeemedPositive: false, isDebit: false , billCreditPeriodDays: null, billAllocations: [] },
    {
      ledgerName: 'Global Supplies Pvt Ltd',
      amount: -20600,
      isDeemedPositive: false,
      isDebit: false,
     billCreditPeriodDays: null, billAllocations: [] },
  ],
  inventoryEntries: [{ stockItemName: 'Raw Material X', quantity: 200, rate: 100, amount: 20000 , discountPercent: null, accountLedgerName: null }],
  partyGstin: '29AAACG1234F1Z5',
  placeOfSupply: 'Karnataka',
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

export const SAMPLE_CREDIT_NOTE_VOUCHER: TallyVoucher = {
  date: '20260415',
  voucherType: 'Credit Note',
  voucherNumber: 'CN-3001',
  partyLedgerName: 'Rohan Traders',
  narration: 'Sales return - damaged widget',
  reference: 'RMA-2026-01',
  alterId: 403,
  ledgerEntries: [],
  inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 250, amount: 250 , discountPercent: null, accountLedgerName: null }],
  partyGstin: '27AABCU9603R1ZM',
  placeOfSupply: 'Maharashtra',
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

export const SAMPLE_STOCK_JOURNAL_VOUCHER: TallyVoucher = {
  date: '20260420',
  voucherType: 'Stock Journal',
  voucherNumber: 'SJ-4001',
  partyLedgerName: null,
  narration: 'Stock adjustment - physical count variance',
  reference: 'ADJ-01',
  alterId: 404,
  ledgerEntries: [],
  inventoryEntries: [
    { stockItemName: 'Widget A', quantity: -2, rate: 250, amount: -500 , discountPercent: null, accountLedgerName: null },
    { stockItemName: 'Raw Material X', quantity: 10, rate: 100, amount: 1000 , discountPercent: null, accountLedgerName: null },
  ],
  partyGstin: null,
  placeOfSupply: null,
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

export const SAMPLE_INVOICE_VOUCHERS: TallyVoucher[] = [
  SAMPLE_SALES_VOUCHER,
  SAMPLE_LEDGER_ONLY_SALES_VOUCHER,
  SAMPLE_SALES_VOUCHER_2,
];
export const SAMPLE_BILL_VOUCHERS: TallyVoucher[] = [SAMPLE_PURCHASE_VOUCHER];
export const SAMPLE_CREDIT_NOTE_VOUCHERS: TallyVoucher[] = [SAMPLE_CREDIT_NOTE_VOUCHER];
export const SAMPLE_STOCK_JOURNAL_VOUCHERS: TallyVoucher[] = [SAMPLE_STOCK_JOURNAL_VOUCHER];

/** A Receipt against Rohan Traders' own INV-1001 (SAMPLE_SALES_VOUCHER) —
 *  the party entry's billAllocations exercises
 *  customer-payment.mapper.ts's one-row-per-allocation expansion. */
export const SAMPLE_RECEIPT_VOUCHER: TallyVoucher = {
  date: '20260425',
  voucherType: 'Receipt',
  voucherNumber: 'RCPT-5001',
  partyLedgerName: 'Rohan Traders',
  narration: 'Payment received against INV-1001',
  reference: 'RCPT-REF-01',
  alterId: 501,
  ledgerEntries: [
    { ledgerName: 'HDFC Bank Current A/c', amount: 4500, isDeemedPositive: false, isDebit: true, billCreditPeriodDays: null, billAllocations: [] },
    { ledgerName: 'Rohan Traders', amount: -4500, isDeemedPositive: true, isDebit: false, billCreditPeriodDays: null, billAllocations: [{ name: 'INV-1001', amount: 4500 }] },
  ],
  inventoryEntries: [],
  partyGstin: '27AABCU9603R1ZM',
  placeOfSupply: 'Maharashtra',
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

/** Pays Global Supplies Pvt Ltd (Sundry Creditors) against its own
 *  PUR-2001 (SAMPLE_PURCHASE_VOUCHER) — VendorPaymentMapper keeps this row;
 *  ExpenseMapper drops it. */
export const SAMPLE_PAYMENT_VOUCHER_VENDOR: TallyVoucher = {
  date: '20260426',
  voucherType: 'Payment',
  voucherNumber: 'PAY-6001',
  partyLedgerName: 'Global Supplies Pvt Ltd',
  narration: 'Payment against PUR-2001',
  reference: 'PAY-REF-01',
  alterId: 502,
  ledgerEntries: [
    { ledgerName: 'Global Supplies Pvt Ltd', amount: -20600, isDeemedPositive: false, isDebit: true, billCreditPeriodDays: null, billAllocations: [{ name: 'PUR-2001', amount: 20600 }] },
    { ledgerName: 'ICICI Bank Savings A/c', amount: 20600, isDeemedPositive: true, isDebit: false, billCreditPeriodDays: null, billAllocations: [] },
  ],
  inventoryEntries: [],
  partyGstin: '29AAACG1234F1Z5',
  placeOfSupply: 'Karnataka',
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

/** A direct/ad-hoc expense payment — the party ('Office Rent') is a plain
 *  expense ledger, not a registered vendor, so ExpenseMapper keeps this row
 *  and VendorPaymentMapper drops it — the exact complementary split. */
export const SAMPLE_PAYMENT_VOUCHER_EXPENSE: TallyVoucher = {
  date: '20260427',
  voucherType: 'Payment',
  voucherNumber: 'PAY-6002',
  partyLedgerName: 'Office Rent',
  narration: 'Monthly office rent payment',
  reference: null,
  alterId: 503,
  ledgerEntries: [
    { ledgerName: 'Office Rent', amount: -10000, isDeemedPositive: false, isDebit: true, billCreditPeriodDays: null, billAllocations: [] },
    { ledgerName: 'Cash', amount: 10000, isDeemedPositive: true, isDebit: false, billCreditPeriodDays: null, billAllocations: [] },
  ],
  inventoryEntries: [],
  partyGstin: null,
  placeOfSupply: null,
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

/** A purchase return against Global Supplies Pvt Ltd — the Debit Note
 *  mirror of SAMPLE_CREDIT_NOTE_VOUCHER. */
export const SAMPLE_DEBIT_NOTE_VOUCHER: TallyVoucher = {
  date: '20260428',
  voucherType: 'Debit Note',
  voucherNumber: 'DN-7001',
  partyLedgerName: 'Global Supplies Pvt Ltd',
  narration: 'Purchase return - defective material',
  reference: 'PUR-2001',
  alterId: 504,
  ledgerEntries: [],
  inventoryEntries: [{ stockItemName: 'Raw Material X', quantity: 5, rate: 100, amount: 500, discountPercent: null, accountLedgerName: null }],
  partyGstin: '29AAACG1234F1Z5',
  placeOfSupply: 'Karnataka',
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

/** A plain multi-line Journal voucher (depreciation) — no party, no
 *  inventory, exactly the shape journal.mapper.ts expects. */
export const SAMPLE_JOURNAL_VOUCHER: TallyVoucher = {
  date: '20260429',
  voucherType: 'Journal',
  voucherNumber: 'JRNL-8001',
  partyLedgerName: null,
  narration: 'Depreciation adjustment',
  reference: 'DEP-01',
  alterId: 505,
  ledgerEntries: [
    { ledgerName: 'Depreciation Expense', amount: -5000, isDeemedPositive: false, isDebit: true, billCreditPeriodDays: null, billAllocations: [] },
    { ledgerName: 'Accumulated Depreciation', amount: 5000, isDeemedPositive: true, isDebit: false, billCreditPeriodDays: null, billAllocations: [] },
  ],
  inventoryEntries: [],
  partyGstin: null,
  placeOfSupply: null,
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

/** Cash deposited into the ICICI account — DepositMapper keeps this row
 *  (one side resolves to Cash-in-Hand); BankTransferMapper drops it. */
export const SAMPLE_CONTRA_VOUCHER_DEPOSIT: TallyVoucher = {
  date: '20260430',
  voucherType: 'Contra',
  voucherNumber: 'CONT-9001',
  partyLedgerName: null,
  narration: 'Cash deposited into bank',
  reference: null,
  alterId: 506,
  ledgerEntries: [
    { ledgerName: 'ICICI Bank Savings A/c', amount: 8000, isDeemedPositive: true, isDebit: true, billCreditPeriodDays: null, billAllocations: [] },
    { ledgerName: 'Cash', amount: -8000, isDeemedPositive: false, isDebit: false, billCreditPeriodDays: null, billAllocations: [] },
  ],
  inventoryEntries: [],
  partyGstin: null,
  placeOfSupply: null,
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

/** A bank-to-bank transfer — BankTransferMapper keeps this row (both sides
 *  resolve to Bank Accounts); DepositMapper drops it. */
export const SAMPLE_CONTRA_VOUCHER_TRANSFER: TallyVoucher = {
  date: '20260501',
  voucherType: 'Contra',
  voucherNumber: 'CONT-9002',
  partyLedgerName: null,
  narration: 'Transfer to ICICI from HDFC',
  reference: null,
  alterId: 507,
  ledgerEntries: [
    { ledgerName: 'ICICI Bank Savings A/c', amount: 50000, isDeemedPositive: true, isDebit: true, billCreditPeriodDays: null, billAllocations: [] },
    { ledgerName: 'HDFC Bank Current A/c', amount: -50000, isDeemedPositive: false, isDebit: false, billCreditPeriodDays: null, billAllocations: [] },
  ],
  inventoryEntries: [],
  partyGstin: null,
  placeOfSupply: null,
  partyGstRegistrationType: null,
  gstRegistration: null,
 currencyCode: null, exchangeRate: null };

export const SAMPLE_RECEIPT_VOUCHERS: TallyVoucher[] = [SAMPLE_RECEIPT_VOUCHER];
// VendorPaymentMapper/ExpenseMapper both receive this SAME raw array and
// self-filter by party classification — see their own class doc comments.
export const SAMPLE_PAYMENT_VOUCHERS: TallyVoucher[] = [
  SAMPLE_PAYMENT_VOUCHER_VENDOR,
  SAMPLE_PAYMENT_VOUCHER_EXPENSE,
];
export const SAMPLE_DEBIT_NOTE_VOUCHERS: TallyVoucher[] = [SAMPLE_DEBIT_NOTE_VOUCHER];
export const SAMPLE_JOURNAL_VOUCHERS: TallyVoucher[] = [SAMPLE_JOURNAL_VOUCHER];
// DepositMapper/BankTransferMapper both receive this SAME raw array and
// self-filter by ledger-group classification.
export const SAMPLE_CONTRA_VOUCHERS: TallyVoucher[] = [
  SAMPLE_CONTRA_VOUCHER_DEPOSIT,
  SAMPLE_CONTRA_VOUCHER_TRANSFER,
];
