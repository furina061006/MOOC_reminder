import js from '@eslint/js';

const browserExtensionGlobals = {
  chrome: 'readonly',
  document: 'readonly',
  window: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  MutationObserver: 'readonly',
  NodeFilter: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  console: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  requestAnimationFrame: 'readonly'
};

const projectRules = {
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  // Existing scraper regexes intentionally escape / for readability inside
  // dense Chinese-date patterns. Keep lint introduction low-churn.
  'no-useless-escape': 'off'
};

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'mooc-reminder.zip',
      '.claude/**',
      '.serena/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['src/background/**/*.js', 'src/content/main.js', 'src/popup/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: browserExtensionGlobals
    },
    rules: projectRules
  },
  {
    files: ['src/shared/**/*.js', 'src/content/scrapers/**/*.js', 'src/content/observers/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: browserExtensionGlobals
    },
    rules: projectRules
  },
  {
    files: ['eslint.config.js', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly'
      }
    },
    rules: projectRules
  }
];
