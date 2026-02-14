/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './client/**/*.{html,js}',
    './imports/**/*.{html,js}',
    './public/**/*.{html,js}',
    './server/**/*.{html,js}'
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'qrl-primary': '#0b181e',
        'qrl-secondary': '#f4f8fb',
        'qrl-surface': '#ffffff',
        'qrl-accent': '#ffa729',
        'qrl-accent-secondary': '#4aafff',
        'qrl-blue': '#4aafff',
        'qrl-text': '#0b181e',
        'qrl-text-secondary': '#4f6472',
        'qrl-border': '#d9e5ed',
      },
      fontFamily: {
        'din': ['Alte DIN 1451 Mittelschrift', 'sans-serif'],
        'mono': ['Hack', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      boxShadow: {
        'accent': '0 0 12px rgba(255, 167, 41, 0.15)',
        'accent-lg': '0 0 24px rgba(255, 167, 41, 0.25)',
        'blue': '0 0 12px rgba(74, 175, 255, 0.15)',
        'inner-glow': 'inset 0 1px 2px rgba(255, 255, 255, 0.04)',
      },
      backgroundImage: {
        'gradient-accent': 'linear-gradient(135deg, rgba(255, 167, 41, 0.1), rgba(74, 175, 255, 0.05))',
        'gradient-card-top': 'linear-gradient(90deg, #FFA729, #4AAFFF)',
        'gradient-header-border': 'linear-gradient(90deg, #FFA729, #4AAFFF, transparent)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'card-hover': 'cardHover 0.2s ease-out forwards',
      },
      keyframes: {
        cardHover: {
          '0%': { transform: 'translateY(0)' },
          '100%': { transform: 'translateY(-2px)' },
        },
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        qrl: {
          'primary': '#ffa729',
          'secondary': '#4aafff',
          'accent': '#523ae2',
          'neutral': '#0b181e',
          'base-100': '#ffffff',
          'info': '#4aafff',
          'success': '#4fe296',
          'warning': '#fde047',
          'error': '#ff6066',
        },
      },
    ],
    darkTheme: 'qrl',
  },
}
