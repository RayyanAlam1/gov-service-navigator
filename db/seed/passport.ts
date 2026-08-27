/**
 * Passport (Directorate General of Immigration & Passports).
 *
 * The one service in the MVP with a real official online route, which makes it
 * the demonstration of the "official application routing" principle: where the
 * government has a portal, the app sends the citizen to it rather than
 * implying it can apply on their behalf.
 *
 * PROVENANCE: fees and processing times are NULL. Passport fees vary by
 * booklet size, validity period and urgency category, and guessing any of them
 * would be a fabricated claim on a page a citizen acts on.
 * TODO(source): confirm against https://dgip.gov.pk/ before promoting.
 */
import type { SeedService } from './types';

export const PASSPORT_SERVICE: SeedService = {
  code: 'passport',
  departmentCode: 'dgip',
  name: {
    en: 'Pakistani Passport',
    ur: 'پاکستانی پاسپورٹ',
    roman_ur: 'Pakistani Passport',
  },
  summary: {
    en: 'The machine-readable travel document issued by the Directorate General of Immigration & Passports.',
    ur: 'ڈائریکٹوریٹ جنرل آف امیگریشن اینڈ پاسپورٹس کی جانب سے جاری کیا جانے والا سفری دستاویز۔',
    roman_ur: 'DGIP ki taraf se jari kiya jane wala safri dastavez.',
  },
  category: 'travel',
  officialUrl: 'https://dgip.gov.pk/',
  onlineApplicationUrl: 'https://onlinemrp.dgip.gov.pk/',
  displayOrder: 20,
  sourceCode: 'dgip-passport-overview',
  verification: 'unverified',

  aliases: [
    { alias: 'passport', language: 'en', weight: 3 },
    { alias: 'pasport', language: 'en', weight: 2.5 },
    { alias: 'paspot', language: 'roman_ur', weight: 2.5 },
    { alias: 'travel document', language: 'en', weight: 2 },
    { alias: 'mrp', language: 'en', weight: 2 },
    { alias: 'پاسپورٹ', language: 'ur', weight: 3 },
    { alias: 'passport renewal', language: 'en', weight: 3, scenario: 'renewal' },
    { alias: 'passport renew', language: 'en', weight: 3, scenario: 'renewal' },
    { alias: 'passport gum', language: 'roman_ur', weight: 3, scenario: 'lost' },
    { alias: 'lost passport', language: 'en', weight: 3, scenario: 'lost' },
    { alias: 'naya passport', language: 'roman_ur', weight: 3, scenario: 'new' },
  ],

  scenarios: [
    {
      code: 'lost',
      name: { en: 'Lost or stolen passport', ur: 'گم شدہ یا چوری شدہ پاسپورٹ', roman_ur: 'Gum ya chori shuda passport' },
      descriptionEn: 'Replacing a passport that has been lost or stolen.',
      selector: { op: 'eq', var: 'application_type', value: 'lost' },
      priority: 10,
      isExceptionPath: true,
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'renewal',
      name: { en: 'Renewal', ur: 'تجدید', roman_ur: 'Tajdeed' },
      descriptionEn: 'Renewing a passport that has expired or is close to expiry.',
      selector: { op: 'in', var: 'application_type', value: ['renewal', 'damaged'] },
      priority: 20,
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'new',
      name: { en: 'First-time application', ur: 'پہلی بار درخواست', roman_ur: 'Pehli baar darkhast' },
      descriptionEn: 'Applying for a Pakistani passport for the first time.',
      selector: { op: 'in', var: 'application_type', value: ['new', 'modification'] },
      priority: 30,
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
  ],

  rules: [
    {
      code: 'requires_cnic',
      statement: {
        en: 'A passport application requires a valid CNIC (or B-Form for a minor).',
        ur: 'پاسپورٹ کی درخواست کے لیے کارآمد شناختی کارڈ (یا بچوں کے لیے ب-فارم) درکار ہے۔',
        roman_ur: 'Passport ki darkhast ke liye valid CNIC (ya bachon ke liye B-Form) chahiye.',
      },
      // Fires when the applicant is an adult who does not hold a CNIC.
      condition: {
        op: 'and',
        children: [
          { op: 'gte', var: 'applicant_age', value: 18 },
          { op: 'falsy', var: 'has_cnic' },
        ],
      },
      outcome: 'route_exception',
      failureMessageEn: 'You need a valid CNIC before you can apply for a passport.',
      remedyEn: 'Get your CNIC first — this assistant can walk you through that too.',
      severity: 'blocking',
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'minor_needs_guardian',
      statement: {
        en: 'An applicant under 18 must be accompanied by a parent or guardian.',
        ur: 'اٹھارہ سال سے کم عمر درخواست گزار کے ساتھ والدین یا سرپرست کا ہونا ضروری ہے۔',
        roman_ur: '18 saal se kam umar ke applicant ke sath walidain ya guardian ka hona zaroori hai.',
      },
      condition: { op: 'lt', var: 'applicant_age', value: 18 },
      outcome: 'conditional',
      failureMessageEn: 'The applicant is a minor.',
      remedyEn: 'A parent or guardian must attend with their own CNIC and the child’s B-Form.',
      severity: 'advisory',
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'lost_requires_report',
      scenario: 'lost',
      statement: {
        en: 'Replacement of a lost passport requires the loss to have been reported.',
        ur: 'گم شدہ پاسپورٹ کے متبادل کے لیے گمشدگی کی اطلاع ضروری ہے۔',
        roman_ur: 'Gum shuda passport ke replacement ke liye gumshudgi ki report zaroori hai.',
      },
      condition: { op: 'falsy', var: 'has_fir' },
      outcome: 'route_exception',
      failureMessageEn: 'You have not yet reported the loss to the police.',
      remedyEn: 'Obtain a police report for the lost passport before applying.',
      severity: 'blocking',
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
  ],

  requirements: [
    {
      code: 'valid_cnic',
      documentType: 'cnic',
      title: {
        en: 'Your valid CNIC',
        ur: 'آپ کا کارآمد شناختی کارڈ',
        roman_ur: 'Aap ka valid CNIC',
      },
      descriptionEn: 'The identity document the passport record is built from.',
      isMandatory: true,
      appliesWhen: { op: 'gte', var: 'applicant_age', value: 18 },
      mustBeOriginal: true,
      obtainServiceCode: 'cnic',
      obtainFrom: 'NADRA registration centre',
      displayOrder: 10,
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'minor_b_form',
      documentType: 'b_form',
      title: {
        en: 'B-Form / Child Registration Certificate',
        ur: 'ب-فارم / چائلڈ رجسٹریشن سرٹیفکیٹ',
        roman_ur: 'B-Form / Child Registration Certificate',
      },
      descriptionEn: 'Used instead of a CNIC for an applicant under 18.',
      isMandatory: true,
      appliesWhen: { op: 'lt', var: 'applicant_age', value: 18 },
      mustBeOriginal: true,
      obtainFrom: 'NADRA registration centre',
      displayOrder: 10,
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'guardian_cnic',
      documentType: 'parent_cnic',
      title: {
        en: 'Parent’s or guardian’s CNIC',
        ur: 'والدین یا سرپرست کا شناختی کارڈ',
        roman_ur: 'Walidain ya guardian ka CNIC',
      },
      descriptionEn: 'The accompanying adult’s identity document, for a minor applicant.',
      isMandatory: true,
      appliesWhen: { op: 'lt', var: 'applicant_age', value: 18 },
      mustBeOriginal: true,
      displayOrder: 20,
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'previous_passport',
      scenario: 'renewal',
      documentType: 'previous_passport',
      title: {
        en: 'Your previous passport',
        ur: 'آپ کا پرانا پاسپورٹ',
        roman_ur: 'Aap ka purana passport',
      },
      descriptionEn: 'The expiring or damaged booklet, which is cancelled and returned or retained.',
      isMandatory: true,
      appliesWhen: { op: 'in', var: 'application_type', value: ['renewal', 'damaged'] },
      mustBeOriginal: true,
      displayOrder: 20,
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'passport_police_report',
      scenario: 'lost',
      documentType: 'police_report',
      title: {
        en: 'Police report for the lost passport',
        ur: 'گم شدہ پاسپورٹ کی پولیس رپورٹ',
        roman_ur: 'Gum shuda passport ki police report',
      },
      isMandatory: true,
      appliesWhen: { op: 'eq', var: 'application_type', value: 'lost' },
      copiesRequired: 1,
      obtainFrom: 'The police station covering where the passport was lost',
      displayOrder: 15,
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'fee_receipt',
      documentType: 'fee_receipt',
      title: {
        en: 'Fee payment receipt',
        ur: 'فیس ادائیگی کی رسید',
        roman_ur: 'Fees adaigi ki receipt',
      },
      descriptionEn: 'Proof that the applicable fee has been paid through the designated channel.',
      isMandatory: true,
      displayOrder: 40,
      sourceCode: 'dgip-fees',
      verification: 'unverified',
    },
  ],

  steps: [
    {
      code: 'report_passport_loss',
      scenario: 'lost',
      order: 5,
      title: {
        en: 'Report the loss to the police',
        ur: 'گمشدگی کی اطلاع پولیس کو دیں',
        roman_ur: 'Gumshudgi ki report police ko karwayein',
      },
      instruction: {
        en: 'Obtain a written police report for the lost or stolen passport before applying for a replacement.',
        ur: 'متبادل کی درخواست سے پہلے گم شدہ پاسپورٹ کی تحریری پولیس رپورٹ حاصل کریں۔',
        roman_ur: 'Replacement ki darkhast se pehle gum shuda passport ki tehreeri police report hasil karein.',
      },
      channel: 'in_person',
      appliesWhen: { op: 'eq', var: 'application_type', value: 'lost' },
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'apply_online',
      order: 10,
      title: {
        en: 'Start your application on the official online portal',
        ur: 'سرکاری آن لائن پورٹل پر درخواست شروع کریں',
        roman_ur: 'Sarkari online portal par darkhast shuru karein',
      },
      instruction: {
        en: 'Use the official DGI&P online passport portal to begin your application. This assistant cannot submit it for you — the portal is the government’s own system and you complete it there.',
        ur: 'درخواست شروع کرنے کے لیے DGI&P کا سرکاری آن لائن پورٹل استعمال کریں۔ یہ اسسٹنٹ آپ کی جانب سے درخواست جمع نہیں کر سکتا۔',
        roman_ur: 'Darkhast shuru karne ke liye DGI&P ka sarkari online portal use karein. Yeh assistant aap ki taraf se darkhast jama nahi kar sakta.',
      },
      channel: 'online',
      actionUrl: 'https://onlinemrp.dgip.gov.pk/',
      sourceCode: 'dgip-online-application',
      verification: 'unverified',
    },
    {
      code: 'passport_pay_fee',
      order: 20,
      title: {
        en: 'Pay the applicable fee',
        ur: 'قابلِ اطلاق فیس ادا کریں',
        roman_ur: 'Qabil-e-itlaq fees ada karein',
      },
      instruction: {
        en: 'Pay through the channel the portal or office directs you to, and keep the receipt.',
        ur: 'پورٹل یا دفتر کے بتائے گئے ذریعے سے ادائیگی کریں اور رسید سنبھال کر رکھیں۔',
        roman_ur: 'Portal ya daftar ke bataye gaye zariye se adaigi karein aur receipt sambhal kar rakhein.',
      },
      channel: 'either',
      sourceCode: 'dgip-fees',
      verification: 'unverified',
    },
    {
      code: 'passport_biometrics',
      order: 30,
      title: {
        en: 'Attend your appointment for biometrics',
        ur: 'بایومیٹرکس کے لیے اپنی اپائنٹمنٹ پر جائیں',
        roman_ur: 'Biometrics ke liye apni appointment par jayein',
      },
      instruction: {
        en: 'Attend the passport office at your appointment time with all original documents. Photograph, fingerprints and signature are captured there.',
        ur: 'اپنی اپائنٹمنٹ کے وقت تمام اصل دستاویزات کے ساتھ پاسپورٹ آفس جائیں۔',
        roman_ur: 'Apni appointment ke waqt tamam asal dastavezat ke sath passport office jayein.',
      },
      channel: 'in_person',
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'passport_collect',
      order: 40,
      title: {
        en: 'Track and collect your passport',
        ur: 'پیش رفت دیکھیں اور پاسپورٹ وصول کریں',
        roman_ur: 'Progress dekhein aur passport wasool karein',
      },
      instruction: {
        en: 'Follow progress using the tracking reference on your receipt, then collect the booklet or receive it by your chosen delivery option.',
        ur: 'رسید پر موجود ٹریکنگ نمبر سے پیش رفت دیکھیں، پھر پاسپورٹ وصول کریں۔',
        roman_ur: 'Receipt par mojood tracking number se progress dekhein, phir passport wasool karein.',
      },
      channel: 'either',
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
  ],

  fees: [
    {
      code: 'passport_normal',
      category: 'normal',
      label: { en: 'Normal category fee', ur: 'عام کیٹیگری فیس', roman_ur: 'Normal category fees' },
      amountMinor: null,
      appliesWhen: { op: 'in', var: 'urgency', value: ['normal'] },
      noteEn: 'Passport fees vary by booklet size and validity. TODO(source): populate per category from the DGI&P schedule.',
      sourceCode: 'dgip-fees',
      verification: 'unverified',
    },
    {
      code: 'passport_urgent',
      category: 'urgent',
      label: { en: 'Urgent category fee', ur: 'فوری کیٹیگری فیس', roman_ur: 'Urgent category fees' },
      amountMinor: null,
      appliesWhen: { op: 'in', var: 'urgency', value: ['urgent', 'executive'] },
      noteEn: 'TODO(source): populate per category from the DGI&P schedule.',
      sourceCode: 'dgip-fees',
      verification: 'unverified',
    },
  ],

  processingTimes: [
    {
      code: 'passport_time_normal',
      category: 'normal',
      labelEn: 'Normal category',
      minDays: null,
      maxDays: null,
      appliesWhen: { op: 'in', var: 'urgency', value: ['normal'] },
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'passport_time_urgent',
      category: 'urgent',
      labelEn: 'Urgent category',
      minDays: null,
      maxDays: null,
      appliesWhen: { op: 'in', var: 'urgency', value: ['urgent', 'executive'] },
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
  ],

  exceptions: [
    {
      code: 'no_cnic_yet',
      name: {
        en: 'You do not have a CNIC yet',
        ur: 'آپ کے پاس ابھی شناختی کارڈ نہیں ہے',
        roman_ur: 'Aap ke paas abhi CNIC nahi hai',
      },
      trigger: {
        op: 'and',
        children: [
          { op: 'gte', var: 'applicant_age', value: 18 },
          { op: 'falsy', var: 'has_cnic' },
        ],
      },
      guidance: {
        en: 'A passport is built on your CNIC record, so the CNIC has to come first. Start there — this assistant covers the CNIC procedure as well.',
        ur: 'پاسپورٹ آپ کے شناختی کارڈ کے ریکارڈ پر بنتا ہے، اس لیے پہلے شناختی کارڈ بنوانا ہوگا۔',
        roman_ur: 'Passport aap ke CNIC ke record par banta hai, is liye pehle CNIC banwana hoga.',
      },
      escalateToOffice: false,
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
    {
      code: 'overseas_applicant',
      name: {
        en: 'You are applying from outside Pakistan',
        ur: 'آپ پاکستان سے باہر سے درخواست دے رہے ہیں',
        roman_ur: 'Aap Pakistan se bahar se darkhast de rahe hain',
      },
      trigger: { op: 'truthy', var: 'is_overseas' },
      guidance: {
        en: 'Applications from abroad are handled by Pakistani missions rather than domestic passport offices. Contact your nearest embassy or consulate for their local procedure and appointment system.',
        ur: 'بیرونِ ملک سے درخواستیں پاکستانی سفارت خانوں کے ذریعے ہوتی ہیں۔ اپنے قریب ترین سفارت خانے سے رابطہ کریں۔',
        roman_ur: 'Bahar se darkhastein Pakistani sifarat khanon ke zariye hoti hain. Apne qareeb tareen embassy se rabta karein.',
      },
      escalateToOffice: true,
      sourceCode: 'dgip-passport-overview',
      verification: 'unverified',
    },
  ],
};
