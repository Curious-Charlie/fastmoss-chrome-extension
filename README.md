# FastMoss TikTok US Exporter

Chrome extension MVP for exporting FastMoss TikTok US video data.

## MVP Scope

- Reads keywords from the bundled `keywords.txt`.
- Runs each keyword for 7D (28D temporarily disabled — re-enable in `sidepanel.js` once 7D is stable).
- Side panel drives navigation directly to the FastMoss results URL with query parameters; the content script only extracts the current page.
- Detail enrichment is done with a same-origin `fetch` of the FastMoss detail HTML. Any TikTok URL must contain `/video/` to be accepted; `@user` homepages are rejected.
- Reads only the first N visible rows on the first results page.
- Keeps only rows with `views >= minimum views`.
- Downloads cover images to `fastmoss-export/<runId>/images/`.
- Writes one CSV per keyword as soon as that keyword finishes (`fastmoss-export/<runId>/<keyword>.csv`). A combined CSV can still be exported manually.
- Exports a CSV with:
  - keyword
  - period_days
  - rank
  - cover_file
  - cover_url
  - description
  - creator_followers
  - views
  - tiktok_url
  - detail_url
  - captured_at
  - note

## Local Install

1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this `fastmoss-extension` folder.
5. Open FastMoss and log in.
6. Navigate to the TikTok US video page.
7. Click the extension icon to open the side panel.
8. Click Start.

## Calibration Notes

This MVP is intentionally observable. It logs each step in the side panel.

The list page extraction is based on the visible table structure. The TikTok original link is optional — the current scope only requires the FastMoss detail URL. The TikTok URL is filled in only when the detail HTML contains a canonical `tiktok.com/@user/video/<id>` link; otherwise it is left blank.

## Current Limitations

- No pagination yet.
- No retry queue yet.
- No packaged Chrome Web Store build yet.
- The extension assumes the table column order used by the current FastMoss TikTok US video page.
