#!/usr/bin/env tsx
/**
 * The ingestion pipeline: official document -> cleaned text -> chunks ->
 * embeddings -> retrievable, sourced evidence.
 *
 *   npm run ingest -- --url https://www.nadra.gov.pk/identity/ --service cnic \
 *                     --source nadra-cnic-overview
 *   npm run ingest -- --file ./notices/fee-schedule.txt --service passport \
 *                     --source dgip-fees --title "Fee schedule 2026"
 *   npm run ingest -- --file ./notice.txt --source my-source --verified
 *
 * This is how the demo corpus gets replaced with real official text. Every
 * ingested chunk inherits its source's provenance, so material fetched from a
 * real government page renders with that page's title, publisher and
 * last-verified date attached — which is the entire mechanism behind the
 * product's trust claim.
 *
 * `--verified` marks the source as human-confirmed AS OF NOW. Use it only when
 * you have actually read the page and confirmed the facts you are relying on.
 * It is the one flag in this repository that can turn an unverified claim into
 * an authoritative-looking one, so it is deliberately explicit and never
 * implied by anything else.
 */
import './_env';

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getConfig } from '@/lib/config/env';
import { closeDb, sql, toVectorLiteral } from '@/lib/db/client';
import { getServiceByCode } from '@/lib/db/knowledge';
import { getEmbeddingProvider } from '@/lib/embeddings';
import { chunkText } from '@/lib/rag/chunk';
import type { Language } from '@/lib/schemas/core';

const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  const next = index >= 0 ? args[index + 1] : undefined;
  return next && !next.startsWith('--') ? next : undefined;
};

