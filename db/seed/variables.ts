/**
 * Decision variables — the interview's vocabulary.
 *
 * A variable earns its place here only if some scenario selector, eligibility
 * rule, requirement `appliesWhen` or exception trigger reads it. The interview
 * planner walks the rule set to decide what to ask, so a variable nothing
 * references is simply never asked — it is dead data, not a dormant question.
 *
 * Prompts are authored in all three languages. That is not politeness: a stored
 * translation is reviewable and versioned alongside the rule it serves, and it
 * removes the model from the interview path entirely. The phrasing agent only
 * runs when one of these is missing.
 *
 * `askPriority` is a tie-break, not an order. Ordering is decided at runtime by
 * information gain — a low-priority question that resolves a blocking rule will
 * still be asked first.
 */
import type { SeedVariable } from './types';

export const VARIABLES: SeedVariable[] = [
  {
    code: 'application_type',
    serviceCode: null,
    type: 'enum',
    prompt: {
      en: 'What do you need to do?',
      ur: 'آپ کو کیا کروانا ہے؟',
      roman_ur: 'Aap ko kya karwana hai?',
    },
    help: {
      en: 'This decides which procedure applies to you.',
      ur: 'اس سے طے ہوتا ہے کہ آپ پر کون سا طریقہ کار لاگو ہوگا۔',
      roman_ur: 'Is se tay hota hai ke aap par kaunsa procedure lagu hoga.',
    },
    options: [
      {
        value: 'new',
        label: { en: 'Get one for the first time', ur: 'پہلی بار بنوانا', roman_ur: 'Pehli baar banwana' },
      },
      {
        value: 'renewal',
        label: { en: 'Renew an expired one', ur: 'میعاد ختم شدہ کی تجدید', roman_ur: 'Expire shuda ki tajdeed' },
      },
      {
        value: 'lost',
        label: { en: 'Replace a lost or stolen one', ur: 'گم شدہ یا چوری شدہ کا متبادل', roman_ur: 'Gum ya chori shuda ka replacement' },
      },
      {
        value: 'damaged',
        label: { en: 'Replace a damaged one', ur: 'خراب شدہ کا متبادل', roman_ur: 'Kharab shuda ka replacement' },
      },
      {
        value: 'modification',
        label: { en: 'Correct or change details on it', ur: 'تفصیلات درست یا تبدیل کروانا', roman_ur: 'Tafseelat theek ya tabdeel karwana' },
      },
    ],
    askPriority: 10,
  },
  {
    code: 'applicant_age',
    serviceCode: null,
    type: 'number',
    prompt: {
      en: 'How old are you?',
      ur: 'آپ کی عمر کتنی ہے؟',
      roman_ur: 'Aap ki umar kitni hai?',
    },
    help: {
      en: 'Age changes which documents are required and which category you fall under.',
      ur: 'عمر سے طے ہوتا ہے کہ کون سی دستاویزات درکار ہیں۔',
      roman_ur: 'Umar se tay hota hai ke kaunse documents chahiye.',
    },
    askPriority: 20,
  },
  {
    code: 'province',
    serviceCode: null,
    type: 'enum',
    prompt: {
      en: 'Which province are you applying in?',
      ur: 'آپ کس صوبے میں درخواست دے رہے ہیں؟',
      roman_ur: 'Aap kis soobay mein darkhast de rahe hain?',
    },
    options: [
      { value: 'Sindh', label: { en: 'Sindh', ur: 'سندھ', roman_ur: 'Sindh' } },
      { value: 'Punjab', label: { en: 'Punjab', ur: 'پنجاب', roman_ur: 'Punjab' } },
      { value: 'Khyber Pakhtunkhwa', label: { en: 'Khyber Pakhtunkhwa', ur: 'خیبر پختونخوا', roman_ur: 'Khyber Pakhtunkhwa' } },
      { value: 'Balochistan', label: { en: 'Balochistan', ur: 'بلوچستان', roman_ur: 'Balochistan' } },
      { value: 'Islamabad Capital Territory', label: { en: 'Islamabad Capital Territory', ur: 'اسلام آباد', roman_ur: 'Islamabad' } },
      { value: 'Gilgit-Baltistan', label: { en: 'Gilgit-Baltistan', ur: 'گلگت بلتستان', roman_ur: 'Gilgit-Baltistan' } },
      { value: 'Azad Jammu and Kashmir', label: { en: 'Azad Jammu and Kashmir', ur: 'آزاد جموں و کشمیر', roman_ur: 'Azad Kashmir' } },
    ],
    askPriority: 30,
  },
  {
    code: 'city',
    serviceCode: null,
    type: 'text',
    prompt: {
      en: 'Which city are you in?',
      ur: 'آپ کس شہر میں ہیں؟',
      roman_ur: 'Aap kis sheher mein hain?',
    },
    help: {
      en: 'We use this only to show you the nearest office.',
      ur: 'ہم یہ صرف قریب ترین دفتر دکھانے کے لیے استعمال کرتے ہیں۔',
      roman_ur: 'Hum yeh sirf qareeb tareen daftar dikhane ke liye use karte hain.',
    },
    askPriority: 35,
  },
  {
    code: 'has_fir',
    serviceCode: null,
    type: 'boolean',
    prompt: {
      en: 'Have you reported the loss to the police (FIR or police report)?',
      ur: 'کیا آپ نے گمشدگی کی اطلاع پولیس کو دی ہے (ایف آئی آر یا پولیس رپورٹ)؟',
      roman_ur: 'Kya aap ne gumshudgi ki report police ko karwai hai (FIR ya police report)?',
    },
    help: {
      en: 'Replacement of a lost document usually needs proof that the loss was reported.',
      ur: 'گم شدہ دستاویز کے متبادل کے لیے عموماً رپورٹ کا ثبوت درکار ہوتا ہے۔',
      roman_ur: 'Gum shuda document ke replacement ke liye aam tor par report ka saboot chahiye hota hai.',
    },
    askPriority: 40,
  },
  {
    code: 'address_matches_cnic',
    serviceCode: null,
    type: 'boolean',
    prompt: {
      en: 'Is the address on your CNIC the same as where you live now?',
      ur: 'کیا آپ کے شناختی کارڈ پر درج پتہ وہی ہے جہاں آپ اب رہتے ہیں؟',
      roman_ur: 'Kya aap ke CNIC par likha pata wahi hai jahan aap ab rehte hain?',
    },
    help: {
      en: 'A mismatch changes which office handles your case and what proof you need to bring.',
      ur: 'فرق ہونے پر آپ کا کیس مختلف دفتر دیکھے گا اور اضافی ثبوت درکار ہوگا۔',
      roman_ur: 'Farq hone par aap ka case doosra daftar dekhega aur extra saboot chahiye hoga.',
    },
    askPriority: 50,
  },
  {
    code: 'has_previous_document',
    serviceCode: null,
    type: 'boolean',
    prompt: {
      en: 'Do you still have the previous document (even if expired or damaged)?',
      ur: 'کیا پرانی دستاویز اب بھی آپ کے پاس ہے (چاہے میعاد ختم یا خراب ہو)؟',
      roman_ur: 'Kya purani document abhi bhi aap ke paas hai (chahe expire ya kharab ho)?',
    },
    askPriority: 45,
  },
  {
    code: 'has_parent_cnic',
    serviceCode: null,
    type: 'boolean',
    prompt: {
      en: 'Do you have your parents’ CNIC (or a guardian’s)?',
      ur: 'کیا آپ کے پاس والدین (یا سرپرست) کا شناختی کارڈ ہے؟',
      roman_ur: 'Kya aap ke paas walidain (ya guardian) ka CNIC hai?',
    },
    help: {
      en: 'A first-time application usually needs a parent or guardian record to link to.',
      ur: 'پہلی بار درخواست کے لیے عموماً والدین یا سرپرست کا ریکارڈ درکار ہوتا ہے۔',
      roman_ur: 'Pehli baar darkhast ke liye aam tor par walidain ya guardian ka record chahiye hota hai.',
    },
    askPriority: 55,
  },
  {
    code: 'parents_deceased',
    serviceCode: null,
    type: 'boolean',
    prompt: {
      en: 'Are both parents deceased or their records unavailable?',
      ur: 'کیا والدین وفات پا چکے ہیں یا ان کا ریکارڈ دستیاب نہیں؟',
      roman_ur: 'Kya walidain wafat pa chuke hain ya un ka record dastyab nahi?',
    },
    askPriority: 60,
  },
  {
    code: 'is_overseas',
    serviceCode: null,
    type: 'boolean',
    prompt: {
      en: 'Are you currently outside Pakistan?',
      ur: 'کیا آپ اس وقت پاکستان سے باہر ہیں؟',
      roman_ur: 'Kya aap is waqt Pakistan se bahar hain?',
    },
    help: {
      en: 'Applying from abroad goes through a different office and document route.',
      ur: 'بیرونِ ملک سے درخواست مختلف دفتر اور طریقہ کار سے ہوتی ہے۔',
      roman_ur: 'Bahar se darkhast alag daftar aur tareeqe se hoti hai.',
    },
    askPriority: 65,
  },
  {
    code: 'urgency',
    serviceCode: null,
    type: 'enum',
    prompt: {
      en: 'How soon do you need it?',
      ur: 'آپ کو یہ کتنی جلدی درکار ہے؟',
      roman_ur: 'Aap ko yeh kitni jaldi chahiye?',
    },
    options: [
      { value: 'normal', label: { en: 'Normal', ur: 'عام', roman_ur: 'Normal' } },
      { value: 'urgent', label: { en: 'Urgent', ur: 'فوری', roman_ur: 'Urgent' } },
      { value: 'executive', label: { en: 'Fastest available', ur: 'تیز ترین', roman_ur: 'Sab se tez' } },
    ],
    askPriority: 70,
  },
  {
    code: 'birth_registered',
    serviceCode: null,
    type: 'boolean',
    prompt: {
      en: 'Is your birth registered with the local union council (do you have a B-Form or CRC)?',
      ur: 'کیا آپ کی پیدائش یونین کونسل میں رجسٹرڈ ہے (کیا آپ کے پاس ب-فارم یا CRC ہے)؟',
      roman_ur: 'Kya aap ki paidaish union council mein registered hai (kya aap ke paas B-Form ya CRC hai)?',
    },
    askPriority: 58,
  },
  {
    code: 'has_cnic',
    serviceCode: null,
    type: 'boolean',
    prompt: {
      en: 'Do you already have a valid CNIC?',
      ur: 'کیا آپ کے پاس پہلے سے کارآمد شناختی کارڈ ہے؟',
      roman_ur: 'Kya aap ke paas pehle se valid CNIC hai?',
    },
    help: {
      en: 'Both a passport and a domicile certificate are built on your CNIC record, so it has to exist first.',
      ur: 'پاسپورٹ اور ڈومیسائل دونوں شناختی کارڈ کے ریکارڈ پر بنتے ہیں۔',
      roman_ur: 'Passport aur domicile dono CNIC ke record par bante hain.',
    },
    askPriority: 15,
  },
  {
    code: 'has_existing_domicile',
    serviceCode: 'domicile',
    type: 'boolean',
    prompt: {
      en: 'Do you already hold a domicile certificate for another district?',
      ur: 'کیا آپ کے پاس پہلے سے کسی اور ضلع کا ڈومیسائل ہے؟',
      roman_ur: 'Kya aap ke paas pehle se kisi aur zilay ka domicile hai?',
    },
    help: {
      en: 'A citizen holds a domicile for one district only, so an existing one changes the process to a transfer.',
      ur: 'ایک شہری کا ڈومیسائل صرف ایک ضلع کا ہوتا ہے۔',
      roman_ur: 'Aik shehri ka domicile sirf aik zilay ka hota hai.',
    },
    askPriority: 32,
  },
  {
    code: 'residence_years',
    serviceCode: 'domicile',
    type: 'number',
    prompt: {
      en: 'How many years have you lived in this district?',
      ur: 'آپ اس ضلع میں کتنے سال سے رہ رہے ہیں؟',
      roman_ur: 'Aap is zilay mein kitne saal se reh rahe hain?',
    },
    help: {
      en: 'Domicile is tied to sustained residence in a district.',
      ur: 'ڈومیسائل کا تعلق ضلع میں مسلسل رہائش سے ہے۔',
      roman_ur: 'Domicile ka taluq zilay mein musalsal rihaish se hai.',
    },
    askPriority: 25,
  },
  {
    code: 'domicile_basis',
    serviceCode: 'domicile',
    type: 'enum',
    prompt: {
      en: 'On what basis are you claiming domicile?',
      ur: 'آپ کس بنیاد پر ڈومیسائل کا دعویٰ کر رہے ہیں؟',
      roman_ur: 'Aap kis bunyad par domicile claim kar rahe hain?',
    },
    options: [
      { value: 'residence', label: { en: 'My own residence', ur: 'اپنی رہائش', roman_ur: 'Apni rihaish' } },
      { value: 'father', label: { en: 'My father’s domicile', ur: 'والد کا ڈومیسائل', roman_ur: 'Walid ka domicile' } },
      { value: 'marriage', label: { en: 'Marriage', ur: 'شادی کی بنیاد پر', roman_ur: 'Shadi ki bunyad par' } },
    ],
    askPriority: 28,
  },
];
