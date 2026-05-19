import { toCsv } from './lib/csv.js';
import { extensionFromUrl, safeFilePart } from './lib/filename.js';

const CSV_COLUMNS = [
  'keyword',
  'period_days',
  'rank',
  'cover_file',
  'cover_url',
  'description',
  'creator_followers',
  'views',
  'tiktok_url',
  'detail_url',
  'captured_at',
  'note'
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  if (!message || typeof message.type !== 'string') {
    return { ok: false, error: 'Invalid message' };
  }

  if (message.type === 'downloadCover') return downloadCover(message.payload);
  if (message.type === 'exportCsv') return exportCsv(message.payload);
  if (message.type === 'exportKeywordCsv') return exportKeywordCsv(message.payload);

  return { ok: false, error: `Unknown message type: ${message.type}` };
}

async function downloadCover(payload) {
  const { coverUrl, keyword, periodDays, rank, runId } = payload;
  if (!coverUrl) return { ok: true, filename: '' };

  const extension = extensionFromUrl(coverUrl);
  const keywordPart = safeFilePart(keyword, 'keyword');
  const rankPart = String(rank || 0).padStart(3, '0');
  const filename = `fastmoss-export/${safeFilePart(runId, 'run')}/images/${keywordPart}-${periodDays}d-${rankPart}.${extension}`;

  const downloadId = await chrome.downloads.download({
    url: coverUrl,
    filename,
    conflictAction: 'uniquify',
    saveAs: false
  });

  return { ok: true, downloadId, filename };
}

function rowsToCsvDataUrl(rows) {
  const csvRows = [CSV_COLUMNS, ...rows.map((row) => CSV_COLUMNS.map((column) => row[column] ?? ''))];
  const csv = toCsv(csvRows);
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

async function exportCsv(payload) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const runId = payload.runId || new Date().toISOString().replaceAll(':', '-');
  const url = rowsToCsvDataUrl(rows);
  const filename = `fastmoss-export/${safeFilePart(runId, 'run')}/fastmoss-export.csv`;

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'uniquify',
    saveAs: true
  });

  return { ok: true, downloadId, filename };
}

async function exportKeywordCsv(payload) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const runId = payload.runId || new Date().toISOString().replaceAll(':', '-');
  const keyword = payload.keyword || 'keyword';
  const url = rowsToCsvDataUrl(rows);
  const filename = `fastmoss-export/${safeFilePart(runId, 'run')}/${safeFilePart(keyword, 'keyword')}.csv`;

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'uniquify',
    saveAs: false
  });

  return { ok: true, downloadId, filename };
}