/* ── HTML → text ──────────────────────────────────────────────────────────
 * Deliberately dependency-free. A full DOM parser buys very little here:
 * government pages are mostly headings and paragraphs, and what actually
 * matters is stripping navigation and script content so they do not pollute
 * the index with menu items that match every query.
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove anything that is not prose.
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Preserve block structure as blank lines so the chunker can see paragraphs.
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n• ');
  text = text.replace(/<h([1-6])\b[^>]*>/gi, '\n\n');

  text = text.replace(/<[^>]+>/g, ' ');

  // Entities that actually appear in government HTML.
  const entities: Record<string, string> = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&apos;': "'", '&rsquo;': '’', '&lsquo;': '‘',
    '&ldquo;': '“', '&rdquo;': '”', '&ndash;': '–', '&mdash;': '—',
  };
  text = text.replace(/&[a-z#0-9]+;/gi, (entity) => entities[entity.toLowerCase()] ?? ' ');

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleFromHtml(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? htmlToText(match[1]).trim() || null : null;
}

/** Urdu-script share decides the stored language, which drives lexical folding. */
function detectDocumentLanguage(text: string): Language {
  const urdu = text.match(/[؀-ۿ]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  if (urdu + latin === 0) return 'en';
  return urdu / (urdu + latin) > 0.3 ? 'ur' : 'en';
}

/* ── Fetching ─────────────────────────────────────────────────────────── */

async function fetchUrl(url: string): Promise<{ text: string; title: string | null }> {
  const cfg = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(30_000, cfg.LLM_TIMEOUT_MS));

  try {
    const response = await fetch(url, {
      headers: {
        // Identify the crawler honestly. A government site operator should be
        // able to tell what this is and contact someone about it.
        'user-agent':
          'GovServiceNavigator/1.0 (+https://github.com/; citizen-service research prototype)',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();

    if (contentType.includes('application/pdf') || body.startsWith('%PDF')) {
      throw new Error(
        'This URL serves a PDF. Extract its text first (e.g. `pdftotext -layout file.pdf out.txt`) ' +
          'and ingest with --file, so the extraction is reviewable rather than silent.',
      );
    }

    const isHtml = contentType.includes('html') || /<html[\s>]/i.test(body);
    return { text: isHtml ? htmlToText(body) : body, title: isHtml ? titleFromHtml(body) : null };
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Main ─────────────────────────────────────────────────────────────── */

function usage(requested: boolean): never {
  console.log(`
Ingest an official document into the retrieval corpus.

  --url <url>          fetch and extract an HTML page
  --file <path>        read a local text file
  --source <code>      REQUIRED. Source code from db/seed/sources.ts, or a new
                       one to create. Provenance flows from here to every chunk.
  --service <code>     scope the chunks to one service (cnic | passport | domicile)
  --scenario <code>    scope further to one scenario branch
  --title "<title>"    document title; defaults to the page title or filename
  --publisher "<name>" publisher for a newly created source
  --verified           mark the source human-verified AS OF NOW. Only use this
                       when you have actually read and confirmed the content.
  --replace            delete previously ingested chunks for this source first
  --dry-run            extract and chunk, but write nothing

Examples
  npm run ingest -- --url https://www.nadra.gov.pk/identity/ --source nadra-cnic-overview --service cnic
  npm run ingest -- --file ./fee-notice.txt --source dgip-fees --service passport --verified
`);
  // Asking for help is a success; being shown help because you got the
  // invocation wrong is not.
  process.exit(requested ? 0 : 1);
}

async function main(): Promise<void> {
  if (has('help') || args.length === 0) usage(true);

  const url = value('url');
  const file = value('file');
  const sourceCode = value('source');
  const serviceCode = value('service');
  const scenarioCode = value('scenario');
  const explicitTitle = value('title');
  const publisher = value('publisher');
  const verified = has('verified');
  const replace = has('replace');
  const dryRun = has('dry-run');

  if (!sourceCode) {
    console.error('✖ --source is required. Every chunk must carry provenance.');
    process.exitCode = 1;
    return;
  }
  if (!url && !file) {
    console.error('✖ Provide either --url or --file.');
    process.exitCode = 1;
    return;
  }

  // ── Extract ──
  let text: string;
  let derivedTitle: string | null = null;

  if (url) {
    console.log(`▸ fetching ${url}`);
    const fetched = await fetchUrl(url);
    text = fetched.text;
    derivedTitle = fetched.title;
  } else {
    const full = path.resolve(process.cwd(), file as string);
    console.log(`▸ reading ${path.relative(process.cwd(), full)}`);
    const raw = await readFile(full, 'utf8');
    text = /<html[\s>]/i.test(raw) ? htmlToText(raw) : raw;
    derivedTitle = path.basename(full, path.extname(full));
  }

  text = text.trim();
  if (text.length < 200) {
    console.error(
      `✖ Extracted only ${text.length} characters. That is almost certainly a failed extraction ` +
        `(a JavaScript-rendered page, or a login wall). Nothing was written.`,
    );
    process.exitCode = 1;
    return;
  }

  const title = explicitTitle ?? derivedTitle ?? sourceCode;
  const language = detectDocumentLanguage(text);
  const chunks = chunkText(text);

  console.log(
    `  ✓ ${text.length.toLocaleString()} chars, language=${language}, ${chunks.length} chunks`,
  );

  if (dryRun) {
    console.log('\n▸ --dry-run: first two chunks\n');
    for (const chunk of chunks.slice(0, 2)) {
      console.log(`  [${chunk.index}] ${chunk.headingPath ?? '(no heading)'} — ${chunk.tokenEstimate} tokens`);
      console.log(`  ${chunk.content.slice(0, 300).replace(/\n/g, ' ')}…\n`);
    }
    return;
  }

  // ── Source ──
  const [source] = await sql<{ id: number; verification_status: string }>(
    `INSERT INTO sources (code, title, publisher, url, doc_type, language,
                          retrieved_at, last_verified, verification_status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9)
     ON CONFLICT (code) DO UPDATE SET
       title = COALESCE(NULLIF(EXCLUDED.title, ''), sources.title),
       url = COALESCE(EXCLUDED.url, sources.url),
       retrieved_at = NOW(),
       last_verified = COALESCE(EXCLUDED.last_verified, sources.last_verified),
       verification_status = CASE
         WHEN $8 = 'verified' THEN 'verified'::verification_status
         ELSE sources.verification_status
       END
     RETURNING id, verification_status`,
    [
      sourceCode,
      title,
      publisher ?? 'Unknown publisher',
      url ?? null,
      url ? 'web' : 'pdf',
      language,
      verified ? new Date().toISOString() : null,
      verified ? 'verified' : 'unverified',
      verified
        ? `Human-verified on ${new Date().toISOString().slice(0, 10)} via npm run ingest --verified.`
        : 'Ingested but not human-verified. TODO(source): confirm the claims relied upon.',
    ],
  );

  const sourceId = source?.id;
  if (sourceId === undefined) throw new Error('failed to upsert source');

  const service = serviceCode ? await getServiceByCode(serviceCode) : null;
  if (serviceCode && !service) {
    console.error(`✖ Unknown service '${serviceCode}'.`);
    process.exitCode = 1;
    return;
  }

  if (replace) {
    const removed = await sql<{ id: number }>(
      'DELETE FROM documents WHERE source_id = $1 RETURNING id',
      [sourceId],
    );
    console.log(`  · --replace: removed ${removed.length} previously ingested document(s)`);
  }

  // ── Store ──
  const hash = createHash('sha256').update(text).digest('hex');

  const [document] = await sql<{ id: number }>(
    `INSERT INTO documents (source_id, service_id, title, language, raw_text_hash, char_count, chunk_count, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (source_id, raw_text_hash) DO UPDATE SET
       title = EXCLUDED.title, chunk_count = EXCLUDED.chunk_count, ingested_at = NOW()
     RETURNING id`,
    [
      sourceId,
      service?.id ?? null,
      title,
      language,
      hash,
      text.length,
      chunks.length,
      JSON.stringify({ ingestedFrom: url ?? file, scenarioCode: scenarioCode ?? null }),
    ],
  );

  const documentId = document?.id;
  if (documentId === undefined) throw new Error('failed to upsert document');

  await sql('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);

  console.log('▸ embedding…');
  const provider = getEmbeddingProvider();
  const vectors = await provider.embedPassages(chunks.map((c) => c.content));

  for (const [index, chunk] of chunks.entries()) {
    const vector = vectors[index];
    await sql(
      `INSERT INTO document_chunks
         (document_id, source_id, service_id, scenario_code, chunk_index, heading_path,
          content, content_norm, language, token_estimate, embedding, embedding_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${vector ? '$11::vector' : 'NULL'},${vector ? '$12' : 'NULL'})`,
      vector
        ? [
            documentId, sourceId, service?.id ?? null, scenarioCode ?? null, chunk.index,
            chunk.headingPath, chunk.content, chunk.contentNorm, language,
            chunk.tokenEstimate, toVectorLiteral(vector), provider.model,
          ]
        : [
            documentId, sourceId, service?.id ?? null, scenarioCode ?? null, chunk.index,
            chunk.headingPath, chunk.content, chunk.contentNorm, language, chunk.tokenEstimate,
          ],
    );
  }

  console.log(
    `\n▸ ingested "${title}"\n` +
      `  source     ${sourceCode} (${verified ? 'VERIFIED' : 'unverified'})\n` +
      `  service    ${serviceCode ?? 'all services'}\n` +
      `  chunks     ${chunks.length} embedded with ${provider.model}` +
      (provider.degraded ? '  (degraded: hash embeddings)' : '') +
      '\n',
  );

  if (!verified) {
    console.log(
      '  Chunks from this source render with an "unverified" badge until a human confirms\n' +
        '  the content and re-ingests with --verified. See docs/DATA_PROVENANCE.md.\n',
    );
  }
}

main()
  .then(() => closeDb())
  .catch(async (err: unknown) => {
    console.error('\n✖ ingest failed:', err instanceof Error ? err.message : err);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
