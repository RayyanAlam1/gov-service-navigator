/**
 * Interface strings.
 *
 * Authored in all three languages, not translated at runtime. The chrome of the
 * application — buttons, labels, badges, error messages — must never depend on
 * a model being reachable, and it must never drift the way machine translation
 * of UI copy does between builds.
 *
 * Content strings (procedure text, document names) are a separate matter: those
 * live in the database with their own translations and provenance, and the
 * composer fills gaps. This file is only the shell.
 */
import type { Language } from '@/lib/schemas/core';

type Dict = Record<Language, string>;

function t(en: string, ur: string, roman_ur: string): Dict {
  return { en, ur, roman_ur };
}

export const UI = {
  /* ── Shell ──────────────────────────────────────────────────────────── */
  appName: t(
    'Government Service Navigator',
    'گورنمنٹ سروس نیویگیٹر',
    'Government Service Navigator',
  ),
  tagline: t(
    'Turn complex government procedures into a personalised, verified action plan.',
    'پیچیدہ سرکاری طریقہ کار کو ذاتی، تصدیق شدہ لائحہ عمل میں بدلیں۔',
    'Pechida sarkari procedures ko zaati, tasdeeq shuda action plan mein badlein.',
  ),
  language: t('Language', 'زبان', 'Zaban'),
  skipToContent: t('Skip to main content', 'مرکزی مواد پر جائیں', 'Markazi content par jayein'),

  /* ── Intake ─────────────────────────────────────────────────────────── */
  intakePrompt: t(
    'What do you need to get done?',
    'آپ کو کیا کروانا ہے؟',
    'Aap ko kya karwana hai?',
  ),
  intakeHelp: t(
    'Describe your situation in your own words — English, Urdu or Roman Urdu.',
    'اپنی صورتحال اپنے الفاظ میں بیان کریں — انگریزی، اردو یا رومن اردو میں۔',
    'Apni situation apne alfaz mein batayein — English, Urdu ya Roman Urdu mein.',
  ),
  intakePlaceholder: t(
    'e.g. I lost my CNIC and I live in Karachi — what do I do now?',
    'مثلاً میرا شناختی کارڈ گم ہو گیا ہے اور میں کراچی میں رہتا ہوں — اب کیا کروں؟',
    'Misal: mera CNIC gum ho gaya hai aur main Karachi mein rehta hoon — ab kya karoon?',
  ),
  start: t('Get my action plan', 'میرا لائحہ عمل بنائیں', 'Mera action plan banayein'),
  tryExample: t('Try an example', 'مثال آزمائیں', 'Misal azmayein'),

  /* ── Interview ──────────────────────────────────────────────────────── */
  yourSituation: t('Your situation', 'آپ کی صورتحال', 'Aap ki situation'),
  whyAsking: t('Why are we asking this?', 'ہم یہ کیوں پوچھ رہے ہیں؟', 'Hum yeh kyun pooch rahe hain?'),
  yes: t('Yes', 'ہاں', 'Haan'),
  no: t('No', 'نہیں', 'Nahi'),
  skipQuestion: t('I’m not sure', 'مجھے یقین نہیں', 'Mujhe yaqeen nahi'),
  continue: t('Continue', 'جاری رکھیں', 'Jari rakhein'),
  back: t('Back', 'واپس', 'Wapas'),
  questionProgress: t('Question', 'سوال', 'Sawal'),
  weAssumed: t('We assumed from what you wrote', 'آپ کی تحریر سے ہم نے سمجھا', 'Aap ki tehreer se hum ne samjha'),
  correctThis: t('Correct this', 'اسے درست کریں', 'Ise theek karein'),

  /* ── Plan ───────────────────────────────────────────────────────────── */
  yourPlan: t('Your action plan', 'آپ کا لائحہ عمل', 'Aap ka action plan'),
  steps: t('Steps', 'مراحل', 'Marahil'),
  documents: t('Documents you need', 'درکار دستاویزات', 'Darkar dastavezat'),
  fees: t('Fees', 'فیس', 'Fees'),
  processingTime: t('Processing time', 'دورانیہ', 'Duraniya'),
  whereToGo: t('Where to go', 'کہاں جانا ہے', 'Kahan jana hai'),
  officialRoute: t('Official application', 'سرکاری درخواست', 'Sarkari darkhast'),
  sources: t('Sources', 'ذرائع', 'Zaraye'),
  step: t('Step', 'مرحلہ', 'Marhala'),
  notVerified: t('not verified', 'تصدیق شدہ نہیں', 'tasdeeq shuda nahi'),
  confirmAtOffice: t(
    'Confirm the current amount at the office.',
    'موجودہ رقم دفتر سے تصدیق کریں۔',
    'Mojooda raqam daftar se tasdeeq karein.',
  ),

  /* ── Readiness ──────────────────────────────────────────────────────── */
  amIReady: t('Am I ready?', 'کیا میں تیار ہوں؟', 'Kya main tayyar hoon?'),
  readinessHelp: t(
    'Tick what you already have. We’ll tell you what’s still missing.',
    'جو آپ کے پاس ہے اس پر نشان لگائیں۔ ہم بتائیں گے کیا باقی ہے۔',
    'Jo aap ke paas hai us par nishan lagayein. Hum batayenge kya baqi hai.',
  ),
  ready: t('Ready to go', 'جانے کے لیے تیار', 'Jane ke liye tayyar'),
  nearlyReady: t('Almost ready', 'تقریباً تیار', 'Taqreeban tayyar'),
  notReady: t('Not ready yet', 'ابھی تیار نہیں', 'Abhi tayyar nahi'),
  undetermined: t('We need a bit more', 'ہمیں کچھ اور معلومات چاہئیں', 'Humein kuch aur maloomat chahiye'),
  nextAction: t('Do this next', 'اگلا قدم', 'Agla qadam'),
  iHaveThis: t('I have this', 'یہ میرے پاس ہے', 'Yeh mere paas hai'),
  stillNeeded: t('Still needed', 'ابھی درکار', 'Abhi darkar'),
  getItFrom: t('Get it from', 'یہاں سے حاصل کریں', 'Yahan se hasil karein'),
  originalRequired: t('Original required', 'اصل درکار', 'Asal darkar'),
  copies: t('copies', 'کاپیاں', 'copies'),
  optional: t('Optional', 'اختیاری', 'Ikhtiyari'),

  /* ── Documents ──────────────────────────────────────────────────────── */
  checkDocument: t('Check a document', 'دستاویز چیک کریں', 'Dastavez check karein'),
  uploadHelp: t(
    'Upload a document and we’ll check it against this requirement. Your file is processed and discarded — nothing is stored.',
    'دستاویز اپ لوڈ کریں، ہم اسے اس تقاضے سے ملا کر دیکھیں گے۔ آپ کی فائل محفوظ نہیں کی جاتی۔',
    'Dastavez upload karein, hum ise is taqaze se mila kar dekhenge. Aap ki file mehfooz nahi ki jati.',
  ),
  matchOk: t('Matches this requirement', 'اس تقاضے سے مطابقت رکھتا ہے', 'Is taqaze se match karta hai'),
  matchExpired: t('This document has expired', 'یہ دستاویز میعاد ختم ہو چکی ہے', 'Yeh dastavez expire ho chuki hai'),
  matchWrong: t('This looks like a different document', 'یہ کوئی اور دستاویز لگتی ہے', 'Yeh koi aur dastavez lagti hai'),
  matchUnreadable: t('We could not read this document', 'ہم یہ دستاویز پڑھ نہیں سکے', 'Hum yeh dastavez parh nahi sake'),
  matchInconclusive: t('We could not confirm this', 'ہم اس کی تصدیق نہیں کر سکے', 'Hum is ki tasdeeq nahi kar sake'),
  nothingStored: t('Nothing was stored', 'کچھ محفوظ نہیں کیا گیا', 'Kuch mehfooz nahi kiya gaya'),

  /* ── Trust ──────────────────────────────────────────────────────────── */
  verified: t('Verified', 'تصدیق شدہ', 'Tasdeeq shuda'),
  unverified: t('Not yet verified', 'ابھی تصدیق شدہ نہیں', 'Abhi tasdeeq shuda nahi'),
  synthetic: t('Demo data', 'نمونہ ڈیٹا', 'Demo data'),
  stale: t('Needs re-checking', 'دوبارہ جانچ درکار', 'Dobara janch darkar'),
  lastVerified: t('Last verified', 'آخری تصدیق', 'Aakhri tasdeeq'),
  sourceUnknown: t('Source not recorded', 'ذریعہ درج نہیں', 'Zariya darj nahi'),
  couldNotVerify: t(
    'We could not verify this against an official source.',
    'ہم اس کی سرکاری ذریعے سے تصدیق نہیں کر سکے۔',
    'Hum is ki sarkari zariye se tasdeeq nahi kar sake.',
  ),

  /* ── Trace ──────────────────────────────────────────────────────────── */
  howProduced: t('How this answer was produced', 'یہ جواب کیسے بنا', 'Yeh jawab kaise bana'),
  deterministic: t('Fixed logic', 'طے شدہ منطق', 'Tay shuda logic'),
  aiAssisted: t('AI', 'اے آئی', 'AI'),
  traceHelp: t(
    'Every step is recorded. Fixed logic decides the facts; AI only handles language.',
    'ہر مرحلہ ریکارڈ ہوتا ہے۔ حقائق طے شدہ منطق طے کرتی ہے؛ اے آئی صرف زبان سنبھالتا ہے۔',
    'Har marhala record hota hai. Haqaiq tay shuda logic tay karti hai; AI sirf zaban sambhalta hai.',
  ),

  /* ── States ─────────────────────────────────────────────────────────── */
  loading: t('Working…', 'کام جاری ہے…', 'Kaam jari hai…'),
  thinking: t('Finding your procedure…', 'آپ کا طریقہ کار تلاش کر رہے ہیں…', 'Aap ka procedure talash kar rahe hain…'),
  errorTitle: t('Something went wrong', 'کچھ غلط ہو گیا', 'Kuch ghalat ho gaya'),
  retry: t('Try again', 'دوبارہ کوشش کریں', 'Dobara koshish karein'),
  startOver: t('Start over', 'دوبارہ شروع کریں', 'Dobara shuru karein'),
  sessionExpired: t(
    'This session has expired. Start a new one.',
    'یہ سیشن ختم ہو چکا ہے۔ نیا شروع کریں۔',
    'Yeh session khatam ho chuka hai. Naya shuru karein.',
  ),
  whichService: t('Which one do you mean?', 'آپ کا مطلب کون سا ہے؟', 'Aap ka matlab kaunsa hai?'),

  /* ── Footer ─────────────────────────────────────────────────────────── */
  disclaimer: t(
    'This is not a government website. It helps you understand official procedures and always links to the official source. Confirm details with the department before acting.',
    'یہ سرکاری ویب سائٹ نہیں ہے۔ یہ سرکاری طریقہ کار سمجھنے میں مدد دیتی ہے اور ہمیشہ سرکاری ذریعے کا لنک دیتی ہے۔ عمل سے پہلے محکمے سے تصدیق کریں۔',
    'Yeh sarkari website nahi hai. Yeh sarkari procedures samajhne mein madad deti hai aur hamesha sarkari zariye ka link deti hai. Amal se pehle mehkme se tasdeeq karein.',
  ),
} as const satisfies Record<string, Dict>;

export type UiKey = keyof typeof UI;

/** Look up an interface string. Falls back to English rather than rendering empty. */
export function ui(key: UiKey, language: Language): string {
  return UI[key][language] || UI[key].en;
}

/** Curried helper for components that render many strings in one language. */
export function translator(language: Language): (key: UiKey) => string {
  return (key) => ui(key, language);
}
