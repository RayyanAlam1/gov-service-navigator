/**
 * Service resolution.
 *
 * The intent agent *proposes* a service. This file *decides* it, by scoring
 * the citizen's words against the alias table in the database. That division
 * is the point: a model asked "which government service is this?" will happily
 * name one that does not exist in our knowledge base, and the citizen would
 * then be walked through a procedure we have no data for.
 *
 * Scoring combines three deterministic signals:
 *
 *   1. Alias match — token and phrase overlap against `service_aliases`,
 *      which carries English, Urdu and Roman-Urdu spellings with weights.
 *   2. Model proposal — the intent agent's candidate, but only as a bonus on
 *      services that already exist, and only enough to break a near-tie.
 *   3. Margin — how far ahead the leader is. A narrow margin does not resolve;
 *      it asks the citizen which one they meant.
 *
 * Below SERVICE_CONFIDENCE_THRESHOLD the resolver returns `needsDisambiguation`
 * with the top candidates rather than guessing. One extra tap costs a second;
 * a wrong service costs a wasted trip to the wrong department.
 */
import { getConfig } from '@/lib/config/env';
import { tokenize, normalizeForSearch } from '@/lib/i18n/normalize';
import type { ServiceAlias } from '@/lib/db/knowledge';
import type { Service } from '@/lib/schemas/domain';

export interface ServiceCandidate {
  serviceCode: string;
  service: Service;
  score: number;
  /** 0..1 relative to the whole candidate set. */
  confidence: number;
  matchedAliases: string[];
  scenarioHints: string[];
  /** Whether the model's proposal contributed. */
  modelProposed: boolean;
}

export interface ServiceResolution {
  resolved: ServiceCandidate | null;
  candidates: ServiceCandidate[];
  needsDisambiguation: boolean;
  /** Plain-language account of the decision, shown in the trace panel. */
  reasoning: string[];
}

export interface ResolveInput {
  query: string;
  services: readonly Service[];
  aliases: readonly ServiceAlias[];
  /** Service codes the intent agent proposed, best first. */
  proposedCodes?: readonly string[];
  /** The intent agent's own confidence in its proposal, 0..1. */
  proposalConfidence?: number;
}

/** Exact phrase hit is worth far more than an incidental token overlap. */
const PHRASE_WEIGHT = 3.0;
const TOKEN_WEIGHT = 1.0;

/**
 * Negation cues, across the three languages.
 *
 * Citizens routinely name a service they do NOT have while asking about one
 * they want: "I need a passport but I don't have a CNIC yet". Counting both
 * mentions equally makes the two services tie, and the resolver then asks a
 * disambiguation question whose answer the citizen already gave in their first
 * sentence.
 */
const NEGATION_CUES: ReadonlySet<string> = new Set([
  'not', 'no', 'dont', 'doesnt', 'didnt', 'cant', 'cannot', 'without', 'lacking', 'missing',
  'nahi', 'nahin', 'nai', 'bagair', 'baghair', 'bina',
  'نہیں', 'بغیر', 'بنا',
]);

/** How many tokens after a negation cue stay inside its scope. */
const NEGATION_WINDOW = 4;

/** Multiplier applied to an alias match that falls inside a negation scope. */
const NEGATION_PENALTY = 0.2;

/**
 * Token positions that sit within the scope of a negation cue.
 *
 * Deliberately a fixed window rather than a parser: it is language-agnostic,
 * it cannot crash on unusual input, and its failure mode is a slightly wrong
 * weight rather than a wrong service.
 */
function negatedPositions(tokens: readonly string[]): Set<number> {
  const negated = new Set<number>();
  tokens.forEach((token, index) => {
    if (!NEGATION_CUES.has(token)) return;
    for (let offset = 1; offset <= NEGATION_WINDOW; offset += 1) {
      if (index + offset < tokens.length) negated.add(index + offset);
    }
  });
  return negated;
}
/**
 * Deliberately modest. The model may nominate a service the citizen never
 * named; it should be able to break a tie, not create a winner from nothing.
 */
const MODEL_BONUS = 1.4;

