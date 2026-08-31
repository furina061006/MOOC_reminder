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
  XMLHttpRequest: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  console: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  requestAnimationFrame: 'readonly',
  Blob: 'readonly'
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
    // Page-context scripts (classic, run in the page or content-script world)
    files: ['src/content/main.js', 'src/content/course-discovery.js', 'src/content/xhr-hook.js', 'src/content/xhr-hook-page.js', 'src/content/spoc-tid-bridge.js', 'src/popup/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: browserExtensionGlobals
    },
    rules: projectRules
  },
  {
    files: ['src/shared/**/*.js', 'src/background/**/*.js', 'src/content/scrapers/**/*.js', 'src/content/observers/**/*.js'],
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
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
    },
    rules: projectRules
  }
];
