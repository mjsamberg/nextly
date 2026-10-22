import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** In the app, requests go through Rust (no CORS, works with plain http on iOS). */
export const http: typeof fetch = inTauri ? tauriFetch : (...a) => window.fetch(...a);

export function openExternal(url: string) {
  if (inTauri) void openUrl(url);
  else window.open(url, '_blank', 'noopener');
}

export type Platform = 'mac' | 'win' | 'ios' | 'other';

export const platform: Platform = (() => {
  // In a plain browser, ?platform=mac|win|ios previews another platform's look.
  const forced = !inTauri && new URLSearchParams(location.search).get('platform');
  if (forced === 'mac' || forced === 'win' || forced === 'ios' || forced === 'other') return forced;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Macintosh/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'win';
  return 'other';
})();

export const mod = platform === 'mac' || platform === 'ios' ? '⌘' : 'Ctrl+';

/**
 * Windows 11 shows the window's Mica backdrop through a transparent page
 * (tauri.windows.conf.json). Windows 10 has no Mica, so the page stays opaque.
 * Windows 11 reports platform version 13 or later.
 */
export async function hasMica(): Promise<boolean> {
  if (!inTauri || platform !== 'win') return false;
  const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ platformVersion?: string }> } }).userAgentData;
  try {
    const v = await uad?.getHighEntropyValues(['platformVersion']);
    return Number(v?.platformVersion?.split('.')[0] ?? 0) >= 13;
  } catch {
    return false;
  }
}
