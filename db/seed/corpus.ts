/**
 * The retrieval corpus.
 *
 * ── EVERYTHING HERE IS SYNTHETIC ───────────────────────────────────────────
 *
 * These documents were written for this repository. They are not official
 * text, they are not quotations of official text, and they contain no specific
 * fee, deadline or form number. Every document says so in its own first
 * paragraph, so a chunk retrieved out of context still carries the warning.
 *
 * They exist to exercise the pipeline end to end: chunking, embedding, hybrid
 * lexical+vector retrieval, RRF fusion, coverage assessment and the "we could
 * not verify this" fallback. What they describe is the *shape* of each
 * procedure — the kinds of things official guidance addresses — which is
 * enough to test whether retrieval finds the right topic.
 *
 * Every chunk lands with `verification_status = 'synthetic'` and renders with a
 * loud badge. Replace them with real ingested text before this is used for
 * anything a citizen acts on:
 *
 *     npm run ingest -- --url https://www.nadra.gov.pk/identity/ --service cnic
 *
 * Deliberately included: Urdu and Roman-Urdu documents, so cross-language
 * retrieval is exercised rather than assumed. A citizen writing "mera CNIC gum
 * hogya" should reach English guidance about lost cards, and the only way to
 * know that works is to have both in the index.
 */
import type { SeedDocument } from './types';

const DISCLAIMER_EN =
  'This is demonstration text written for the Government Service AI Navigator project. It is not official government guidance and contains no official fees, deadlines or form numbers. Confirm every specific value with the issuing department.';

const DISCLAIMER_UR =
  'یہ متن گورنمنٹ سروس اے آئی نیویگیٹر پروجیکٹ کے لیے لکھا گیا نمونہ ہے۔ یہ سرکاری ہدایت نامہ نہیں ہے اور اس میں کوئی سرکاری فیس، تاریخ یا فارم نمبر شامل نہیں۔ ہر تفصیل متعلقہ محکمے سے تصدیق کریں۔';

