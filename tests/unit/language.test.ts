import { describe, expect, it } from 'vitest';
import { detectLanguage, resolveSessionLanguage } from '@/lib/i18n/detect';
import { normalizeForSearch, tokenize, urduScriptRatio } from '@/lib/i18n/normalize';

describe('detectLanguage', () => {
  it('detects the canonical demo query as Roman Urdu', () => {
    // The scenario the whole product is pitched on. If this regresses, the
    // demo opens on the wrong language.
    const d = detectLanguage('mera CNIC gum hogya hai, Karachi mein hun. ab kya karna hai?');
    expect(d.language).toBe('roman_ur');
    expect(d.confidence).toBeGreaterThan(0.6);
  });

  it('detects Urdu script even when Latin proper nouns are mixed in', () => {
    const d = detectLanguage('میرا CNIC گم ہو گیا ہے، میں کراچی میں ہوں');
    expect(d.language).toBe('ur');
    expect(d.confidence).toBeGreaterThan(0.7);
  });

  it('detects plain English', () => {
    const d = detectLanguage('I lost my CNIC and I need to know what documents are required.');
    expect(d.language).toBe('en');
  });

  it('does not mistake English for Roman Urdu on shared short words', () => {
    // "to", "ka" style collisions are the main false-positive risk.
    const d = detectLanguage('How do I apply for a new passport and what is the fee?');
    expect(d.language).toBe('en');
  });

  it('handles heavy code-mixing by weighting function words', () => {
    const d = detectLanguage('passport renew karwana hai, documents kya chahiye?');
    expect(d.language).toBe('roman_ur');
  });

  it('falls back to English on marker-free input without pretending to be confident', () => {
    const d = detectLanguage('CNIC renewal');
    expect(d.language).toBe('en');
    expect(d.confidence).toBeLessThan(0.5);
  });

  it('never throws on empty or symbolic input', () => {
    expect(detectLanguage('').language).toBe('en');
    expect(detectLanguage('!!! ??? 123').language).toBe('en');
  });
});

describe('resolveSessionLanguage', () => {
  it('an explicit choice always wins', () => {
    const d = detectLanguage('mera CNIC gum hogya hai');
    const r = resolveSessionLanguage(d, 'en', 'ur');
    expect(r.language).toBe('ur');
    expect(r.changed).toBe(true);
  });

  it('does not re-language the session on a weak one-word reply', () => {
    // A citizen who picked English then types "haan" keeps English.
    const d = detectLanguage('haan');
    const r = resolveSessionLanguage(d, 'en', null);
    expect(r.language).toBe(d.confidence < 0.5 ? 'en' : d.language);
  });

  it('switches when detection is confident', () => {
    const d = detectLanguage('mujhe apna domicile banwana hai, kya documents chahiye');
    const r = resolveSessionLanguage(d, 'en', null);
    expect(r.language).toBe('roman_ur');
    expect(r.changed).toBe(true);
  });
});

describe('normalizeForSearch', () => {
  it('collapses Arabic and Urdu codepoint variants of the same letter', () => {
    // An official PDF may use ي where a citizen types ی; without folding they
    // never match in the lexical arm.
    expect(normalizeForSearch('يہ')).toBe(normalizeForSearch('یہ'));
    expect(normalizeForSearch('كراچی')).toBe(normalizeForSearch('کراچی'));
  });

  it('maps Arabic-Indic digits to ASCII', () => {
    expect(normalizeForSearch('۱۲۳')).toBe('123');
    expect(normalizeForSearch('٤٥٦')).toBe('456');
  });

  it('strips diacritics and punctuation, lowercases Latin', () => {
    expect(normalizeForSearch('Mera CNIC, gum ho-gya!')).toBe('mera cnic gum ho gya');
  });

  it('is idempotent', () => {
    const once = normalizeForSearch('میرا CNIC گم ہو گیا ہے۔');
    expect(normalizeForSearch(once)).toBe(once);
  });

  it('collapses runs of three or more identical letters down to two', () => {
    // Doubling is meaningful in Roman Urdu ("aap"), so two survives and only
    // longer runs are folded.
    expect(normalizeForSearch('helllllo')).toBe('hello');
    expect(normalizeForSearch('aap')).toBe('aap');
    expect(normalizeForSearch('aaap')).toBe('aap');
  });
});

describe('urduScriptRatio', () => {
  it('is 0 for pure Latin and near 1 for pure Urdu', () => {
    expect(urduScriptRatio('hello world')).toBe(0);
    expect(urduScriptRatio('میرا شناختی کارڈ')).toBeGreaterThan(0.9);
  });

  it('is fractional for mixed text', () => {
    const r = urduScriptRatio('میرا CNIC');
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });
});

describe('tokenize', () => {
  it('splits on punctuation and whitespace', () => {
    expect(tokenize('mera CNIC gum hogya hai, ab kya karna hai?')).toEqual([
      'mera', 'cnic', 'gum', 'hogya', 'hai', 'ab', 'kya', 'karna', 'hai',
    ]);
  });

  it('returns an empty array rather than [""] for empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});
