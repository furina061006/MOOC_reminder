/**
 * Debug Helper — MOOC Reminder 测试辅助脚本
 *
 * 在 Chrome DevTools Console 中粘贴运行此脚本，
 * 帮助诊断 content script 是否正常工作。
 *
 * 使用方法:
 *   1. 打开 icourse163.org 课程页面
 *   2. F12 打开 DevTools → Console
 *   3. 粘贴此脚本
 *   4. 查看输出结果
 */

(function () {
  'use strict';

  console.log('%c🔍 MOOC Reminder Debug Helper %cv1.0',
    'font-size:16px;font-weight:bold;', 'font-size:12px;color:#888;');
  console.log('='.repeat(60));

  const results = {
    url: window.location.href,
    hash: window.location.hash,
    timestamp: new Date().toISOString()
  };

  // ── Test 1: Page Environment ─────────────────────────
  console.log('\n%c📄 Test 1: Page Environment', 'font-weight:bold;font-size:13px;');
  console.log('  URL:', results.url);
  console.log('  Hash:', results.hash);

  const isLearnPage = /\/learn\//.test(results.url);
  const isSPOC = /\/spoc\//.test(results.url);
  console.log('  Is Learn Page:', isLearnPage ? '✅' : '❌');
  console.log('  Is SPOC:', isSPOC);

  // ── Test 2: Content Script Detection ────────────────
  console.log('\n%c📝 Test 2: Content Script Status', 'font-weight:bold;font-size:13px;');

  // Check if our content script is loaded
  chrome.runtime.sendMessage({ type: 'GET_HOMEWORK' }, (response) => {
    if (chrome.runtime.lastError) {
      console.log('  Content Script: ❌ Not detected');
      console.log('  Error:', chrome.runtime.lastError.message);
    } else {
      console.log('  Content Script: ✅ Active');
      console.log('  Stored Items:', response?.allItems?.length || 0);
      console.log('  Unfinished:', response?.items?.length || 0);
      console.log('  Courses:', response?.courses?.length || 0);
      console.log('  Last Sync:', response?.lastSync || 'Never');
    }
  });

  // ── Test 3: DOM Structure Analysis ──────────────────
  console.log('\n%c🏗️ Test 3: DOM Structure Analysis', 'font-weight:bold;font-size:13px;');

  const selectors = {
    'Chapter Container': ['.j-chapterlist', '.chapter-list', '.m-chapter', '[class*="chapter"]'],
    'Chapter Items': ['.j-chapter-item', '.m-chapter-item', '.chapter-item', '[class*="chapterItem"]'],
    'Lesson Items': ['.j-lesson', '.j-lesson-item', '.m-lesson-item', '[class*="lesson"]'],
    'Homework Items': ['.j-test-item', '.m-test-item', '.j-homework-item', '[class*="testItem"]', '[class*="homeworkItem"]'],
    'Login Wall': ['.login-form', '.j-login', '#login-form'],
    'Loading Indicators': ['.j-loading', '.m-loading', '[class*="loading"]']
  };

  results.selectors = {};

  for (const [name, sels] of Object.entries(selectors)) {
    let matched = null;
    for (const sel of sels) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          matched = { selector: sel, count: els.length, sample: els[0].textContent?.trim().substring(0, 60) };
          break;
        }
      } catch { /* invalid selector */ }
    }

    const status = matched ? `✅ ${matched.count} found` : '❌ None found';
    console.log(`  ${name}: ${status}`);
    if (matched) {
      console.log(`    → Selector: "${matched.selector}", Sample: "${matched.sample}"`);
    }
    results.selectors[name] = matched;
  }

  // ── Test 4: Homework Text Analysis ──────────────────
  console.log('\n%c📋 Test 4: Homework-like Elements', 'font-weight:bold;font-size:13px;');

  const allElements = document.querySelectorAll('a, span, div, li');
  const homeworkKeywords = ['作业', '测验', '考试', '讨论', '测试', 'homework', 'quiz', 'exam', 'test'];
  const foundKeywords = [];

  for (const el of allElements) {
    const text = (el.textContent || '').trim();
    for (const kw of homeworkKeywords) {
      if (text.includes(kw) && text.length > 2 && text.length < 300) {
        foundKeywords.push({
          text: text.substring(0, 80),
          tag: el.tagName,
          class: el.className?.substring(0, 60) || '(none)',
          href: el.getAttribute('href') || '',
          keyword: kw
        });
        break; // count once per element
      }
    }
  }

  console.log(`  Found ${foundKeywords.length} elements with homework keywords`);
  foundKeywords.slice(0, 15).forEach((f, i) => {
    console.log(`  [${i + 1}] <${f.tag}> "${f.text}"`);
    console.log(`      class="${f.class}", href="${f.href}"`);
  });

  // ── Test 5: Status Indicators ───────────────────────
  console.log('\n%c✅ Test 5: Completion Status Detection', 'font-weight:bold;font-size:13px;');

  const completePatterns = {
    classPatterns: ['done', 'finished', 'completed', 'is-pass', 'is-done', 'm-homeworkItem-done', 'status-done'],
    textPatterns: ['已完成', '已提交', '已批阅', '已通过', '得分']
  };

  let completeElements = [];
  for (const pattern of completePatterns.classPatterns) {
    try {
      const els = document.querySelectorAll(`[class*="${pattern}"]`);
      for (const el of els) {
        if (!completeElements.includes(el)) completeElements.push(el);
      }
    } catch {}
  }

  for (const pattern of completePatterns.textPatterns) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.includes(pattern)) {
        const parent = walker.currentNode.parentElement;
        if (parent && !completeElements.includes(parent)) {
          completeElements.push(parent);
        }
      }
    }
  }

  console.log(`  Found ${completeElements.length} elements with completion indicators`);
  completeElements.slice(0, 10).forEach((el, i) => {
    console.log(`  [${i + 1}] <${el.tagName}> "${(el.textContent || '').trim().substring(0, 60)}"`);
    console.log(`      class="${(el.className || '').substring(0, 60)}"`);
  });

  // ── Test 6: Trigger Manual Scrape ───────────────────
  console.log('\n%c🔄 Test 6: Trigger Manual Scrape', 'font-weight:bold;font-size:13px;');
  try {
    chrome.runtime.sendMessage({ type: 'SCRAPE_NOW' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('  ❌', chrome.runtime.lastError.message);
      } else if (response) {
        const c = response.course;
        const items = response.homeworkItems || [];
        console.log(`  ✅ Scraped ${items.length} items`);
        console.log(`  Course: ${c?.courseName || 'N/A'} (${c?.courseId || 'N/A'})`);
        items.forEach((item, i) => {
          console.log(`  [${i + 1}] "${item.title}" — ${item.type} — ${item.status} — ${item.deadline || '无截止'}`);
        });
      }
    });
  } catch (e) {
    console.log('  ❌ Error:', e.message);
  }

  // ── Summary ─────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('%c📊 Summary', 'font-weight:bold;font-size:14px;');
  console.log('  Page Type:', isSPOC ? 'SPOC' : 'MOOC');
  console.log('  Selector Coverage:', Object.values(results.selectors).filter(Boolean).length, '/', Object.keys(results.selectors).length);

  // Store results globally for further inspection
  window.__mooc_debug = results;
  console.log('\n  %cResults stored in window.__mooc_debug%c for further inspection',
    'color:#007BFF;', 'color:inherit;');
  console.log('='.repeat(60));

})();
