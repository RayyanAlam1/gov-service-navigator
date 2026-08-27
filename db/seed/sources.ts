/**
 * Sources.
 *
 * The URLs here are real, official, and checkable — that is the point. What is
 * NOT claimed is that a human has opened each one and confirmed that the
 * specific fees, timelines and document lists in this seed match what the page
 * currently says. That is why every entry is `unverified` with
 * `lastVerified: null`.
 *
 * `npm run ingest -- --source <code>` fetches a source and replaces the
 * placeholder corpus with its real text. `npm run verify:sources` (see
 * docs/DATA_PROVENANCE.md) is the human checklist for promoting rows to
 * 'verified'.
 *
 * TODO(source): every entry below needs a human pass against the live page
 * before this is used for anything a citizen acts on.
 */
import type { SeedSource } from './types';

export const SOURCES: SeedSource[] = [
  {
    code: 'nadra-cnic-overview',
    title: 'NADRA — Computerised National Identity Card (CNIC)',
    publisher: 'National Database and Registration Authority',
    url: 'https://www.nadra.gov.pk/identity/',
    docType: 'web',
    language: 'en',
    lastVerified: null,
    verification: 'unverified',
    notes:
      'Official landing page for identity products. TODO(source): confirm the current CNIC ' +
      'categories, document lists and fee schedule against this page and its sub-pages.',
  },
  {
    code: 'nadra-fees',
    title: 'NADRA — Identity document fee schedule',
    publisher: 'National Database and Registration Authority',
    url: 'https://www.nadra.gov.pk/identity/',
    docType: 'web',
    language: 'en',
    lastVerified: null,
    verification: 'unverified',
    notes:
      'Fee amounts in this seed are deliberately NULL. TODO(source): populate amount_minor ' +
      'only from the published fee schedule, with the retrieval date recorded.',
  },
  {
    code: 'nadra-centres',
    title: 'NADRA — Registration centre locator',
    publisher: 'National Database and Registration Authority',
    url: 'https://www.nadra.gov.pk/nadra-office-locations/',
    docType: 'web',
    language: 'en',
    lastVerified: null,
    verification: 'unverified',
    notes: 'TODO(source): office rows in this seed are synthetic placeholders; replace from the locator.',
  },
  {
    code: 'dgip-passport-overview',
    title: 'Directorate General of Immigration & Passports — Passport services',
    publisher: 'Directorate General of Immigration & Passports, Government of Pakistan',
    url: 'https://dgip.gov.pk/',
    docType: 'web',
    language: 'en',
    lastVerified: null,
    verification: 'unverified',
    notes:
      'Official portal for passport services. TODO(source): confirm categories, the online ' +
      'application route and the current document list.',
  },
  {
    code: 'dgip-online-application',
    title: 'DGI&P — Online passport application portal',
    publisher: 'Directorate General of Immigration & Passports, Government of Pakistan',
    url: 'https://onlinemrp.dgip.gov.pk/',
    docType: 'web',
    language: 'en',
    lastVerified: null,
    verification: 'unverified',
    notes:
      'The official online route. This is the URL the app sends citizens to rather than ' +
      'implying it can submit on their behalf. TODO(source): confirm the portal is live and ' +
      'which categories it accepts.',
  },
  {
    code: 'dgip-fees',
    title: 'DGI&P — Passport fee schedule',
    publisher: 'Directorate General of Immigration & Passports, Government of Pakistan',
    url: 'https://dgip.gov.pk/',
    docType: 'web',
    language: 'en',
    lastVerified: null,
    verification: 'unverified',
    notes: 'Fee amounts deliberately NULL. TODO(source): populate from the published schedule only.',
  },
  {
    code: 'domicile-provincial',
    title: 'Domicile certificate — provincial procedure',
    publisher: 'Provincial Home Departments / Deputy Commissioner offices',
    url: null,
    docType: 'web',
    language: 'en',
    lastVerified: null,
    verification: 'unverified',
    notes:
      'Domicile is issued by the district administration, so the authoritative source varies ' +
      'by province and district. TODO(source): add one source row per province with its own ' +
      'official URL, and scope the requirement rows to it.',
  },
  {
    code: 'sindh-domicile',
    title: 'Government of Sindh — citizen services portal',
    publisher: 'Government of Sindh',
    url: 'https://www.sindh.gov.pk/',
    docType: 'web',
    language: 'en',
    lastVerified: null,
    verification: 'unverified',
    notes: 'TODO(source): locate the current domicile procedure page for Sindh districts.',
  },
  {
    code: 'punjab-domicile',
    title: 'Government of Punjab — citizen services',
    publisher: 'Government of the Punjab',
    url: 'https://www.punjab.gov.pk/',
    docType: 'web',
    language: 'en',
    lastVerified: null,
    verification: 'unverified',
    notes: 'TODO(source): locate the current domicile procedure page for Punjab districts.',
  },
  {
    code: 'demo-corpus',
    title: 'Demonstration corpus — structural placeholder text',
    publisher: 'Government Service AI Navigator (synthetic)',
    url: null,
    docType: 'synthetic',
    language: 'en',
    lastVerified: null,
    verification: 'synthetic',
    notes:
      'Written for this repository to exercise the retrieval pipeline end to end. It describes ' +
      'the SHAPE of each procedure and states explicitly that specific values are not official. ' +
      'Everything retrieved from it renders with a synthetic badge. Replace with real ingested ' +
      'text via `npm run ingest` before any real-world use.',
  },
];
