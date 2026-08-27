/**
 * Language detection: English / Urdu / Roman Urdu.
 *
 * Deterministic and offline. A model is never asked "what language is this?"
 * for three reasons: script detection is a solved problem that regex does
 * perfectly, a network round-trip before the first useful work is the most
 * visible latency in the whole product, and detection has to keep working when
 * the provider is down.
 *
 * The hard case is Roman Urdu, which is Latin script and therefore looks like
 * English to a naive detector. It is separated by lexicon: Roman Urdu has a
 * small, extremely high-frequency function-word core (hai, mera, kya, ko,
 * mein, nahi) that essentially never appears in English text. Matching on
 * function words rather than content words is what makes this robust to
 * code-mixing, which is how people actually write:
 *
 *     "mera CNIC gum hogya hai, Karachi mein hun, ab kya karna hai?"
 *      ^^^^      ^^^ ^^^^^ ^^^          ^^^^ ^^^      ^^^ ^^^^^ ^^^
 */
import type { Language } from '@/lib/schemas/core';
import { tokenize, urduScriptRatio } from './normalize';

/**
 * Roman Urdu function words and extremely common verbs/pronouns.
 *
 * Curated to avoid collisions with English. Words like "main" (I) are excluded
 * because English "main" is common; "mein"/"mai" carry the same signal without
 * the ambiguity. "so", "to", "he", "in", "is", "are" are excluded for the same
 * reason even though they exist in Roman Urdu transliteration.
 */
const ROMAN_URDU_MARKERS: ReadonlySet<string> = new Set([
  // pronouns & possessives
  'mera', 'meri', 'mere', 'mujhe', 'mujhay', 'mujh', 'hamara', 'hamari', 'humara', 'humari',
  'aap', 'apka', 'apki', 'apna', 'apni', 'apne', 'tumhara', 'tumhari', 'unka', 'unki', 'uska', 'uski',
  'hum', 'ham', 'tum', 'yeh', 'yah', 'woh', 'wo', 'kisi', 'kuch', 'sab',
  // copulas & auxiliaries
  'hai', 'hain', 'hay', 'hun', 'hoon', 'ho', 'tha', 'thi', 'thay', 'the', 'raha', 'rahi', 'rahe',
  'gaya', 'gya', 'gayi', 'gyi', 'hogya', 'hogaya', 'hogyi', 'hogayi', 'huwa', 'hua', 'hui',
  'chahiye', 'chahiy', 'chaiye', 'sakta', 'sakti', 'sakte', 'karna', 'karni', 'karne', 'karo',
  'kiya', 'kia', 'karta', 'karti', 'karte', 'karwana', 'banwana', 'banwani', 'banana', 'bnwana',
  // question words
  'kya', 'kia', 'kaise', 'kese', 'kaisay', 'kahan', 'kahaan', 'kab', 'kyun', 'kyu', 'kiun', 'kon', 'kaun',
  'kitna', 'kitni', 'kitne', 'konsa', 'kaunsa',
  // postpositions & connectives
  'mein', 'mai', 'ka', 'ki', 'ke', 'ko', 'se', 'par', 'pe', 'tak', 'aur', 'ya', 'lekin', 'magar',
  'phir', 'abhi', 'ab', 'bhi', 'hi', 'agar', 'jab', 'to', 'liye', 'liay', 'wala', 'wali', 'walay', 'wale',
  // negation & affirmation
  'nahi', 'nahin', 'nai', 'na', 'haan', 'han', 'ji', 'bilkul',
  // domain-frequent
  'gum', 'khoya', 'kho', 'chori', 'purana', 'purani', 'naya', 'nayi', 'jaldi', 'zaroori',
  'shanakhti', 'sanad', 'darkhast', 'daftar', 'fees', 'kaghaz', 'dastavez', 'dastawez',
  'banwao', 'banwaana', 'lagta', 'lagti', 'milega', 'milegi', 'jana', 'jaana', 'jaunga', 'jaon',
]);

/**
 * English function words. A high count here beats a stray Roman-Urdu match on
 * a word like "to" or "the" that survived curation.
 */
const ENGLISH_MARKERS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'has', 'need', 'want',
  'what', 'where', 'when', 'which', 'how', 'why', 'can', 'should', 'would', 'could',
  'my', 'your', 'our', 'their', 'his', 'her', 'its', 'about', 'into', 'been', 'was', 'were',
  'apply', 'application', 'renew', 'renewal', 'lost', 'documents', 'required', 'office',
  'please', 'help', 'get', 'make', 'take', 'there', 'here', 'they', 'them',
]);

export interface LanguageDetection {
  language: Language;
  confidence: number;
  /** Human-readable evidence, shown in the trace panel. */
  signals: string[];
  scores: Record<Language, number>;
}

/** Below this, the caller should keep the session's existing language rather than switch. */
export const LANGUAGE_CONFIDENCE_FLOOR = 0.5;

/**
 * Detect the language of a citizen's message.
 *
 * Urdu script wins outright above a low threshold — a message with any
 * meaningful amount of Arabic script is Urdu even if it also contains
 * "CNIC" and "Karachi", which are written in Latin by everyone.
 */
