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
    { stockItemName: 'Widget A', quantity: 10, rate: 250, amount: 2500 },
    { stockItemName: 'Widget B', quantity: 5, rate: 400, amount: 2000 },
  ],
  partyGstin: '27AABCU9603R1ZM',
  placeOfSupply: 'Maharashtra',
};

export const SAMPLE_SALES_VOUCHER_2: TallyVoucher = {
  date: '20260408',
  voucherType: 'Sales',
  voucherNumber: 'INV-1003',
  partyLedgerName: 'Priya Distributors',
  narration: 'Sale of finished goods',
  reference: null,
  alterId: 405,
  ledgerEntries: [],
  inventoryEntries: [{ stockItemName: 'Widget B', quantity: 20, rate: 380, amount: 7600 }],
  partyGstin: '19AACPD1122K1ZQ',
  placeOfSupply: 'West Bengal',
};

/** A ledger-only Sales voucher (services, no stock line) — must NOT produce
 *  a phantom Invoice row (invoice.mapper.ts skips vouchers with zero
 *  inventory entries by design). */
export const SAMPLE_LEDGER_ONLY_SALES_VOUCHER: TallyVoucher = {
  ...SAMPLE_SALES_VOUCHER,
  voucherNumber: 'INV-1002',
  inventoryEntries: [],
};

export const SAMPLE_PURCHASE_VOUCHER: TallyVoucher = {
  date: '20260410',
  voucherType: 'Purchase',
  voucherNumber: 'PUR-2001',
  partyLedgerName: 'Global Supplies Pvt Ltd',
  narration: 'Purchase of raw material',
  reference: 'PO-55',
  alterId: 402,
  ledgerEntries: [],
  inventoryEntries: [{ stockItemName: 'Raw Material X', quantity: 200, rate: 100, amount: 20000 }],
  partyGstin: '29AAACG1234F1Z5',
  placeOfSupply: 'Karnataka',
};

export const SAMPLE_CREDIT_NOTE_VOUCHER: TallyVoucher = {
  date: '20260415',
  voucherType: 'Credit Note',
  voucherNumber: 'CN-3001',
  partyLedgerName: 'Rohan Traders',
  narration: 'Sales return - damaged widget',
  reference: null,
  alterId: 403,
  ledgerEntries: [],
  inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 250, amount: 250 }],
  partyGstin: '27AABCU9603R1ZM',
  placeOfSupply: 'Maharashtra',
};

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
    { stockItemName: 'Widget A', quantity: -2, rate: 250, amount: -500 },
    { stockItemName: 'Raw Material X', quantity: 10, rate: 100, amount: 1000 },
  ],
  partyGstin: null,
  placeOfSupply: null,
};

export const SAMPLE_INVOICE_VOUCHERS: TallyVoucher[] = [
  SAMPLE_SALES_VOUCHER,
  SAMPLE_LEDGER_ONLY_SALES_VOUCHER,
  SAMPLE_SALES_VOUCHER_2,
];
export const SAMPLE_BILL_VOUCHERS: TallyVoucher[] = [SAMPLE_PURCHASE_VOUCHER];
export const SAMPLE_CREDIT_NOTE_VOUCHERS: TallyVoucher[] = [SAMPLE_CREDIT_NOTE_VOUCHER];
export const SAMPLE_STOCK_JOURNAL_VOUCHERS: TallyVoucher[] = [SAMPLE_STOCK_JOURNAL_VOUCHER];
