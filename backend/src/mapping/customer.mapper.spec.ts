import { CustomerMapper } from './customer.mapper';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';

describe('CustomerMapper', () => {
  const hierarchy = new GroupHierarchyResolver([]);
  const mapper = new CustomerMapper(hierarchy);

  const baseLedger = {
    name: 'ABC Traders',
    parent: 'Sundry Debtors',
    description: null,
    openingBalance: null,
    closingBalance: null,
    alterId: 1,
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
  };

  it('includes only ledgers resolving to Sundry Debtors', () => {
    const rows = mapper.toCustomerRows([
      baseLedger,
      { ...baseLedger, name: 'XYZ Supplies', parent: 'Sundry Creditors' },
      { ...baseLedger, name: 'Cash', parent: 'Cash-in-Hand' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Display Name']).toBe('ABC Traders');
  });

  it('maps GSTIN/PAN/contact/address fields straight through and derives GST Treatment from GSTIN presence', () => {
    const [row] = mapper.toCustomerRows([
      {
        ...baseLedger,
        gstin: '33AAAAA1111A1Z1',
        panNumber: 'AAAAA1111A',
        email: 'ap@abctraders.com',
        phone: '044-12345678',
        mobile: '9876543210',
        billingAddress: '50 Kovil Street\nAnna Nagar',
        billingState: 'Tamil Nadu',
        billingCountry: 'India',
        billingPincode: '600040',
      },
    ]);

    expect(row['GST Identification Number (GSTIN)']).toBe('33AAAAA1111A1Z1');
    expect(row['GST Treatment']).toBe('business_gst');
    expect(row['PAN Number']).toBe('AAAAA1111A');
    expect(row.EmailID).toBe('ap@abctraders.com');
    expect(row.Phone).toBe('044-12345678');
    expect(row.MobilePhone).toBe('9876543210');
    // Tally's multi-line ADDRESS.LIST splits across two Zoho columns instead
    // of cramming everything into one — see splitBillingAddress's doc
    // comment.
    expect(row['Billing Address']).toBe('50 Kovil Street');
    expect(row['Billing Street2']).toBe('Anna Nagar');
    expect(row['Billing State']).toBe('Tamil Nadu');
    expect(row['Billing Country']).toBe('India');
    expect(row['Billing Code']).toBe('600040');
  });

  it('maps ledger.description onto Notes — Customer.xlsx has no Description column of its own', () => {
    const [row] = mapper.toCustomerRows([
      { ...baseLedger, description: 'Key retail account, net-30 terms' },
    ]);
    expect(row.Notes).toBe('Key retail account, net-30 terms');
  });

  it('leaves Billing Street2 blank for a single-line address rather than fabricating a split', () => {
    const [row] = mapper.toCustomerRows([{ ...baseLedger, billingAddress: '50 Kovil Street' }]);
    expect(row['Billing Address']).toBe('50 Kovil Street');
    expect(row['Billing Street2']).toBe('');
  });

  it('falls back to GST Treatment "consumer" when there is no GSTIN', () => {
    const [row] = mapper.toCustomerRows([baseLedger]);
    expect(row['GST Treatment']).toBe('consumer');
  });

  it('takes the Opening Balance magnitude regardless of Tally Dr/Cr sign, with no separate Dr/Cr column', () => {
    const [row] = mapper.toCustomerRows([{ ...baseLedger, openingBalance: -1500 }]);
    expect(row['Opening Balance']).toBe(1500);
    expect(row).not.toHaveProperty('Debit or Credit');
  });

  it('leaves Opening Balance blank rather than 0 when Tally has no balance at all', () => {
    const [row] = mapper.toCustomerRows([baseLedger]);
    expect(row['Opening Balance']).toBe('');
  });
});
