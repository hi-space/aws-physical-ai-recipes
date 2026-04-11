/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'aws-orange': '#FF9900',
        'aws-dark': '#232F3E',
        'aws-navy': '#1B2A4A',
      },
    },
  },
  plugins: [],
}
