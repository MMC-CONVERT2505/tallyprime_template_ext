import { TallyCostCentre } from '../tally/interfaces/tally.interfaces';

/**
 * Zoho Books "Reporting Tag" import columns — taken from the real template
 * (Master and Invoice or Bill/Class.xlsx, sheet "Sheet1"): one row per Tally
 * Cost Centre, with the tag name always literally "Cost Centre" (confirmed
 * against the template's own demo rows, e.g. "Cost Centre" | "Test1").
 */
export interface ZohoReportingTagRow {
  'Tag Name': string;
  Options: string;
}

const ZOHO_TAG_NAME = 'Cost Centre';

export class CostCentreMapper {
  toReportingTagRows(costCentres: TallyCostCentre[]): ZohoReportingTagRow[] {
    return costCentres.map((c) => ({
      'Tag Name': ZOHO_TAG_NAME,
      Options: c.name,
    }));
  }
}
