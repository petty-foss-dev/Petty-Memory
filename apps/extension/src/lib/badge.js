import { ext } from './browser.js';
import { listOutbox, summarize } from './outbox.js';

export const OK_COLOR = '#0F7A8A';
export const ERROR_COLOR = '#B23A31';
const QUEUE_COLOR = '#53616B';
const FLASH_MS = 2000;

/** The global badge counts captures waiting to sync; per-tab flashes sit on top of it. */
export async function showOutboxCount() {
  const { waiting, failed } = summarize(await listOutbox());
  const count = waiting + failed;
  await ext.action.setBadgeBackgroundColor({ color: failed ? ERROR_COLOR : QUEUE_COLOR });
  await ext.action.setBadgeTextColor({ color: '#FFFFFF' });
  await ext.action.setBadgeText({ text: count ? String(count) : '' });
}

export async function flashBadge(tabId, text, color) {
  if (tabId === undefined) return;
  const restoreColor = await ext.action.getBadgeBackgroundColor({});
  await ext.action.setBadgeBackgroundColor({ tabId, color });
  await ext.action.setBadgeText({ tabId, text });
  setTimeout(async () => {
    try {
      // null drops the tab's override so the global count shows again; colors have no reset, so restore the global one.
      await ext.action.setBadgeText({ tabId, text: null });
      await ext.action.setBadgeBackgroundColor({ tabId, color: restoreColor });
    } catch {
      // The tab closed.
    }
  }, FLASH_MS);
}
