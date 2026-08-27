import path from 'node:path';
import type { Config } from 'tailwindcss';

/**
 * `content` globs are resolved against process.cwd(). Anchoring them to this
 * file instead means the stylesheet is complete no matter which directory the
 * build was started from — see the note in postcss.config.mjs.
 *
 * Tailwind loads this file through jiti, which provides CommonJS `__dirname`.
 * The fallback keeps it working if that ever changes.
 */
const projectRoot = typeof __dirname === 'string' ? __dirname : process.cwd();
const from = (glob: string) => path.join(projectRoot, glob).replace(/\\/g, '/');

/**
 * Design tokens.
 *
 * Everything is a CSS variable so light and dark are one definition, and so no
 * component ever hard-codes a hex value. The palette is deliberately
 * neutral-forward with a single green accent: the semantic colours in this
 * product carry real meaning — verified vs unverified, ready vs not ready — and
 * a decorative palette competing with them would make the trust signals harder
 * to read, which is the one thing this interface cannot afford.
 *
 * Audience assumptions, from the product brief: citizens who are often anxious,
 * often on a mid-range Android phone, often on a slow connection. That drives
 * 16px base text, 44px touch targets, generous line-height, and no animation
 * that carries meaning on its own.
 */
const config: Config = {
  content: [from('src/**/*.{ts,tsx}')],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        // Surfaces
        canvas: 'rgb(var(--c-canvas) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        'surface-raised': 'rgb(var(--c-surface-raised) / <alpha-value>)',
        'surface-sunken': 'rgb(var(--c-surface-sunken) / <alpha-value>)',
        border: 'rgb(var(--c-border) / <alpha-value>)',
        'border-strong': 'rgb(var(--c-border-strong) / <alpha-value>)',

        // Text — all pairs meet 4.5:1 on their intended surface.
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        'ink-muted': 'rgb(var(--c-ink-muted) / <alpha-value>)',
        'ink-subtle': 'rgb(var(--c-ink-subtle) / <alpha-value>)',
        'ink-inverse': 'rgb(var(--c-ink-inverse) / <alpha-value>)',

        // Brand
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          hover: 'rgb(var(--c-accent-hover) / <alpha-value>)',
          soft: 'rgb(var(--c-accent-soft) / <alpha-value>)',
          ink: 'rgb(var(--c-accent-ink) / <alpha-value>)',
        },

        // Semantic. These are the load-bearing colours in this product.
        verified: {
          DEFAULT: 'rgb(var(--c-verified) / <alpha-value>)',
          soft: 'rgb(var(--c-verified-soft) / <alpha-value>)',
          ink: 'rgb(var(--c-verified-ink) / <alpha-value>)',
        },
        unverified: {
          DEFAULT: 'rgb(var(--c-unverified) / <alpha-value>)',
          soft: 'rgb(var(--c-unverified-soft) / <alpha-value>)',
          ink: 'rgb(var(--c-unverified-ink) / <alpha-value>)',
        },
        synthetic: {
          DEFAULT: 'rgb(var(--c-synthetic) / <alpha-value>)',
          soft: 'rgb(var(--c-synthetic-soft) / <alpha-value>)',
          ink: 'rgb(var(--c-synthetic-ink) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--c-danger) / <alpha-value>)',
          soft: 'rgb(var(--c-danger-soft) / <alpha-value>)',
          ink: 'rgb(var(--c-danger-ink) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'rgb(var(--c-info) / <alpha-value>)',
          soft: 'rgb(var(--c-info-soft) / <alpha-value>)',
          ink: 'rgb(var(--c-info-ink) / <alpha-value>)',
        },
      },

      fontFamily: {
        sans: ['var(--font-latin)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        urdu: ['var(--font-urdu)', 'Noto Naskh Arabic', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      fontSize: {
        // 16px base with 1.5 line-height. Nothing citizen-facing goes below 14px.
        xs: ['0.8125rem', { lineHeight: '1.5' }],
        sm: ['0.875rem', { lineHeight: '1.5' }],
        base: ['1rem', { lineHeight: '1.6' }],
        lg: ['1.125rem', { lineHeight: '1.55' }],
        xl: ['1.25rem', { lineHeight: '1.45' }],
        '2xl': ['1.5rem', { lineHeight: '1.35' }],
        '3xl': ['1.875rem', { lineHeight: '1.25' }],
        '4xl': ['2.25rem', { lineHeight: '1.15' }],
      },

      spacing: {
        // 44px: the minimum comfortable touch target.
        touch: '2.75rem',
      },

      borderRadius: {
        card: '0.875rem',
        field: '0.625rem',
      },

      boxShadow: {
        card: '0 1px 2px rgb(0 0 0 / 0.04), 0 4px 12px rgb(0 0 0 / 0.05)',
        raised: '0 2px 4px rgb(0 0 0 / 0.05), 0 12px 28px rgb(0 0 0 / 0.08)',
        focus: '0 0 0 3px rgb(var(--c-accent) / 0.35)',
      },

      maxWidth: {
        reading: '68ch',
      },

      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
      },
      animation: {
        // Short and functional. Motion here signals "this changed", nothing more.
        'fade-up': 'fade-up 180ms cubic-bezier(0.2, 0, 0.2, 1)',
        'pulse-soft': 'pulse-soft 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
