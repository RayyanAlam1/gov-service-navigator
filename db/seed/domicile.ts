/**
 * Domicile certificate (district administration / provincial home departments).
 *
 * Modelled third because it is the awkward one, and that is exactly why it
 * belongs in the MVP: domicile is issued by the *district*, so the procedure,
 * the office and the acceptable proofs genuinely differ across Pakistan. A
 * system that answers a domicile question with one national procedure is
 * confidently wrong for most citizens.
 *
 * So the rules here are explicit about jurisdiction: province is a required
 * input, an out-of-district application is routed as an exception, and the
 * plan escalates to the district office rather than asserting a procedure we
 * cannot source per-district.
 *
 * PROVENANCE: everything is `unverified` against a province-level source, and
 * fees are NULL. TODO(source): split `domicile-provincial` into one source row
 * per province with its own official URL, and scope requirements to it.
 */
import type { SeedService } from './types';

export const DOMICILE_SERVICE: SeedService = {
  code: 'domicile',
  departmentCode: 'district-admin',
  name: {
    en: 'Domicile Certificate',
    ur: 'ڈومیسائل سرٹیفکیٹ',
    roman_ur: 'Domicile Certificate',
  },
  summary: {
    en: 'A certificate of permanent residence in a district, issued by the district administration. Commonly required for education quotas and government employment.',
    ur: 'کسی ضلع میں مستقل رہائش کا سرٹیفکیٹ، جو ضلعی انتظامیہ جاری کرتی ہے۔ تعلیمی کوٹے اور سرکاری ملازمت کے لیے درکار ہوتا ہے۔',
    roman_ur: 'Kisi zilay mein mustaqil rihaish ka certificate, jo zilai intezamia jari karti hai. Taleemi quota aur sarkari mulazmat ke liye chahiye hota hai.',
  },
  category: 'residence',
  officialUrl: null,
  onlineApplicationUrl: null,
  displayOrder: 30,
  sourceCode: 'domicile-provincial',
  verification: 'unverified',

  aliases: [
    { alias: 'domicile', language: 'en', weight: 3 },
    { alias: 'domicile certificate', language: 'en', weight: 3 },
    { alias: 'domecile', language: 'en', weight: 2.5 },
    { alias: 'dumsail', language: 'roman_ur', weight: 2.5 },
    { alias: 'ڈومیسائل', language: 'ur', weight: 3 },
    { alias: 'permanent residence certificate', language: 'en', weight: 2.5 },
    { alias: 'prc', language: 'en', weight: 2 },
    { alias: 'domicile banwana', language: 'roman_ur', weight: 3, scenario: 'new' },
  ],

  scenarios: [
    {
      code: 'new',
      name: { en: 'New domicile certificate', ur: 'نیا ڈومیسائل سرٹیفکیٹ', roman_ur: 'Naya domicile certificate' },
      descriptionEn: 'Applying for a domicile certificate for the first time.',
      selector: { op: 'in', var: 'application_type', value: ['new', 'renewal'] },
      priority: 20,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'duplicate',
      name: { en: 'Duplicate copy', ur: 'نقل', roman_ur: 'Duplicate copy' },
      descriptionEn: 'Obtaining a replacement copy of a domicile certificate already issued to you.',
      selector: { op: 'in', var: 'application_type', value: ['lost', 'damaged'] },
      priority: 10,
      isExceptionPath: true,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
  ],

  rules: [
    {
      code: 'requires_cnic',
      statement: {
        en: 'A domicile application requires a valid CNIC.',
        ur: 'ڈومیسائل کی درخواست کے لیے کارآمد شناختی کارڈ درکار ہے۔',
        roman_ur: 'Domicile ki darkhast ke liye valid CNIC chahiye.',
      },
      condition: { op: 'falsy', var: 'has_cnic' },
      outcome: 'route_exception',
      failureMessageEn: 'You need a valid CNIC before applying for a domicile certificate.',
      remedyEn: 'Get your CNIC first — this assistant covers that procedure too.',
      severity: 'blocking',
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'residence_requirement',
      statement: {
        en: 'Domicile is granted on the basis of sustained residence in the district, or through parentage or marriage.',
        ur: 'ڈومیسائل ضلع میں مسلسل رہائش، یا والدیت یا شادی کی بنیاد پر جاری ہوتا ہے۔',
        roman_ur: 'Domicile zilay mein musalsal rihaish, ya walidiyat ya shadi ki bunyad par jari hota hai.',
      },
      // Fires when someone claims on residence but has lived there very briefly.
      condition: {
        op: 'and',
        children: [
          { op: 'eq', var: 'domicile_basis', value: 'residence' },
          { op: 'lt', var: 'residence_years', value: 2 },
        ],
      },
      outcome: 'conditional',
      failureMessageEn: 'You have recently moved to this district.',
      remedyEn:
        'Districts set their own minimum residence period and evidence standard. Confirm the requirement with the district office before applying — do not rely on a general figure.',
      severity: 'advisory',
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'one_domicile_only',
      statement: {
        en: 'A citizen holds a domicile for one district only.',
        ur: 'ایک شہری کا ڈومیسائل صرف ایک ضلع کا ہوتا ہے۔',
        roman_ur: 'Aik shehri ka domicile sirf aik zilay ka hota hai.',
      },
      condition: { op: 'truthy', var: 'has_existing_domicile' },
      outcome: 'conditional',
      failureMessageEn: 'You already hold a domicile certificate for another district.',
      remedyEn:
        'Transferring a domicile between districts is a separate process handled by the district administration. Ask the district office about transfer rather than applying afresh.',
      severity: 'advisory',
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
  ],

  requirements: [
    {
      code: 'domicile_cnic',
      documentType: 'cnic',
      title: {
        en: 'Your valid CNIC',
        ur: 'آپ کا کارآمد شناختی کارڈ',
        roman_ur: 'Aap ka valid CNIC',
      },
      isMandatory: true,
      mustBeOriginal: true,
      copiesRequired: 1,
      obtainServiceCode: 'cnic',
      obtainFrom: 'NADRA registration centre',
      displayOrder: 10,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'domicile_application_form',
      documentType: 'application_form',
      title: {
        en: 'Completed application form',
        ur: 'مکمل شدہ درخواست فارم',
        roman_ur: 'Mukammal shuda darkhast form',
      },
      descriptionEn: 'The prescribed form for your district. Forms differ between districts — collect it from the office you will apply at.',
      isMandatory: true,
      obtainFrom: 'The Deputy Commissioner / district office for your area',
      displayOrder: 20,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'residence_proof',
      documentType: 'address_proof',
      title: {
        en: 'Proof of residence in the district',
        ur: 'ضلع میں رہائش کا ثبوت',
        roman_ur: 'Zilay mein rihaish ka saboot',
      },
      descriptionEn: 'Evidence that you live in the district — the accepted forms vary, so confirm with the district office which they take.',
      isMandatory: true,
      appliesWhen: { op: 'eq', var: 'domicile_basis', value: 'residence' },
      displayOrder: 30,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'father_domicile',
      documentType: 'parent_domicile',
      title: {
        en: 'Father’s domicile certificate',
        ur: 'والد کا ڈومیسائل سرٹیفکیٹ',
        roman_ur: 'Walid ka domicile certificate',
      },
      descriptionEn: 'Used when claiming domicile through parentage rather than your own residence.',
      isMandatory: true,
      appliesWhen: { op: 'eq', var: 'domicile_basis', value: 'father' },
      copiesRequired: 1,
      displayOrder: 30,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'marriage_certificate',
      documentType: 'nikah_nama',
      title: {
        en: 'Marriage certificate (Nikah Nama)',
        ur: 'نکاح نامہ',
        roman_ur: 'Nikah Nama',
      },
      descriptionEn: 'Used when claiming domicile on the basis of marriage.',
      isMandatory: true,
      appliesWhen: { op: 'eq', var: 'domicile_basis', value: 'marriage' },
      copiesRequired: 1,
      displayOrder: 30,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'domicile_affidavit',
      documentType: 'affidavit',
      title: {
        en: 'Affidavit on stamp paper',
        ur: 'اسٹامپ پیپر پر حلف نامہ',
        roman_ur: 'Stamp paper par halaf nama',
      },
      descriptionEn: 'A sworn declaration of your residence, commonly required by district offices.',
      isMandatory: true,
      obtainFrom: 'An oath commissioner / notary',
      displayOrder: 40,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'domicile_photos',
      documentType: 'photograph',
      title: {
        en: 'Passport-size photographs',
        ur: 'پاسپورٹ سائز تصاویر',
        roman_ur: 'Passport size tasaweer',
      },
      isMandatory: true,
      // Deliberately no count: the number varies by district and we have no
      // source for it. The UI renders "number not verified".
      copiesRequired: null,
      displayOrder: 50,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'previous_domicile',
      scenario: 'duplicate',
      documentType: 'previous_domicile',
      title: {
        en: 'Details of the previously issued certificate',
        ur: 'پہلے جاری شدہ سرٹیفکیٹ کی تفصیلات',
        roman_ur: 'Pehle jari shuda certificate ki tafseelat',
      },
      descriptionEn: 'A copy of the original, or its issue date and reference number, to locate the record.',
      isMandatory: true,
      appliesWhen: { op: 'in', var: 'application_type', value: ['lost', 'damaged'] },
      displayOrder: 15,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
  ],

  steps: [
    {
      code: 'domicile_collect_form',
      order: 10,
      title: {
        en: 'Collect the form from your district office',
        ur: 'اپنے ضلعی دفتر سے فارم حاصل کریں',
        roman_ur: 'Apne zilai daftar se form hasil karein',
      },
      instruction: {
        en: 'Domicile is issued by the district you claim residence in, and each district uses its own form and evidence list. Collect the form from the Deputy Commissioner’s office for that district and ask which proofs they accept.',
        ur: 'ڈومیسائل اسی ضلع سے جاری ہوتا ہے جہاں آپ رہائش کا دعویٰ کرتے ہیں، اور ہر ضلع کا اپنا فارم ہوتا ہے۔ ڈپٹی کمشنر آفس سے فارم حاصل کریں۔',
        roman_ur: 'Domicile usi zilay se jari hota hai jahan aap rihaish ka dawa karte hain, aur har zilay ka apna form hota hai. Deputy Commissioner office se form hasil karein.',
      },
      channel: 'in_person',
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'domicile_affidavit_step',
      order: 20,
      title: {
        en: 'Get your affidavit sworn',
        ur: 'اپنا حلف نامہ تیار کروائیں',
        roman_ur: 'Apna halaf nama tayyar karwayein',
      },
      instruction: {
        en: 'Have the residence affidavit prepared on stamp paper and sworn before an oath commissioner.',
        ur: 'رہائش کا حلف نامہ اسٹامپ پیپر پر تیار کروا کر اوتھ کمشنر کے سامنے تصدیق کروائیں۔',
        roman_ur: 'Rihaish ka halaf nama stamp paper par tayyar karwa kar oath commissioner ke samne tasdeeq karwayein.',
      },
      channel: 'in_person',
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'domicile_submit',
      order: 30,
      title: {
        en: 'Submit your application',
        ur: 'اپنی درخواست جمع کروائیں',
        roman_ur: 'Apni darkhast jama karwayein',
      },
      instruction: {
        en: 'Submit the completed form with all documents at the district office counter and keep the acknowledgement slip.',
        ur: 'مکمل فارم اور تمام دستاویزات ضلعی دفتر کے کاؤنٹر پر جمع کروائیں اور رسید سنبھال کر رکھیں۔',
        roman_ur: 'Mukammal form aur tamam dastavezat zilai daftar ke counter par jama karwayein aur receipt sambhal kar rakhein.',
      },
      channel: 'in_person',
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'domicile_verification',
      order: 40,
      title: {
        en: 'Verification of your residence',
        ur: 'آپ کی رہائش کی تصدیق',
        roman_ur: 'Aap ki rihaish ki tasdeeq',
      },
      instruction: {
        en: 'The office verifies your residence claim before issuing. This may involve a local enquiry, so make sure the contact details on your form are ones you actually answer.',
        ur: 'دفتر جاری کرنے سے پہلے آپ کی رہائش کی تصدیق کرتا ہے۔ اس لیے فارم پر درست رابطہ نمبر دیں۔',
        roman_ur: 'Daftar jari karne se pehle aap ki rihaish ki tasdeeq karta hai. Is liye form par sahi rabta number dein.',
      },
      channel: 'in_person',
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'domicile_collect',
      order: 50,
      title: {
        en: 'Collect your certificate',
        ur: 'اپنا سرٹیفکیٹ وصول کریں',
        roman_ur: 'Apna certificate wasool karein',
      },
      instruction: {
        en: 'Return to the office with your acknowledgement slip to collect the certificate once verification is complete.',
        ur: 'تصدیق مکمل ہونے پر رسید کے ساتھ دفتر جا کر سرٹیفکیٹ وصول کریں۔',
        roman_ur: 'Tasdeeq mukammal hone par receipt ke sath daftar ja kar certificate wasool karein.',
      },
      channel: 'in_person',
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
  ],

  fees: [
    {
      code: 'domicile_fee',
      category: 'normal',
      label: { en: 'District processing fee', ur: 'ضلعی فیس', roman_ur: 'Zilai fees' },
      amountMinor: null,
      noteEn: 'Domicile fees are set at district level and vary. TODO(source): populate per district, never nationally.',
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
  ],

  processingTimes: [
    {
      code: 'domicile_time',
      category: 'normal',
      labelEn: 'Standard processing',
      minDays: null,
      maxDays: null,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
  ],

  exceptions: [
    {
      code: 'district_specific',
      name: {
        en: 'District rules apply to your case',
        ur: 'آپ کے کیس پر ضلعی قواعد لاگو ہوتے ہیں',
        roman_ur: 'Aap ke case par zilai qawaid lagu hote hain',
      },
      // Always fires: this is a standing caveat, not a rare branch, because
      // the whole service is district-governed.
      trigger: { op: 'always' },
      guidance: {
        en: 'Domicile requirements, fees and accepted proofs are set by the district, not nationally. Treat this checklist as the general shape and confirm the specifics with the district office you will apply at.',
        ur: 'ڈومیسائل کے تقاضے، فیس اور قابلِ قبول ثبوت ضلع طے کرتا ہے، ملکی سطح پر نہیں۔ تفصیلات اپنے ضلعی دفتر سے تصدیق کریں۔',
        roman_ur: 'Domicile ke taqaze, fees aur qabil-e-qubool saboot zila tay karta hai, mulki satah par nahi. Tafseelat apne zilai daftar se tasdeeq karein.',
      },
      escalateToOffice: true,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
    {
      code: 'out_of_district',
      name: {
        en: 'You live outside the district you are claiming',
        ur: 'آپ اس ضلع سے باہر رہتے ہیں جس کا دعویٰ کر رہے ہیں',
        roman_ur: 'Aap us zilay se bahar rehte hain jis ka dawa kar rahe hain',
      },
      trigger: {
        op: 'and',
        children: [
          { op: 'eq', var: 'domicile_basis', value: 'residence' },
          { op: 'lt', var: 'residence_years', value: 2 },
        ],
      },
      guidance: {
        en: 'A recent move makes the residence claim harder to evidence. Ask the district office what they accept before assembling documents — some require a longer residence history, others accept a parent’s domicile instead.',
        ur: 'حالیہ منتقلی کی صورت میں رہائش ثابت کرنا مشکل ہوتا ہے۔ دستاویزات جمع کرنے سے پہلے ضلعی دفتر سے پوچھیں۔',
        roman_ur: 'Haliya shift hone ki surat mein rihaish sabit karna mushkil hota hai. Dastavezat jama karne se pehle zilai daftar se poochein.',
      },
      escalateToOffice: true,
      sourceCode: 'domicile-provincial',
      verification: 'unverified',
    },
  ],
};