export function resolveService({
  query,
  services,
  aliases,
  proposedCodes = [],
  proposalConfidence = 0,
}: ResolveInput): ServiceResolution {
  const cfg = getConfig();
  const reasoning: string[] = [];

  const normalizedQuery = normalizeForSearch(query);
  const tokenList = tokenize(query);
  const queryTokens = new Set(tokenList);

  const negated = negatedPositions(tokenList);
  // Position index for each distinct token, so an alias match can be tested
  // against the negation scopes. A token appearing both inside and outside a
  // negation keeps full weight — the affirmative mention wins.
  const affirmativeTokens = new Set(
    tokenList.filter((_, index) => !negated.has(index)),
  );
  const negatedOnly = (token: string) => queryTokens.has(token) && !affirmativeTokens.has(token);

  const byCode = new Map(services.map((s) => [s.code, s] as const));
  const scores = new Map<
    string,
    { score: number; matched: Set<string>; scenarios: Set<string>; modelProposed: boolean }
  >();

  const bump = (code: string, amount: number, alias: string | null, scenario: string | null) => {
    const entry = scores.get(code) ?? {
      score: 0,
      matched: new Set<string>(),
      scenarios: new Set<string>(),
      modelProposed: false,
    };
    entry.score += amount;
    if (alias) entry.matched.add(alias);
    if (scenario) entry.scenarios.add(scenario);
    scores.set(code, entry);
  };

  for (const alias of aliases) {
    if (!byCode.has(alias.serviceCode)) continue;
    const normalizedAlias = normalizeForSearch(alias.alias);
    if (!normalizedAlias) continue;

    const aliasTokens = tokenize(alias.alias);

    // Multi-word alias: require the whole phrase, which is what makes
    // "birth certificate" not score for "certificate".
    if (aliasTokens.length > 1) {
      if (normalizedQuery.includes(normalizedAlias)) {
        const suppressed = aliasTokens.every(negatedOnly);
        bump(
          alias.serviceCode,
          PHRASE_WEIGHT * alias.weight * (suppressed ? NEGATION_PENALTY : 1),
          alias.alias,
          alias.scenarioCode,
        );
      }
      continue;
    }

    const token = aliasTokens[0];
    if (token && queryTokens.has(token)) {
      bump(
        alias.serviceCode,
        TOKEN_WEIGHT * alias.weight * (negatedOnly(token) ? NEGATION_PENALTY : 1),
        alias.alias,
        alias.scenarioCode,
      );
    }
  }

  if (scores.size > 0) {
    reasoning.push(
      `Alias matching found ${scores.size} candidate service(s) from the citizen's own words.`,
    );
  } else {
    reasoning.push('No alias in the knowledge base matched the citizen\'s words.');
  }

  // The model's proposal is applied only to services that actually exist, and
  // scaled by its own confidence so a hesitant guess barely moves the needle.
  for (const [index, code] of proposedCodes.entries()) {
    if (!byCode.has(code)) {
      reasoning.push(`Ignored model proposal '${code}': no such service in the knowledge base.`);
      continue;
    }
    const decay = 1 / (index + 1);
    bump(code, MODEL_BONUS * decay * Math.max(0.2, proposalConfidence), null, null);
    const entry = scores.get(code);
    if (entry) entry.modelProposed = true;
  }

  if (proposedCodes.length > 0) {
    reasoning.push(
      `Model proposed: ${proposedCodes.join(', ')} (confidence ${proposalConfidence.toFixed(2)}), applied as a tie-break only.`,
    );
  }

  const total = [...scores.values()].reduce((sum, e) => sum + e.score, 0);

  const candidates: ServiceCandidate[] = [...scores.entries()]
    .map(([code, entry]) => {
      const service = byCode.get(code);
      if (!service) return null;
      return {
        serviceCode: code,
        service,
        score: entry.score,
        confidence: total > 0 ? entry.score / total : 0,
        matchedAliases: [...entry.matched],
        scenarioHints: [...entry.scenarios],
        modelProposed: entry.modelProposed,
      } satisfies ServiceCandidate;
    })
    .filter((c): c is ServiceCandidate => c !== null)
    .sort((a, b) => b.score - a.score || a.serviceCode.localeCompare(b.serviceCode));

  const leader = candidates[0];
  const runnerUp = candidates[1];

  if (!leader) {
    reasoning.push('No service could be identified. Falling back to asking the citizen directly.');
    return { resolved: null, candidates: [], needsDisambiguation: true, reasoning };
  }

  // Margin matters more than absolute confidence when only two services are in
  // play: 0.51 vs 0.49 is a coin flip dressed up as a decision.
  const margin = runnerUp ? leader.confidence - runnerUp.confidence : leader.confidence;
  const meetsThreshold = leader.confidence >= cfg.SERVICE_CONFIDENCE_THRESHOLD;
  const decisiveMargin = margin >= 0.2;

  if (meetsThreshold && decisiveMargin) {
    reasoning.push(
      `Resolved to '${leader.serviceCode}' at ${(leader.confidence * 100).toFixed(0)}% ` +
        `(margin ${(margin * 100).toFixed(0)} points over the next candidate).`,
    );
    return { resolved: leader, candidates, needsDisambiguation: false, reasoning };
  }

  reasoning.push(
    `Top candidate '${leader.serviceCode}' at ${(leader.confidence * 100).toFixed(0)}% ` +
      `does not clear the ${(cfg.SERVICE_CONFIDENCE_THRESHOLD * 100).toFixed(0)}% threshold ` +
      `or the required margin. Asking the citizen to choose rather than guessing.`,
  );

  return { resolved: null, candidates, needsDisambiguation: true, reasoning };
}

/**
 * Scenario codes the citizen's own words point at.
 *
 * Fed into the interview as *inferred* answers, never as stated ones, so a bad
 * extraction surfaces as a correctable assumption instead of a silent branch.
 */
export function scenarioHintsFor(resolution: ServiceResolution): string[] {
  return resolution.resolved?.scenarioHints ?? [];
}
