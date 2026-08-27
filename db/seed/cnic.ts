/**
 * CNIC — Computerised National Identity Card (NADRA).
 *
 * The flagship service. The lost-CNIC path is the demo scenario, so it is the
 * most fully modelled: FIR handling, address mismatch, and the case where the
 * citizen has no prior record to link to.
 *
 * PROVENANCE: every fee is `amountMinor: null` and every processing time is
 * `null`. Those are not oversights — no one on this project has confirmed a
 * current NADRA fee against the published schedule, and a plausible number
 * here would render as an authoritative claim. They display as "not verified —
 * confirm at the counter", which is both safe and true.
 *
 * Document names and procedure shapes are marked `unverified` and attributed
 * to the real NADRA pages. TODO(source): a human pass against
 * https://www.nadra.gov.pk/identity/ promotes these to 'verified'.
 */
import type { SeedService } from './types';

export const CNIC_SERVICE: SeedService = {
  code: 'cnic',
  departmentCode: 'nadra',
  name: {
    en: 'National Identity Card (CNIC)',
    ur: 'قومی شناختی کارڈ',
    roman_ur: 'Qaumi Shanakhti Card (CNIC)',
  },
  summary: {
    en: 'The national identity card issued by NADRA to Pakistani citizens aged 18 and above.',
    ur: 'نادرا کی جانب سے اٹھارہ سال سے زائد عمر کے پاکستانی شہریوں کو جاری کیا جانے والا قومی شناختی کارڈ۔',
    roman_ur: 'NADRA ki taraf se 18 saal se zyada umar ke Pakistani shehriyon ko jari kiya jane wala qaumi shanakhti card.',
  },
  category: 'identity',
  officialUrl: 'https://www.nadra.gov.pk/identity/',
  // No official self-service online route for a first CNIC. Do not invent one.
  onlineApplicationUrl: null,
  displayOrder: 10,
  sourceCode: 'nadra-cnic-overview',
  verification: 'unverified',

  aliases: [
    { alias: 'cnic', language: 'en', weight: 3 },
    { alias: 'nic', language: 'en', weight: 2 },
    { alias: 'identity card', language: 'en', weight: 3 },
    { alias: 'national identity card', language: 'en', weight: 3 },
    { alias: 'id card', language: 'en', weight: 2.5 },
    { alias: 'nadra card', language: 'en', weight: 2.5 },
    { alias: 'شناختی کارڈ', language: 'ur', weight: 3 },
    { alias: 'قومی شناختی کارڈ', language: 'ur', weight: 3 },
    { alias: 'shanakhti card', language: 'roman_ur', weight: 3 },
    { alias: 'shanakhati card', language: 'roman_ur', weight: 3 },
    { alias: 'shanakhti', language: 'roman_ur', weight: 2 },
    // Scenario-bearing aliases: these also hint at the branch.
    { alias: 'cnic gum', language: 'roman_ur', weight: 3, scenario: 'lost' },
    { alias: 'shanakhti card gum', language: 'roman_ur', weight: 3, scenario: 'lost' },
    { alias: 'lost cnic', language: 'en', weight: 3, scenario: 'lost' },
    { alias: 'cnic renewal', language: 'en', weight: 3, scenario: 'renewal' },
    { alias: 'cnic renew', language: 'en', weight: 3, scenario: 'renewal' },
  ],

  scenarios: [
    {
      code: 'lost',
      name: { en: 'Lost or stolen card', ur: 'گم شدہ یا چوری شدہ کارڈ', roman_ur: 'Gum ya chori shuda card' },
      descriptionEn: 'Replacing a CNIC that has been lost or stolen.',
      selector: { op: 'in', var: 'application_type', value: ['lost'] },
      priority: 10,
      isExceptionPath: true,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'damaged',
      name: { en: 'Damaged card', ur: 'خراب شدہ کارڈ', roman_ur: 'Kharab shuda card' },
      descriptionEn: 'Replacing a CNIC that is physically damaged but still in your possession.',
      selector: { op: 'eq', var: 'application_type', value: 'damaged' },
      priority: 20,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'renewal',
      name: { en: 'Renewal', ur: 'تجدید', roman_ur: 'Tajdeed' },
      descriptionEn: 'Renewing a CNIC that has expired or is close to expiry.',
      selector: { op: 'eq', var: 'application_type', value: 'renewal' },
      priority: 30,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'modification',
      name: { en: 'Correction or change of particulars', ur: 'کوائف کی درستی یا تبدیلی', roman_ur: 'Kawaif ki durusti ya tabdeeli' },
      descriptionEn: 'Correcting or changing details recorded on an existing CNIC.',
      selector: { op: 'eq', var: 'application_type', value: 'modification' },
      priority: 40,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'new',
      name: { en: 'First-time application', ur: 'پہلی بار درخواست', roman_ur: 'Pehli baar darkhast' },
      descriptionEn: 'Applying for a CNIC for the first time.',
      selector: { op: 'eq', var: 'application_type', value: 'new' },
      priority: 50,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
  ],

  rules: [
    {
      code: 'age_minimum',
      statement: {
        en: 'A CNIC is issued to citizens aged 18 and above.',
        ur: 'شناختی کارڈ اٹھارہ سال یا اس سے زائد عمر کے شہریوں کو جاری ہوتا ہے۔',
        roman_ur: 'Shanakhti card 18 saal ya us se zyada umar ke shehriyon ko jari hota hai.',
      },
      // Fires when the applicant is under 18 — i.e. the blocking case.
      condition: { op: 'lt', var: 'applicant_age', value: 18 },
      outcome: 'ineligible',
      failureMessageEn: 'A CNIC is issued from age 18. Under 18, the equivalent record is a B-Form / Child Registration Certificate.',
      remedyEn: 'Apply for a B-Form (Child Registration Certificate) at a NADRA centre instead.',
      severity: 'blocking',
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'lost_requires_report',
      scenario: 'lost',
      statement: {
        en: 'Replacement of a lost card requires the loss to have been reported.',
        ur: 'گم شدہ کارڈ کے متبادل کے لیے گمشدگی کی اطلاع دینا ضروری ہے۔',
        roman_ur: 'Gum shuda card ke replacement ke liye gumshudgi ki report zaroori hai.',
      },
      condition: { op: 'falsy', var: 'has_fir' },
      outcome: 'route_exception',
      failureMessageEn: 'You have not yet reported the loss to the police.',
      remedyEn: 'Report the loss at your nearest police station and obtain the report before applying.',
      severity: 'blocking',
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'first_time_needs_lineage',
      scenario: 'new',
      statement: {
        en: 'A first-time application must be linked to a parent or guardian record.',
        ur: 'پہلی بار درخواست کو والدین یا سرپرست کے ریکارڈ سے منسلک کرنا ضروری ہے۔',
        roman_ur: 'Pehli baar darkhast ko walidain ya guardian ke record se link karna zaroori hai.',
      },
      condition: {
        op: 'and',
        children: [
          { op: 'falsy', var: 'has_parent_cnic' },
          { op: 'falsy', var: 'parents_deceased' },
        ],
      },
      outcome: 'route_exception',
      failureMessageEn: 'A first CNIC normally requires a parent’s or guardian’s CNIC to establish family linkage.',
      remedyEn: 'Bring a parent’s or guardian’s CNIC. If that is not possible, the centre can advise on the alternative verification route.',
      severity: 'blocking',
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'overseas_route',
      statement: {
        en: 'Applicants outside Pakistan are served through a different identity product and office.',
        ur: 'پاکستان سے باہر مقیم درخواست گزاروں کے لیے مختلف دستاویز اور دفتر ہے۔',
        roman_ur: 'Pakistan se bahar rehne walon ke liye alag document aur daftar hai.',
      },
      condition: { op: 'truthy', var: 'is_overseas' },
      outcome: 'conditional',
      failureMessageEn: 'You are outside Pakistan.',
      remedyEn: 'Overseas Pakistanis are generally issued a NICOP rather than a CNIC. Check the NADRA overseas page or your nearest mission.',
      severity: 'advisory',
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
  ],

  requirements: [
    {
      code: 'birth_record',
      scenario: 'new',
      documentType: 'b_form',
      title: {
        en: 'B-Form or Child Registration Certificate (CRC)',
        ur: 'ب-فارم یا چائلڈ رجسٹریشن سرٹیفکیٹ',
        roman_ur: 'B-Form ya Child Registration Certificate (CRC)',
      },
      descriptionEn: 'The childhood registration record that establishes your identity before a CNIC exists.',
      isMandatory: true,
      appliesWhen: { op: 'eq', var: 'application_type', value: 'new' },
      mustBeOriginal: true,
      obtainFrom: 'NADRA registration centre or the union council where the birth was registered',
      displayOrder: 10,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'parent_cnic',
      scenario: 'new',
      documentType: 'parent_cnic',
      title: {
        en: 'Parent’s or guardian’s CNIC',
        ur: 'والدین یا سرپرست کا شناختی کارڈ',
        roman_ur: 'Walidain ya guardian ka CNIC',
      },
      descriptionEn: 'Used to establish family linkage on a first-time application.',
      isMandatory: true,
      appliesWhen: {
        op: 'and',
        children: [
          { op: 'eq', var: 'application_type', value: 'new' },
          { op: 'falsy', var: 'parents_deceased' },
        ],
      },
      substitutes: ['guardianship_proof'],
      mustBeOriginal: true,
      displayOrder: 20,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'guardianship_proof',
      scenario: 'new',
      documentType: 'guardianship',
      title: {
        en: 'Guardianship or succession document',
        ur: 'سرپرستی یا وراثت کی دستاویز',
        roman_ur: 'Guardianship ya wirasat ki dastavez',
      },
      descriptionEn: 'Accepted in place of a parent’s CNIC where parents are deceased or their records are unavailable.',
      isMandatory: false,
      appliesWhen: {
        op: 'and',
        children: [
          { op: 'eq', var: 'application_type', value: 'new' },
          { op: 'truthy', var: 'parents_deceased' },
        ],
      },
      obtainFrom: 'District court or the relevant local authority',
      displayOrder: 25,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'police_report',
      scenario: 'lost',
      documentType: 'police_report',
      title: {
        en: 'Police report / FIR for the lost card',
        ur: 'گم شدہ کارڈ کی پولیس رپورٹ / ایف آئی آر',
        roman_ur: 'Gum shuda card ki police report / FIR',
      },
      descriptionEn: 'Proof that the loss or theft was formally reported.',
      isMandatory: true,
      appliesWhen: { op: 'eq', var: 'application_type', value: 'lost' },
      mustBeOriginal: false,
      copiesRequired: 1,
      obtainFrom: 'The police station covering the area where the card was lost',
      displayOrder: 10,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'old_card',
      documentType: 'previous_cnic',
      title: {
        en: 'Your previous CNIC',
        ur: 'آپ کا پرانا شناختی کارڈ',
        roman_ur: 'Aap ka purana CNIC',
      },
      descriptionEn: 'The existing card, even if expired or damaged.',
      isMandatory: true,
      appliesWhen: { op: 'in', var: 'application_type', value: ['renewal', 'damaged', 'modification'] },
      mustBeOriginal: true,
      displayOrder: 10,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'proof_of_address',
      documentType: 'address_proof',
      title: {
        en: 'Proof of your current address',
        ur: 'موجودہ پتے کا ثبوت',
        roman_ur: 'Mojooda patay ka saboot',
      },
      descriptionEn: 'Required when your current address differs from the one on record — for example a utility bill or tenancy document.',
      isMandatory: true,
      appliesWhen: { op: 'falsy', var: 'address_matches_cnic' },
      copiesRequired: 1,
      displayOrder: 40,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'supporting_evidence',
      scenario: 'modification',
      documentType: 'supporting_evidence',
      title: {
        en: 'Evidence supporting the correction',
        ur: 'درستی کی تائید کرنے والی دستاویز',
        roman_ur: 'Durusti ki tayeed karne wali dastavez',
      },
      descriptionEn: 'Whatever document proves the corrected detail — for example a birth record for a date of birth change, or a nikah nama for a name change after marriage.',
      isMandatory: true,
      appliesWhen: { op: 'eq', var: 'application_type', value: 'modification' },
      displayOrder: 20,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
  ],

  steps: [
    {
      code: 'report_loss',
      scenario: 'lost',
      order: 5,
      title: {
        en: 'Report the loss to the police',
        ur: 'گمشدگی کی اطلاع پولیس کو دیں',
        roman_ur: 'Gumshudgi ki report police ko karwayein',
      },
      instruction: {
        en: 'Go to the police station covering the area where the card was lost and obtain a written report or FIR. Keep the original and a copy.',
        ur: 'اس علاقے کے تھانے جائیں جہاں کارڈ گم ہوا اور تحریری رپورٹ یا ایف آئی آر حاصل کریں۔ اصل اور کاپی دونوں رکھیں۔',
        roman_ur: 'Us ilaqe ke thane jayein jahan card gum hua aur tehreeri report ya FIR hasil karein. Asal aur copy dono rakhein.',
      },
      channel: 'in_person',
      appliesWhen: { op: 'eq', var: 'application_type', value: 'lost' },
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'gather_documents',
      order: 10,
      title: {
        en: 'Gather your documents',
        ur: 'اپنی دستاویزات جمع کریں',
        roman_ur: 'Apni dastavezat jama karein',
      },
      instruction: {
        en: 'Collect every document on your checklist. Take originals — centres verify against the original even when they keep a copy.',
        ur: 'اپنی فہرست کی تمام دستاویزات جمع کریں۔ اصل دستاویزات ساتھ لے جائیں۔',
        roman_ur: 'Apni list ki tamam dastavezat jama karein. Asal dastavezat sath le jayein.',
      },
      channel: 'in_person',
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'visit_centre',
      order: 20,
      title: {
        en: 'Visit a NADRA registration centre',
        ur: 'نادرا رجسٹریشن سینٹر جائیں',
        roman_ur: 'NADRA registration centre jayein',
      },
      instruction: {
        en: 'Go to a NADRA registration centre and take a token for the relevant counter. Your biometrics and photograph are captured there.',
        ur: 'نادرا رجسٹریشن سینٹر جائیں اور متعلقہ کاؤنٹر کا ٹوکن لیں۔ وہیں آپ کے بایومیٹرکس اور تصویر لی جائے گی۔',
        roman_ur: 'NADRA registration centre jayein aur mutalliqa counter ka token lein. Wahin aap ke biometrics aur tasveer li jayegi.',
      },
      channel: 'in_person',
      actionUrl: 'https://www.nadra.gov.pk/nadra-office-locations/',
      sourceCode: 'nadra-centres',
      verification: 'unverified',
    },
    {
      code: 'submit_and_pay',
      order: 30,
      title: {
        en: 'Submit the form and pay the fee',
        ur: 'فارم جمع کروائیں اور فیس ادا کریں',
        roman_ur: 'Form jama karwayein aur fees ada karein',
      },
      instruction: {
        en: 'Complete the application at the counter, pay the applicable fee, and keep the receipt — it carries your tracking number.',
        ur: 'کاؤنٹر پر درخواست مکمل کریں، فیس ادا کریں اور رسید سنبھال کر رکھیں — اس پر آپ کا ٹریکنگ نمبر ہوتا ہے۔',
        roman_ur: 'Counter par darkhast mukammal karein, fees ada karein aur receipt sambhal kar rakhein — is par aap ka tracking number hota hai.',
      },
      channel: 'in_person',
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'track_and_collect',
      order: 40,
      title: {
        en: 'Track and collect',
        ur: 'پیش رفت دیکھیں اور وصول کریں',
        roman_ur: 'Progress dekhein aur wasool karein',
      },
      instruction: {
        en: 'Use the tracking number on your receipt to follow progress, then collect the card or receive it by the delivery option you selected.',
        ur: 'رسید پر موجود ٹریکنگ نمبر سے پیش رفت دیکھیں، پھر کارڈ وصول کریں۔',
        roman_ur: 'Receipt par mojood tracking number se progress dekhein, phir card wasool karein.',
      },
      channel: 'either',
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
  ],

  // Every amount is NULL. See the provenance note at the top of this file.
  fees: [
    {
      code: 'cnic_normal',
      category: 'normal',
      label: { en: 'Standard processing fee', ur: 'عام فیس', roman_ur: 'Aam fees' },
      amountMinor: null,
      appliesWhen: { op: 'in', var: 'urgency', value: ['normal'] },
      noteEn: 'TODO(source): populate from the NADRA published fee schedule only.',
      sourceCode: 'nadra-fees',
      verification: 'unverified',
    },
    {
      code: 'cnic_urgent',
      category: 'urgent',
      label: { en: 'Urgent processing fee', ur: 'فوری فیس', roman_ur: 'Urgent fees' },
      amountMinor: null,
      appliesWhen: { op: 'in', var: 'urgency', value: ['urgent', 'executive'] },
      noteEn: 'TODO(source): populate from the NADRA published fee schedule only.',
      sourceCode: 'nadra-fees',
      verification: 'unverified',
    },
  ],

  processingTimes: [
    {
      code: 'cnic_time_normal',
      category: 'normal',
      labelEn: 'Standard processing',
      minDays: null,
      maxDays: null,
      appliesWhen: { op: 'in', var: 'urgency', value: ['normal'] },
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'cnic_time_urgent',
      category: 'urgent',
      labelEn: 'Urgent processing',
      minDays: null,
      maxDays: null,
      appliesWhen: { op: 'in', var: 'urgency', value: ['urgent', 'executive'] },
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
  ],

  exceptions: [
    {
      code: 'address_mismatch',
      name: {
        en: 'Your current address differs from your CNIC address',
        ur: 'آپ کا موجودہ پتہ شناختی کارڈ کے پتے سے مختلف ہے',
        roman_ur: 'Aap ka mojooda pata CNIC ke patay se mukhtalif hai',
      },
      trigger: { op: 'falsy', var: 'address_matches_cnic' },
      guidance: {
        en: 'Because you have moved, bring proof of your current address as well. Apply at a centre serving your current address, and expect the address on record to be updated as part of the application.',
        ur: 'چونکہ آپ منتقل ہو چکے ہیں، موجودہ پتے کا ثبوت بھی ساتھ لائیں۔ اپنے موجودہ پتے کے علاقے کے سینٹر میں درخواست دیں۔',
        roman_ur: 'Kyunke aap shift ho chuke hain, mojooda patay ka saboot bhi sath layein. Apne mojooda patay ke ilaqe ke centre mein darkhast dein.',
      },
      extraRequirementCodes: ['proof_of_address'],
      escalateToOffice: false,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'no_parental_record',
      name: {
        en: 'No parental record available',
        ur: 'والدین کا ریکارڈ دستیاب نہیں',
        roman_ur: 'Walidain ka record dastyab nahi',
      },
      trigger: {
        op: 'and',
        children: [
          { op: 'eq', var: 'application_type', value: 'new' },
          { op: 'truthy', var: 'parents_deceased' },
        ],
      },
      guidance: {
        en: 'Family linkage normally comes from a parent’s record. Where that is not possible, the centre handles it as a special case — bring whatever guardianship, succession or death documentation you have, and ask for the supervisor at the counter.',
        ur: 'خاندانی تعلق عموماً والدین کے ریکارڈ سے ثابت ہوتا ہے۔ ایسا ممکن نہ ہو تو سینٹر اسے خصوصی کیس کے طور پر دیکھتا ہے — سرپرستی، وراثت یا وفات کی دستیاب دستاویزات ساتھ لائیں۔',
        roman_ur: 'Khandani taluq aam tor par walidain ke record se sabit hota hai. Aisa mumkin na ho to centre ise special case ke tor par dekhta hai — guardianship, wirasat ya wafat ki dastyab dastavezat sath layein.',
      },
      extraRequirementCodes: ['guardianship_proof'],
      escalateToOffice: true,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
    {
      code: 'lost_without_report',
      name: {
        en: 'Loss not yet reported to the police',
        ur: 'گمشدگی کی اطلاع ابھی پولیس کو نہیں دی گئی',
        roman_ur: 'Gumshudgi ki report abhi police ko nahi karwai gayi',
      },
      trigger: {
        op: 'and',
        children: [
          { op: 'eq', var: 'application_type', value: 'lost' },
          { op: 'falsy', var: 'has_fir' },
        ],
      },
      guidance: {
        en: 'Report the loss before you go to NADRA. Going first to the registration centre without a police report usually means a second trip.',
        ur: 'نادرا جانے سے پہلے گمشدگی کی اطلاع دیں۔ پولیس رپورٹ کے بغیر جانے کا مطلب عموماً دوبارہ چکر لگانا ہوتا ہے۔',
        roman_ur: 'NADRA jane se pehle gumshudgi ki report karwayein. Police report ke baghair jane ka matlab aam tor par dobara chakkar lagana hota hai.',
      },
      extraRequirementCodes: ['police_report'],
      extraStepCodes: ['report_loss'],
      escalateToOffice: false,
      sourceCode: 'nadra-cnic-overview',
      verification: 'unverified',
    },
  ],
};
