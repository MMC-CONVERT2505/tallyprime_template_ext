import { CostCentreMapper } from './cost-centre.mapper';

describe('CostCentreMapper', () => {
  const mapper = new CostCentreMapper();

  it('maps each Tally Cost Centre to a Reporting Tag row with a constant Tag Name', () => {
    const rows = mapper.toReportingTagRows([
      { name: 'Mumbai Branch', parent: 'Primary Cost Centre', alterId: 1 },
      { name: 'Delhi Branch', parent: 'Primary Cost Centre', alterId: 2 },
    ]);

    expect(rows).toEqual([
      { 'Tag Name': 'Cost Centre', Options: 'Mumbai Branch' },
      { 'Tag Name': 'Cost Centre', Options: 'Delhi Branch' },
    ]);
  });

  it('returns an empty array for no cost centres', () => {
    expect(mapper.toReportingTagRows([])).toEqual([]);
  });
});
