# MOOC Reminder - Chrome/Edge Extension

A Manifest V3 browser extension to track unfinished homework on 中国大学MOOC (icourse163.org).

## Architecture

- **Content Script** (`src/content/`): Runs on icourse163.org learn pages, scrapes DOM for homework data
- **Background Service Worker** (`src/background/`): Manages alarms, badge updates, data reconciliation
- **Popup** (`src/popup/`): Displays homework list, allows manual check-off
- **Shared** (`src/shared/`): Data models, storage utilities, message protocol

## Platform: icourse163.org

### URL Patterns
- Course learn page: `https://www.icourse163.org/learn/{school}-{courseId}?tid={termId}#/learn/content`
- SPOC variant: `https://www.icourse163.org/spoc/learn/{school}-{courseId}?tid={termId}#/learn/content`
- Hash routes: `#/learn/content`, `#/learn/announce`, `#/learn/score`, etc.

### SPA Characteristics
- Hash-based routing (SPA, no page reloads)
- Dynamic content loading via XHR/fetch
- DOM uses `j-` prefix for JS hooks, `m-` for modules, `u-` for utilities
- Content loads asynchronously after hash navigation

### Scraping Scope
- **Only** "测验与作业" (`#/learn/quiz`) and "考试" (`#/learn/exam`) sections
- These pages use flat table/list structures (not chapter→lesson hierarchy)
- See `src/content/selectors.json` → `quizExamPage` for page-specific selectors

### Key Selector Patterns
- See `src/content/selectors.json` for current calibrated selectors
- Quiz/Exam list containers: `.j-quizlist`, `.j-testlist`, `.j-examlist`
- List items: `.j-test-item`, `.j-quiz-item`, `[class*="quizItem"]`, table rows
- Completion indicators: class names containing `done`, `finished`, `completed` or text "已完成"

### Full Architecture
See `.claude/logs/architecture.md` for comprehensive architecture documentation.

## Data Model

### HomeworkItem UID
Format: `{courseId}_tid{termId}_ch{chapterId}_le{lessonId}_hw{homeworkId}`
Example: `BIT-268001_tid1460270441_ch3_l2_hw5`

### Storage Keys (chrome.storage.local)
- `homework_items`: Array of HomeworkItem
- `courses`: Array of Course
- `last_sync`: ISO timestamp
- `sync_errors`: Ring buffer of recent errors
- `user_settings`: User preferences

## Development Commands

```bash
# Load extension in Chrome for testing
# 1. Go to chrome://extensions/
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select the MOOC_reminder directory

# Lint JavaScript files
npx eslint src/

# Package for distribution
zip -r mooc-reminder.zip . -x ".*" "node_modules/*" "tests/*" "logs/*"
```

## Key Design Decisions

1. **No backend**: Pure browser extension, all data in chrome.storage.local
2. **DOM scraping**: Primary data source is page scraping, not API interception
3. **Manual overrides auto**: User manual check-off always wins over auto-detection
4. **Selector config**: All selectors in `selectors.json` for easy calibration
5. **SPA-aware**: Uses URL hash monitoring + DOM MutationObserver for dynamic pages

## Known Limitations

- Can only scrape when user has icourse163.org tabs open
- Selectors may break if icourse163.org changes their frontend
- No cross-device sync (chrome.storage.local is device-local)
- Chinese date parsing may fail on unusual formats
