import { describe, expect, it } from 'vitest';
import { stripSslMode } from '@/lib/db/client';

/**
 * `sslmode` is removed from the connection string only because TLS is
 * configured explicitly in `poolTuning`. These tests pin the two properties
 * that makes safe: nothing else in the URL is disturbed, and a string we
 * cannot parse is handed back untouched rather than mangled.
 */
describe('stripSslMode', () => {
  it('removes sslmode from a managed-provider URL', () => {
    const out = stripSslMode(
      'postgresql://user:pw@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    );
    expect(out).not.toContain('sslmode');
    expect(out).toContain('ep-x-pooler.ap-southeast-1.aws.neon.tech');
    expect(out).toContain('/neondb');
  });

  it('preserves every other parameter, including channel_binding', () => {
    // channel_binding is load-bearing: Neon requires it and pg 8.23 implements
    // SCRAM-SHA-256-PLUS to satisfy it. Dropping it would break the connection.
    const out = stripSslMode(
      'postgresql://user:pw@host/db?sslmode=require&channel_binding=require&application_name=gsn',
    );
    expect(out).toContain('channel_binding=require');
    expect(out).toContain('application_name=gsn');
    expect(out).not.toContain('sslmode');
  });

  it('leaves the credentials and database name intact', () => {
    const out = stripSslMode('postgresql://neondb_owner:npg_secret@host.tld/neondb?sslmode=require');
    expect(out).toContain('neondb_owner');
    expect(out).toContain('npg_secret');
    expect(out).toContain('/neondb');
  });

  it('is a no-op when there is no sslmode', () => {
    const url = 'postgresql://user:pw@localhost:5432/gsn';
    expect(stripSslMode(url)).toBe(url);
  });

  it('returns an unparseable string unchanged rather than mangling it', () => {
    // pg should be the one to report a malformed URL, with its own message.
    const junk = 'not-a-url-at-all';
    expect(stripSslMode(junk)).toBe(junk);
  });

  it('is idempotent', () => {
    const once = stripSslMode('postgresql://u:p@host/db?sslmode=require&channel_binding=require');
    expect(stripSslMode(once)).toBe(once);
  });
});
