(() => {
  if (window.__fastmossRunnerReady) {
    // Already injected; just refresh the message listener target.
  }
  window.__fastmossRunnerReady = true;

  const STATE = { stopRequested: false };

  const SELECTORS = {
    tableRows: [
      '.ant-table-tbody > tr.ant-table-row',
      '.ant-table-tbody > tr[data-row-key]',
      '.ant-table-tbody > tr'
    ]
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    if (message.type === 'fastmossPing') {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'fastmossExtract') {
      STATE.stopRequested = false;
      extractCurrentPage(message.payload || {})
        .then((rows) => sendResponse({ ok: true, payload: { rows } }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'fastmossStop') {
      STATE.stopRequested = true;
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  async function extractCurrentPage({ keyword, periodDays, minViews, maxRows, runId }) {
    minViews = Number(minViews || 0);
    maxRows = Math.max(1, Number(maxRows || 3));

    await waitForResultsToSettle();

    const tableRows = findAll(SELECTORS.tableRows).filter(isVisible);
    emit('log', { text: `[${keyword} ${periodDays}D] Found ${tableRows.length} visible table rows.` });

    const output = [];
    let consumed = 0;

    for (let index = 0; index < tableRows.length && consumed < maxRows; index += 1) {
      if (STATE.stopRequested) break;

      const row = tableRows[index];
      const rank = consumed + 1;
      const parsed = parseTableRow(row);

      if (!parsed.views || parsed.views < minViews) {
        emit('log', { text: `Skip row ${index + 1}: views=${parsed.views ?? 'missing'} < ${minViews}` });
        continue;
      }

      consumed += 1;

      const detailUrl = parsed.detailUrl;
      let note = parsed.note || '';
      let tiktokUrl = '';
      let description = parsed.description;

      if (detailUrl) {
        try {
          const detail = await fetchDetail(detailUrl);
          if (detail.tiktokUrl) tiktokUrl = detail.tiktokUrl;
          if (!description && detail.description) description = detail.description;
        } catch (error) {
          note = appendNote(note, `detail fetch failed: ${error.message}`);
        }
      } else {
        note = appendNote(note, 'no detail URL on row');
      }

      let coverFile = '';
      if (parsed.coverUrl) {
        const download = await chrome.runtime.sendMessage({
          type: 'downloadCover',
          payload: {
            coverUrl: parsed.coverUrl,
            keyword,
            periodDays,
            rank,
            runId
          }
        }).catch((error) => ({ ok: false, error: error.message }));

        if (download?.ok) coverFile = download.filename || '';
        else note = appendNote(note, `cover download failed: ${download?.error || 'unknown'}`);
      } else {
        note = appendNote(note, 'missing cover URL');
      }

      output.push({
        keyword,
        period_days: periodDays,
        rank,
        cover_file: coverFile,
        cover_url: parsed.coverUrl,
        description,
        creator_followers: parsed.creatorFollowers,
        views: parsed.views,
        tiktok_url: tiktokUrl,
        detail_url: detailUrl,
        captured_at: new Date().toISOString(),
        note
      });
    }

    return output;
  }

  function parseTableRow(row) {
    const cells = Array.from(row.querySelectorAll('td'));
    const firstCell = cells[0] || row;
    const image = firstCell.querySelector('img');
    const coverUrl = image?.currentSrc || image?.src || image?.getAttribute('data-src') || '';
    const description = parseDescription(firstCell);
    const creatorFollowers = parseNumberFromCell(cells[2]);
    const views = parseNumberFromCell(cells[4]) || parseViewsFallback(row);
    const detailUrl = findFastMossDetailUrl(row);

    return {
      coverUrl,
      description,
      creatorFollowers,
      views,
      detailUrl,
      note: ''
    };
  }

  function parseDescription(cell) {
    // Prefer anchor/title nodes that don't wrap an image: those usually hold the
    // video caption on FastMoss listings.
    const candidates = [];

    const anchors = Array.from(cell.querySelectorAll('a'));
    for (const anchor of anchors) {
      if (anchor.querySelector('img')) continue;
      const text = cleanDescriptionText(anchor.innerText || anchor.textContent || '');
      if (text) candidates.push(text);
    }

    const blocks = Array.from(cell.querySelectorAll('p, span, div'));
    for (const block of blocks) {
      if (block.querySelector('img')) continue;
      // Skip containers that hold many children — we want leaf-ish text.
      if (block.children.length > 3) continue;
      const text = cleanDescriptionText(block.innerText || block.textContent || '');
      if (text && text.length >= 4) candidates.push(text);
    }

    candidates.sort((a, b) => b.length - a.length);
    if (candidates[0]) return candidates[0];

    return cleanDescriptionText(cell.innerText || '');
  }

  function cleanDescriptionText(value) {
    let text = normalizeWhitespace(value);
    // Strip trailing/leading "Duration: 12s" style noise.
    text = text.replace(/Duration\s*:?\s*\d+\s*s/gi, '').trim();
    text = text.replace(/^AD\s+/i, '');
    return text;
  }

  function parseNumberFromCell(cell) {
    if (!cell) return null;
    return parseMetric(cell.innerText || cell.textContent || '');
  }

  function parseViewsFallback(row) {
    const metrics = Array.from(row.querySelectorAll('td'))
      .map((cell) => parseMetric(cell.innerText || ''))
      .filter((value) => Number.isFinite(value));
    if (metrics.length === 0) return null;
    return Math.max(...metrics);
  }

  function findFastMossDetailUrl(row) {
    const links = Array.from(row.querySelectorAll('a[href]'));
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!href || href.startsWith('javascript:')) continue;
      if (/tiktok\.com/i.test(href)) continue;
      try {
        const url = new URL(href, location.origin);
        if (url.origin !== location.origin) continue;
        // Prefer URLs that look like a video detail page.
        return url.href;
      } catch {
        continue;
      }
    }
    return '';
  }

  async function fetchDetail(detailUrl) {
    const response = await fetch(detailUrl, {
      credentials: 'include',
      headers: { 'Accept': 'text/html,application/xhtml+xml' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    return {
      tiktokUrl: findTikTokVideoUrlInHtml(html),
      description: findDescriptionInHtml(html)
    };
  }

  function findTikTokVideoUrlInHtml(html) {
    // Accept only canonical /video/<id> URLs — never @user homepages.
    const regex = /https?:\\?\/\\?\/(?:[^"'\\\s/<>]+\.)?tiktok\.com\\?\/(?:@[^"'\\\s/<>]+\\?\/)?video\\?\/\d+[^"'\\\s<>]*/i;
    const match = html.match(regex);
    if (!match) return '';
    return match[0].replace(/\\\//g, '/').replace(/&amp;/g, '&');
  }

  function findDescriptionInHtml(html) {
    // Best-effort: look for og:description or twitter:description.
    const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    if (og) return decodeHtmlEntities(og[1]).trim();
    const tw = html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i);
    if (tw) return decodeHtmlEntities(tw[1]).trim();
    return '';
  }

  function decodeHtmlEntities(text) {
    return String(text)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  async function waitForResultsToSettle() {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const rows = findAll(SELECTORS.tableRows).filter(isVisible);
      if (rows.length > 0) {
        // Give the cells one more tick to fully render text.
        await sleep(600);
        return;
      }
      await sleep(300);
    }
  }

  function findAll(selectors) {
    const elements = [];
    for (const selector of selectors) {
      try {
        elements.push(...document.querySelectorAll(selector));
      } catch {
        emit('log', { text: `Unsupported selector skipped: ${selector}` });
      }
    }
    return Array.from(new Set(elements));
  }

  function parseMetric(text) {
    const normalized = normalizeWhitespace(text).replaceAll(',', '');
    if (!normalized) return null;
    const match = normalized.match(/(\d+(?:\.\d+)?)\s*([kKmM]?)/);
    if (!match) return null;
    const number = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1;
    return Math.round(number * multiplier);
  }

  function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden'
      && style.display !== 'none'
      && Number(style.opacity || 1) !== 0
      && rect.width > 0
      && rect.height > 0;
  }

  function appendNote(existing, next) {
    return [existing, next].filter(Boolean).join('; ');
  }

  function emit(type, payload) {
    chrome.runtime.sendMessage({ type: `fastmoss:${type}`, payload }).catch(() => {});
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