export const CORPUS: SeedDocument[] = [
  /* ── CNIC ──────────────────────────────────────────────────────────── */
  {
    sourceCode: 'demo-corpus',
    serviceCode: 'cnic',
    title: 'CNIC — replacement of a lost or stolen card (demonstration text)',
    language: 'en',
    scenarioCode: 'lost',
    body: `${DISCLAIMER_EN}

When a national identity card is lost or stolen, the replacement process differs from a routine renewal. The applicant is not simply updating an existing card; they are asking the authority to invalidate a card that may be in someone else's possession and to issue a fresh one against the same record.

Because of that, the first action is reporting the loss. Applicants are generally expected to report the loss or theft to the police station covering the area where the card went missing, and to obtain a written report. The report establishes the date the loss was noticed and protects the applicant if the missing card is later misused. Registration centres commonly ask to see this report before accepting a replacement application.

The applicant's biometric record already exists in the national database from their previous registration, so identity is confirmed biometrically at the centre rather than by re-submitting childhood registration documents. This is the main practical difference between a lost-card replacement and a first-time application: the family linkage and birth record have already been established.

Applicants who have moved since their card was issued should expect the address on record to be reviewed as part of the application. Bringing evidence of the current address avoids a second visit. The registration centre serving the current address is usually the appropriate one to apply at.

Processing categories and fees are set by the authority and are published on its own fee schedule. Applicants should confirm the current amount and category at the counter or on the official website rather than relying on figures quoted elsewhere, because these change.`,
  },
  {
    sourceCode: 'demo-corpus',
    serviceCode: 'cnic',
    title: 'CNIC — first-time application and family linkage (demonstration text)',
    language: 'en',
    scenarioCode: 'new',
    body: `${DISCLAIMER_EN}

A first national identity card is issued once a citizen reaches the qualifying age. Before that age, the equivalent record is a child registration certificate, commonly called a B-Form, which is what a parent or guardian holds on the child's behalf.

The central requirement of a first-time application is family linkage. The authority's database is organised around family records, so a new adult registration must be connected to an existing parent or guardian record. In practice this means bringing the childhood registration certificate together with a parent's identity card.

Where a parent has died or their record cannot be located, the application does not simply fail. It becomes a special case handled by the registration centre, which may accept guardianship documents, succession certificates or other evidence of lineage. Applicants in this position should raise it at the counter at the start rather than queueing through the standard process, because the documents required are different.

Biometric capture — photograph, fingerprints and signature — happens at the centre and cannot be completed in advance or remotely. The applicant must attend in person.

Eligibility conditions, the accepted evidence of lineage, and the fee categories are all set by the authority and published officially. Confirm them before travelling.`,
  },
  {
    sourceCode: 'demo-corpus',
    serviceCode: 'cnic',
    title: 'CNIC — renewal, damage and correction of particulars (demonstration text)',
    language: 'en',
    scenarioCode: 'renewal',
    body: `${DISCLAIMER_EN}

Identity cards are issued with a validity period, and a card that has passed its expiry date must be renewed before it can be relied on for official purposes. Renewal is a lighter process than a first application, because the underlying record already exists and only needs to be refreshed.

The previous card should be brought to the centre even when it is expired or physically damaged. It is the simplest way for the counter to locate the record, and damaged cards are usually surrendered when the replacement is issued.

Correction of particulars is a separate category from renewal. Changing a recorded detail — a date of birth, a spelling, a name after marriage — requires documentary evidence of the corrected value, not merely a request. What counts as sufficient evidence depends on which field is being changed, so applicants should establish that before assembling documents.

An applicant whose current address differs from the address on record should bring evidence of where they now live. The address is part of the record, and updating it is normally handled within the same application rather than separately.

Processing time depends on the category selected. Categories, their fees and their published timelines are set by the authority; confirm the current position officially.`,
  },
  {
    sourceCode: 'demo-corpus',
    serviceCode: 'cnic',
    title: 'شناختی کارڈ — گم شدہ کارڈ کا متبادل (نمونہ متن)',
    language: 'ur',
    scenarioCode: 'lost',
    body: `${DISCLAIMER_UR}

شناختی کارڈ گم یا چوری ہو جائے تو متبادل کارڈ کا طریقہ کار عام تجدید سے مختلف ہوتا ہے۔ پہلا قدم گمشدگی کی اطلاع دینا ہے۔ عام طور پر درخواست گزار سے توقع کی جاتی ہے کہ وہ اس علاقے کے تھانے میں اطلاع درج کروائے جہاں کارڈ گم ہوا، اور تحریری رپورٹ حاصل کرے۔

یہ رپورٹ اس تاریخ کا ریکارڈ بناتی ہے جب گمشدگی کا علم ہوا، اور اگر بعد میں گم شدہ کارڈ کا غلط استعمال ہو تو درخواست گزار کو تحفظ دیتی ہے۔ رجسٹریشن سینٹر عام طور پر متبادل کی درخواست قبول کرنے سے پہلے یہ رپورٹ دیکھنا چاہتے ہیں۔

درخواست گزار کا بایومیٹرک ریکارڈ پہلے سے قومی ڈیٹابیس میں موجود ہوتا ہے، اس لیے شناخت بایومیٹرک طریقے سے تصدیق ہوتی ہے اور بچپن کی رجسٹریشن دستاویزات دوبارہ جمع کروانے کی ضرورت نہیں ہوتی۔

اگر کارڈ جاری ہونے کے بعد آپ کا پتہ تبدیل ہوا ہے تو موجودہ پتے کا ثبوت ساتھ لے جائیں تاکہ دوبارہ چکر نہ لگانا پڑے۔

فیس اور کیٹیگریز متعلقہ ادارہ مقرر کرتا ہے اور اپنے سرکاری فیس شیڈول میں شائع کرتا ہے۔ موجودہ رقم کاؤنٹر یا سرکاری ویب سائٹ سے تصدیق کریں۔`,
  },
  {
    sourceCode: 'demo-corpus',
    serviceCode: 'cnic',
    title: 'CNIC gum ho jaye to kya karein (namoona matn)',
    language: 'roman_ur',
    scenarioCode: 'lost',
    body: `Yeh matn Government Service AI Navigator project ke liye likha gaya namoona hai. Yeh sarkari hidayat nama nahi hai aur is mein koi sarkari fees, tareekh ya form number shamil nahi. Har tafseel mutalliqa mehkme se tasdeeq karein.

Agar aap ka shanakhti card gum ho jaye ya chori ho jaye, to sab se pehle police ko report karwana hota hai. Us ilaqe ke thane jayein jahan card gum hua aur tehreeri report ya FIR hasil karein. Registration centre aam tor par replacement ki darkhast qubool karne se pehle yeh report dekhna chahte hain.

Aap ka biometric record pehle se database mein mojood hota hai, is liye shanakht biometric tareeqe se hoti hai. Bachpan ke registration documents dobara jama karwane ki zaroorat nahi hoti — yeh lost card aur pehli baar ki darkhast mein sab se bara farq hai.

Agar card banne ke baad aap ka pata badal gaya hai, to mojooda patay ka saboot bhi sath le jayein. Aam tor par usi ilaqe ka centre munasib hota hai jahan aap ab rehte hain.

Fees aur processing categories idara khud muqarrar karta hai. Mojooda raqam counter par ya sarkari website se tasdeeq karein, kyunke yeh waqtan fawaqtan badalti rehti hai.`,
  },

  /* ── Passport ──────────────────────────────────────────────────────── */
  {
    sourceCode: 'demo-corpus',
    serviceCode: 'passport',
    title: 'Passport — application route and required identity documents (demonstration text)',
    language: 'en',
    scenarioCode: null,
    body: `${DISCLAIMER_EN}

A Pakistani passport is issued on the basis of an existing national identity record. An adult applicant must therefore already hold a valid identity card before applying; the passport record is built from it, and an application cannot proceed without it. Applicants who do not yet have an identity card should complete that process first.

For an applicant under the qualifying age, the child registration certificate takes the place of the identity card, and a parent or guardian must attend with their own identity document.

The department operates an official online application portal. Where the portal is available for the applicant's category, starting the application there is the intended route. No third party can submit an application on an applicant's behalf through that portal — the applicant completes it themselves, and any service claiming otherwise should be treated with suspicion.

Biometric capture is completed in person at a passport office regardless of how the application was started. Original documents are verified at that appointment, so photocopies alone are not sufficient.

Renewal requires the previous booklet, which is cancelled and either returned or retained. A lost passport is treated differently from a renewal: a police report for the loss is normally required, because a passport in circulation is a travel document that could be misused.

Fee categories vary by booklet size, validity period and processing speed. The department publishes its own schedule; confirm the applicable category and amount there.`,
  },
  {
    sourceCode: 'demo-corpus',
    serviceCode: 'passport',
    title: 'Passport — applying from outside Pakistan (demonstration text)',
    language: 'en',
    scenarioCode: null,
    body: `${DISCLAIMER_EN}

Applicants who are outside Pakistan do not use the domestic passport offices. Applications from abroad are handled through Pakistani diplomatic missions — embassies, high commissions and consulates — and each mission operates its own appointment system and local procedure.

This matters practically, because the document list and the payment method can both differ from the domestic process. An applicant abroad should contact their nearest mission directly rather than assuming the domestic requirements apply.

Overseas Pakistanis also hold a different identity product from the standard national identity card. Which identity document is required for a passport application from abroad depends on the applicant's status, and the mission is the correct authority to confirm this.

Processing times for applications submitted abroad are affected by the mission's own workload and by document transit, so they are not comparable with domestic timelines.`,
  },

  /* ── Domicile ──────────────────────────────────────────────────────── */
  {
    sourceCode: 'demo-corpus',
    serviceCode: 'domicile',
    title: 'Domicile — district jurisdiction and evidence of residence (demonstration text)',
    language: 'en',
    scenarioCode: null,
    body: `${DISCLAIMER_EN}

A domicile certificate records permanent residence in a specific district. It is issued by the district administration, not by a national authority, and this is the single most important thing for an applicant to understand: the form, the accepted evidence, the fee and the processing time are all set at district level and genuinely differ from one district to another.

Guidance that presents a single national domicile procedure is therefore misleading. An applicant should treat any general checklist as an indication of shape and confirm the specifics with the office they will actually apply at.

Domicile is normally claimed on one of three bases: the applicant's own sustained residence in the district, their father's domicile, or marriage. Which basis is claimed changes the supporting documents entirely, so it should be settled before any documents are gathered.

Where residence is the basis, offices generally expect evidence that the applicant has lived in the district for a sustained period rather than recently arrived. The minimum period and the acceptable forms of evidence are district matters.

A sworn affidavit of residence on stamp paper is commonly part of the application. Verification of the residence claim usually follows submission and may involve a local enquiry, so applicants should give contact details they will actually answer.

A citizen holds a domicile for one district only. Someone who already holds a certificate for a different district is dealing with a transfer, which is a distinct process, rather than a fresh application.`,
  },
  {
    sourceCode: 'demo-corpus',
    serviceCode: 'domicile',
    title: 'ڈومیسائل — ضلعی دائرہ اختیار اور رہائش کا ثبوت (نمونہ متن)',
    language: 'ur',
    scenarioCode: null,
    body: `${DISCLAIMER_UR}

ڈومیسائل سرٹیفکیٹ کسی مخصوص ضلع میں مستقل رہائش کا ریکارڈ ہے۔ یہ ضلعی انتظامیہ جاری کرتی ہے، کسی قومی ادارے سے نہیں۔ یہی سب سے اہم بات ہے: فارم، قابلِ قبول ثبوت، فیس اور دورانیہ سب ضلعی سطح پر طے ہوتے ہیں اور ایک ضلع سے دوسرے ضلع میں مختلف ہوتے ہیں۔

اس لیے وہ ہدایات جو ایک ہی قومی طریقہ کار پیش کریں، گمراہ کن ہوتی ہیں۔ درخواست گزار کو عمومی فہرست کو صرف ایک خاکہ سمجھنا چاہیے اور تفصیلات اسی دفتر سے تصدیق کرنی چاہئیں جہاں درخواست دینی ہے۔

ڈومیسائل عام طور پر تین بنیادوں میں سے کسی ایک پر مانگا جاتا ہے: درخواست گزار کی اپنی مسلسل رہائش، والد کا ڈومیسائل، یا شادی۔ بنیاد بدلنے سے مطلوبہ دستاویزات مکمل طور پر بدل جاتی ہیں۔

اسٹامپ پیپر پر رہائش کا حلف نامہ عام طور پر درخواست کا حصہ ہوتا ہے۔ جمع کروانے کے بعد رہائش کی تصدیق ہوتی ہے، جس میں مقامی تحقیقات شامل ہو سکتی ہے۔

ایک شہری کا ڈومیسائل صرف ایک ضلع کا ہوتا ہے۔ اگر پہلے سے کسی اور ضلع کا ڈومیسائل موجود ہے تو یہ منتقلی کا معاملہ ہے، نئی درخواست کا نہیں۔`,
  },

  /* ── Cross-service ─────────────────────────────────────────────────── */
  {
    sourceCode: 'demo-corpus',
    serviceCode: null,
    title: 'General — address mismatch and jurisdiction (demonstration text)',
    language: 'en',
    scenarioCode: null,
    body: `${DISCLAIMER_EN}

A recurring source of wasted trips is a mismatch between where a citizen actually lives and the address recorded on their identity documents. Internal migration is common, and records are often years out of date.

The practical consequences are consistent across services. First, the office with jurisdiction is usually the one serving the current address, not the one named on the old document. Second, additional evidence of the current address is normally required, because the department is being asked to change a recorded fact rather than simply reprint it. Third, the address update is generally handled within the same application rather than as a separate errand.

Citizens in this position should establish which office has jurisdiction before travelling, and should bring evidence of the current address even when the checklist for their service does not obviously call for it.

A related case is the applicant whose documents disagree with each other — a name spelled differently across two records, or a date of birth that does not match. These are resolved by correcting the underlying record, not by proceeding with the mismatched documents and hoping the counter accepts them.`,
  },
  {
    sourceCode: 'demo-corpus',
    serviceCode: null,
    title: 'General — what to bring and what to expect at a counter (demonstration text)',
    language: 'en',
    scenarioCode: null,
    body: `${DISCLAIMER_EN}

Applicants are generally expected to bring original documents, not only photocopies. Counters verify against the original even when they keep a copy for the file, so arriving with copies alone is one of the most common reasons an application is turned away on the day.

Where a document is required in duplicate, the number of copies is set by the department and stated on its own guidance. An applicant who is unsure should bring more copies rather than fewer; copies are cheap and a return trip is not.

Biometric capture — photograph, fingerprints and signature — is done in person and cannot be delegated. This is why no online route fully replaces attendance for identity documents, even where an application can be started online.

Every application generates an acknowledgement or receipt carrying a tracking reference. This should be kept: it is how progress is followed, and it is normally required to collect the finished document.

Fees, processing categories and published timelines change. They are set by the issuing department and published officially, and any figure obtained from a third party should be treated as out of date until confirmed.`,
  },
];
