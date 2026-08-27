/**
 * Departments and offices.
 *
 * ── The office rows are SYNTHETIC ──────────────────────────────────────────
 *
 * They carry `verification: 'synthetic'`, no street address, and no phone
 * number. That is deliberate. An office finder is only useful if it is right,
 * and a plausible-looking address for "NADRA Mega Centre, Karachi" that nobody
 * verified is worse than no address at all — a citizen would travel to it.
 *
 * What these rows DO provide is the structure: city and province, the
 * service-to-office mapping, and a link to the official locator. The UI shows
 * the synthetic badge and points at NADRA's own locator for the actual address,
 * which is honest and still useful.
 *
 * TODO(source): replace with real rows from
 * https://www.nadra.gov.pk/nadra-office-locations/ and the provincial district
 * office directories, then promote to 'unverified' (or 'verified' after a
 * human check).
 */
import type { SeedDepartment, SeedOffice } from './types';

export const DEPARTMENTS: SeedDepartment[] = [
  {
    code: 'nadra',
    nameEn: 'National Database and Registration Authority',
    nameUr: 'نادرا',
    shortName: 'NADRA',
    jurisdiction: 'federal',
    website: 'https://www.nadra.gov.pk/',
    sourceCode: 'nadra-cnic-overview',
  },
  {
    code: 'dgip',
    nameEn: 'Directorate General of Immigration & Passports',
    nameUr: 'ڈائریکٹوریٹ جنرل آف امیگریشن اینڈ پاسپورٹس',
    shortName: 'DGI&P',
    jurisdiction: 'federal',
    website: 'https://dgip.gov.pk/',
    sourceCode: 'dgip-passport-overview',
  },
  {
    code: 'district-admin',
    nameEn: 'District Administration (Deputy Commissioner offices)',
    nameUr: 'ضلعی انتظامیہ',
    shortName: 'DC Office',
    jurisdiction: 'district',
    website: null as unknown as string,
    sourceCode: 'domicile-provincial',
  },
];

/**
 * Synthetic office rows, one per major city per department.
 *
 * `addressEn` and `phone` are null on purpose — see the note above. The
 * appointment/locator URL is real, so the citizen always has a route to the
 * genuine address.
 */
