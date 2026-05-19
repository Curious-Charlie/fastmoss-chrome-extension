const state = {
  running: false,
  stopRequested: false,
  rows: [],
  runId: createRunId()
};

const elements = {
  keywords: document.querySelector('#keywords'),
  loadKeywords: document.querySelector('#loadKeywords'),
  clearResults: document.querySelector('#clearResults'),
  minViews: document.querySelector('#minViews'),
  maxRows: document.querySelector('#maxRows'),
  start: document.querySelector('#start'),
  stop: document.querySelector('#stop'),
  exportCsv: document.querySelector('#exportCsv'),
  statusText: document.querySelector('#statusText'),
  resultCount: document.querySelector('#resultCount'),
  progress: document.querySelector('#progress'),
  log: document.querySelector('#log')
};

elements.loadKeywords.addEventListener('click', loadKeywordsFromFile);
elements.clearResults.addEventListener('click', clearResults);
elements.start.addEventListener('click', startRun);
elements.stop.addEventListener('click', stopRun);
elements.exportCsv.addEventListener('click', exportCsv);

chrome.runtime.onMessage.addListener((message) => {
  if (!message?.type?.startsWith('fastmoss:')) {
    return;
  }
  const type = message.type.replace('fastmoss:', '');
  const payload = message.payload || {};
  if (type === 'log') appendLog(payload.text);
});

loadKeywordsFromFile().catch((error) => {
  appendLog(`Could not load keywords.txt: ${error.message}`);
});

async function loadKeywordsFromFile() {
  const url = chrome.runtime.getURL('keywords.txt');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  elements.keywords.value = normalizeKeywordText(text);
  appendLog(`Loaded ${parseKeywords(text).length} keywords from keywords.txt`);
}

async function startRun() {
  const keywords = parseKeywords(elements.keywords.value);
  if (keywords.length === 0) {
    appendLog('No keywords to run.');
    return;
  }

  const tab = await getFastMossTab();
  if (!tab) {
    appendLog('Open a FastMoss page (https://www.fastmoss.com/) first, then run the exporter.');
    return;
  }

  state.rows = [];
  state.runId = createRunId();
  state.stopRequested = false;
  updateResultCount();
  setRunning(true);
  setStatus('Starting...', 0);
  appendLog(`Run ID: ${state.runId}`);
  appendLog(`Target tab: ${tab.url}`);

  const minViews = Number(elements.minViews.value || 100000);
  const maxRows = Number(elements.maxRows.value || 3);

  // 28D temporarily disabled per request. Re-add 28 to the list when 7D is stable.
  const periods = [7];
  // const periods = [7, 28];

  const totalSteps = keywords.length * periods.length;
  let step = 0;

  for (const keyword of keywords) {
    if (state.stopRequested) break;

    const keywordRows = [];
    for (const periodDays of periods) {
      if (state.stopRequested) break;

      const url = buildSearchUrl(keyword, periodDays);
      appendLog(`Navigating: ${url}`);
      setStatus(`Loading "${keyword}" ${periodDays}D`, step / totalSteps);

      try {
        await navigateAndWait(tab.id, url);
      } catch (error) {
        appendLog(`Navigation failed: ${error.message}`);
        step += 1;
        continue;
      }

      // Give the SPA a moment to mount the table.
      await sleep(2000);

      try {
        await ensureContentScript(tab.id);
      } catch (error) {
        appendLog(`Content script injection failed: ${error.message}`);
        step += 1;
        continue;
      }

      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, {
          type: 'fastmossExtract',
          payload: { keyword, periodDays, minViews, maxRows, runId: state.runId }
        });
      } catch (error) {
        appendLog(`Extract message failed: ${error.message}`);
        response = { ok: false, error: error.message };
      }

      if (response?.ok) {
        const rows = response.payload?.rows || [];
        keywordRows.push(...rows);
        state.rows.push(...rows);
        updateResultCount();
        appendLog(`Collected ${rows.length} rows for "${keyword}" ${periodDays}D.`);
      } else {
        appendLog(`No data for "${keyword}" ${periodDays}D: ${response?.error || 'unknown'}`);
      }

      step += 1;
      setStatus(`"${keyword}" ${periodDays}D done`, totalSteps ? step / totalSteps : 1);
    }

    if (keywordRows.length > 0) {
      const dl = await chrome.runtime.sendMessage({
        type: 'exportKeywordCsv',
        payload: { rows: keywordRows, keyword, runId: state.runId }
      }).catch((error) => ({ ok: false, error: error.message }));

      if (dl?.ok) {
        appendLog(`CSV saved: ${dl.filename}`);
      } else {
        appendLog(`Per-keyword CSV failed for "${keyword}": ${dl?.error || 'unknown'}`);
      }
    } else {
      appendLog(`No rows to export for "${keyword}".`);
    }
  }

  setStatus(`Done. ${state.rows.length} total rows.`, 1);
  setRunning(false);
}

async function stopRun() {
  state.stopRequested = true;
  appendLog('Stop requested. Will exit after the current keyword.');
}

async function exportCsv() {
  if (state.rows.length === 0) {
    appendLog('No rows to export.');
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: 'exportCsv',
    payload: { rows: state.rows, runId: state.runId }
  });

  if (response?.ok) appendLog(`Combined CSV download started: ${response.filename}`);
  else appendLog(`CSV export failed: ${response?.error || 'unknown error'}`);
}

function clearResults() {
  state.rows = [];
  updateResultCount();
  elements.log.textContent = '';
  setStatus('Idle', 0);
}

async function getFastMossTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url?.startsWith('https://www.fastmoss.com/')) return active;
  const tabs = await chrome.tabs.query({ url: 'https://www.fastmoss.com/*' });
  return tabs[0] || null;
}

async function ensureContentScript(tabId) {
  const ping = await chrome.tabs.sendMessage(tabId, { type: 'fastmossPing' }).catch(() => null);
  if (ping?.ok) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/runner.js']
  });
  await sleep(300);
}

function buildSearchUrl(keyword, periodDays) {
  const params = new URLSearchParams({
    page: '1',
    words: keyword,
    pagesize: '10',
    d_type: String(periodDays),
    columnKey: '2',
    field: 'play_count_show',
    order: '2,2'
  });
  return `https://www.fastmoss.com/media-source/video?${params.toString()}`;
}

function navigateAndWait(tabId, url) {
  return new Promise((resolve, reject) => {
    const timeoutMs = 25000;
    let settled = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
    };

    const listener = (id, info, updatedTab) => {
      if (id !== tabId) return;
      if (info.status === 'complete' && updatedTab?.url?.startsWith('https://www.fastmoss.com/')) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Navigation timeout'));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch((error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function parseKeywords(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function normalizeKeywordText(text) {
  return parseKeywords(text).join('\n');
}

function setRunning(running) {
  state.running = running;
  elements.start.disabled = running;
  elements.stop.disabled = !running;
  elements.exportCsv.disabled = running || state.rows.length === 0;
}

function setStatus(text, progress = null) {
  elements.statusText.textContent = text || 'Idle';
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    elements.progress.value = Math.max(0, Math.min(1, progress));
  }
}

function updateResultCount() {
  elements.resultCount.textContent = `${state.rows.length} ${state.rows.length === 1 ? 'row' : 'rows'}`;
  elements.exportCsv.disabled = state.running || state.rows.length === 0;
}

function appendLog(text) {
  const timestamp = new Date().toLocaleTimeString();
  elements.log.textContent += `[${timestamp}] ${text}\n`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRunId() {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
}
