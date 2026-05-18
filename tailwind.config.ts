import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/frontend/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: '#06070f',
        card: 'rgba(255,255,255,0.05)',
        border: 'rgba(255,255,255,0.08)',
        accent: '#f59e0b',
      },
    },
  },
  plugins: [],
};

export default config;
