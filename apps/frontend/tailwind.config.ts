import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#0B0F17',
        surface: {
          DEFAULT: '#111827',
          elevated: '#161F30',
          subtle: '#0F1522',
        },
        border: {
          subtle: 'rgba(148, 163, 184, 0.14)',
          strong: 'rgba(148, 163, 184, 0.26)',
        },
        accent: {
          DEFAULT: '#38BDF8',
          hover: '#0EA5E9',
          muted: 'rgba(56, 189, 248, 0.14)',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(148, 163, 184, 0.08)',
        popover: '0 12px 32px -4px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(148, 163, 184, 0.14)',
      },
    },
  },
  plugins: [],
};

export default config;
