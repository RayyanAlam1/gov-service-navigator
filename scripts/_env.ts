/**
 * Side-effect module: loads .env files into process.env.
 *
 * Scripts import this first (`import './_env';`) so that ES module evaluation
 * order guarantees the environment is populated before any module that reads
 * it. Kept separate from the parser so the parser stays unit-testable.
 */
import { loadEnvFiles } from './_env-loader';

loadEnvFiles();