export function detectLanguage(input: string): LanguageDetection {
  const text = (input ?? '').trim();

  if (text.length === 0) {
    return {
      language: 'en',
      confidence: 0,
      signals: ['empty input'],
      scores: { en: 0, ur: 0, roman_ur: 0 },
    };
  }

  const scriptRatio = urduScriptRatio(text);
  if (scriptRatio >= 0.25) {
    return {
      language: 'ur',
      confidence: Math.min(1, 0.7 + scriptRatio * 0.3),
      signals: [`${Math.round(scriptRatio * 100)}% of letters are in Arabic script`],
      scores: { en: 0, ur: scriptRatio, roman_ur: 0 },
    };
  }

  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return {
      language: 'en',
      confidence: 0.2,
      signals: ['no alphabetic tokens'],
      scores: { en: 0, ur: 0, roman_ur: 0 },
    };
  }

  const romanHits = tokens.filter((t) => ROMAN_URDU_MARKERS.has(t));
  const englishHits = tokens.filter((t) => ENGLISH_MARKERS.has(t));

  const romanRatio = romanHits.length / tokens.length;
  const englishRatio = englishHits.length / tokens.length;

  const signals: string[] = [];
  if (scriptRatio > 0) signals.push(`${Math.round(scriptRatio * 100)}% Arabic script`);
  if (romanHits.length > 0) signals.push(`Roman Urdu markers: ${unique(romanHits).slice(0, 6).join(', ')}`);
  if (englishHits.length > 0) signals.push(`English markers: ${unique(englishHits).slice(0, 6).join(', ')}`);

  const scores: Record<Language, number> = {
    ur: scriptRatio,
    roman_ur: romanRatio,
    en: englishRatio,
  };

  // Two independent Roman-Urdu function words is a strong signal even in a
  // long, otherwise-English sentence, because code-mixing goes that way and
  // not the other: English speakers do not sprinkle "hogya" into their text.
  const romanWins =
    romanHits.length >= 2 ? romanRatio >= englishRatio * 0.6 : romanRatio > englishRatio && romanHits.length >= 1;

  // Confidence must reflect how much evidence there was, not just the ratio of
  // it. "CNIC renewal" is 100% English markers by ratio and almost no evidence
  // at all — it is equally what an Urdu speaker types, because those two words
  // have no Urdu spelling. Reporting 1.0 there would let a two-word reply
  // re-language a session the citizen had already set, silently switching the
  // interface out from under them.
  const evidenceCap = confidenceCeiling(romanHits.length + englishHits.length);
  if (evidenceCap < 1) {
    signals.push(`thin evidence (${romanHits.length + englishHits.length} marker word(s)); confidence capped`);
  }

  if (romanWins) {
    const raw = clamp(0.45 + romanRatio * 1.6 + Math.min(romanHits.length, 4) * 0.06);
    return { language: 'roman_ur', confidence: Math.min(raw, evidenceCap), signals, scores };
  }

  if (englishHits.length === 0 && romanHits.length === 0) {
    // Marker-free input ("CNIC", "passport"). English is the safe default: it
    // is the pivot language the rules are authored in, and the citizen can
    // switch with one tap without losing a single answer.
    signals.push('no language markers; defaulting to English');
    return { language: 'en', confidence: 0.3, signals, scores };
  }

  return {
    language: 'en',
    confidence: Math.min(clamp(0.5 + englishRatio * 1.2), evidenceCap),
    signals,
    scores,
  };
}

/**
 * Ceiling on reported confidence given how many marker words were seen.
 *
 * One marker word tops out below LANGUAGE_CONFIDENCE_FLOOR, so a short reply
 * can never flip an established session language on its own.
 */
function confidenceCeiling(markerCount: number): number {
  if (markerCount <= 0) return 0.3;
  if (markerCount === 1) return 0.45;
  if (markerCount === 2) return 0.7;
  return 1;
}

/**
 * Decide the session's language after a new message.
 *
 * Language is a *display* property of a session, not its identity: a citizen
 * who switches to Urdu mid-interview keeps every answer. This also refuses to
 * flip on weak evidence — a one-word reply ("haan") should not re-language the
 * whole session away from what the citizen explicitly chose.
 */
export function resolveSessionLanguage(
  detection: LanguageDetection,
  current: Language,
  explicitChoice: Language | null,
): { language: Language; changed: boolean; reason: string } {
  if (explicitChoice) {
    return {
      language: explicitChoice,
      changed: explicitChoice !== current,
      reason: 'citizen selected this language explicitly',
    };
  }
  if (detection.confidence < LANGUAGE_CONFIDENCE_FLOOR) {
    return { language: current, changed: false, reason: 'detection confidence below floor; keeping current language' };
  }
  if (detection.language === current) {
    return { language: current, changed: false, reason: 'detected language matches current' };
  }
  return {
    language: detection.language,
    changed: true,
    reason: `detected ${detection.language} at ${detection.confidence.toFixed(2)} confidence`,
  };
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}
