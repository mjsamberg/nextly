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
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Macintosh/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'win';
  return 'other';
})();

export const mod = platform === 'mac' || platform === 'ios' ? '⌘' : 'Ctrl+';