export const OFFICES: SeedOffice[] = [
  // ── NADRA ───────────────────────────────────────────────────────────────
  {
    code: 'nadra-karachi',
    departmentCode: 'nadra',
    name: { en: 'NADRA Registration Centre — Karachi', ur: 'نادرا رجسٹریشن سینٹر — کراچی', roman_ur: 'NADRA Registration Centre — Karachi' },
    officeType: 'registration_centre',
    addressEn: null,
    city: 'Karachi',
    district: 'Karachi',
    province: 'Sindh',
    phone: null,
    hoursEn: null,
    appointmentUrl: 'https://www.nadra.gov.pk/nadra-office-locations/',
    serviceCodes: ['cnic'],
    sourceCode: 'nadra-centres',
    verification: 'synthetic',
  },
  {
    code: 'nadra-lahore',
    departmentCode: 'nadra',
    name: { en: 'NADRA Registration Centre — Lahore', ur: 'نادرا رجسٹریشن سینٹر — لاہور', roman_ur: 'NADRA Registration Centre — Lahore' },
    officeType: 'registration_centre',
    addressEn: null,
    city: 'Lahore',
    district: 'Lahore',
    province: 'Punjab',
    phone: null,
    hoursEn: null,
    appointmentUrl: 'https://www.nadra.gov.pk/nadra-office-locations/',
    serviceCodes: ['cnic'],
    sourceCode: 'nadra-centres',
    verification: 'synthetic',
  },
  {
    code: 'nadra-islamabad',
    departmentCode: 'nadra',
    name: { en: 'NADRA Registration Centre — Islamabad', ur: 'نادرا رجسٹریشن سینٹر — اسلام آباد', roman_ur: 'NADRA Registration Centre — Islamabad' },
    officeType: 'registration_centre',
    addressEn: null,
    city: 'Islamabad',
    district: 'Islamabad',
    province: 'Islamabad Capital Territory',
    phone: null,
    hoursEn: null,
    appointmentUrl: 'https://www.nadra.gov.pk/nadra-office-locations/',
    serviceCodes: ['cnic'],
    sourceCode: 'nadra-centres',
    verification: 'synthetic',
  },
  {
    code: 'nadra-peshawar',
    departmentCode: 'nadra',
    name: { en: 'NADRA Registration Centre — Peshawar', ur: 'نادرا رجسٹریشن سینٹر — پشاور', roman_ur: 'NADRA Registration Centre — Peshawar' },
    officeType: 'registration_centre',
    addressEn: null,
    city: 'Peshawar',
    district: 'Peshawar',
    province: 'Khyber Pakhtunkhwa',
    phone: null,
    hoursEn: null,
    appointmentUrl: 'https://www.nadra.gov.pk/nadra-office-locations/',
    serviceCodes: ['cnic'],
    sourceCode: 'nadra-centres',
    verification: 'synthetic',
  },
  {
    code: 'nadra-quetta',
    departmentCode: 'nadra',
    name: { en: 'NADRA Registration Centre — Quetta', ur: 'نادرا رجسٹریشن سینٹر — کوئٹہ', roman_ur: 'NADRA Registration Centre — Quetta' },
    officeType: 'registration_centre',
    addressEn: null,
    city: 'Quetta',
    district: 'Quetta',
    province: 'Balochistan',
    phone: null,
    hoursEn: null,
    appointmentUrl: 'https://www.nadra.gov.pk/nadra-office-locations/',
    serviceCodes: ['cnic'],
    sourceCode: 'nadra-centres',
    verification: 'synthetic',
  },

  // ── Passport ────────────────────────────────────────────────────────────
  {
    code: 'passport-karachi',
    departmentCode: 'dgip',
    name: { en: 'Regional Passport Office — Karachi', ur: 'ریجنل پاسپورٹ آفس — کراچی', roman_ur: 'Regional Passport Office — Karachi' },
    officeType: 'passport_office',
    addressEn: null,
    city: 'Karachi',
    district: 'Karachi',
    province: 'Sindh',
    phone: null,
    hoursEn: null,
    appointmentUrl: 'https://onlinemrp.dgip.gov.pk/',
    serviceCodes: ['passport'],
    sourceCode: 'dgip-passport-overview',
    verification: 'synthetic',
  },
  {
    code: 'passport-lahore',
    departmentCode: 'dgip',
    name: { en: 'Regional Passport Office — Lahore', ur: 'ریجنل پاسپورٹ آفس — لاہور', roman_ur: 'Regional Passport Office — Lahore' },
    officeType: 'passport_office',
    addressEn: null,
    city: 'Lahore',
    district: 'Lahore',
    province: 'Punjab',
    phone: null,
    hoursEn: null,
    appointmentUrl: 'https://onlinemrp.dgip.gov.pk/',
    serviceCodes: ['passport'],
    sourceCode: 'dgip-passport-overview',
    verification: 'synthetic',
  },
  {
    code: 'passport-islamabad',
    departmentCode: 'dgip',
    name: { en: 'Regional Passport Office — Islamabad', ur: 'ریجنل پاسپورٹ آفس — اسلام آباد', roman_ur: 'Regional Passport Office — Islamabad' },
    officeType: 'passport_office',
    addressEn: null,
    city: 'Islamabad',
    district: 'Islamabad',
    province: 'Islamabad Capital Territory',
    phone: null,
    hoursEn: null,
    appointmentUrl: 'https://onlinemrp.dgip.gov.pk/',
    serviceCodes: ['passport'],
    sourceCode: 'dgip-passport-overview',
    verification: 'synthetic',
  },

  // ── District administration (domicile) ──────────────────────────────────
  {
    code: 'dc-karachi-south',
    departmentCode: 'district-admin',
    name: { en: 'Deputy Commissioner Office — Karachi South', ur: 'ڈپٹی کمشنر آفس — کراچی جنوبی', roman_ur: 'Deputy Commissioner Office — Karachi South' },
    officeType: 'district_office',
    addressEn: null,
    city: 'Karachi',
    district: 'Karachi South',
    province: 'Sindh',
    phone: null,
    hoursEn: null,
    appointmentUrl: null,
    serviceCodes: ['domicile'],
    sourceCode: 'sindh-domicile',
    verification: 'synthetic',
  },
  {
    code: 'dc-lahore',
    departmentCode: 'district-admin',
    name: { en: 'Deputy Commissioner Office — Lahore', ur: 'ڈپٹی کمشنر آفس — لاہور', roman_ur: 'Deputy Commissioner Office — Lahore' },
    officeType: 'district_office',
    addressEn: null,
    city: 'Lahore',
    district: 'Lahore',
    province: 'Punjab',
    phone: null,
    hoursEn: null,
    appointmentUrl: null,
    serviceCodes: ['domicile'],
    sourceCode: 'punjab-domicile',
    verification: 'synthetic',
  },
  {
    code: 'dc-islamabad',
    departmentCode: 'district-admin',
    name: { en: 'Deputy Commissioner Office — Islamabad', ur: 'ڈپٹی کمشنر آفس — اسلام آباد', roman_ur: 'Deputy Commissioner Office — Islamabad' },
    officeType: 'district_office',
    addressEn: null,
    city: 'Islamabad',
    district: 'Islamabad',
    province: 'Islamabad Capital Territory',
    phone: null,
    hoursEn: null,
    appointmentUrl: null,
    serviceCodes: ['domicile'],
    sourceCode: 'domicile-provincial',
    verification: 'synthetic',
  },
];
