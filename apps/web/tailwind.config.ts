import type { Config } from 'tailwindcss';

// Colour tokens from section 4 of the build guide. Signal colours are never used for anything else.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0B1020',
        panel: '#111827',
        raised: '#172033',
        line: '#243049',
        text: '#E5E7EB',
        muted: '#94A3B8',
        go: '#22C55E',
        slow: '#F59E0B',
        stop: '#EF4444',
        ai: '#8B5CF6',
        free: '#14B8A6',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
