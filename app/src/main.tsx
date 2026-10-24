import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/mulish/400.css';
import '@fontsource/mulish/600.css';
import '@fontsource/mulish/800.css';
import '@fontsource/oswald/500.css';
import '@fontsource/oswald/600.css';
import './styles.css';
import './platform.css';
import App from './App';
import { load, promoteDue } from './store';
import { initSync, inStep, setOnSynced } from './sync';
import { initApple } from './apple';
import { initCapture } from './capture';
import { hasMica, inTauri, platform } from './net';

document.documentElement.dataset.platform = platform;
if (inTauri) document.documentElement.dataset.app = '';
void hasMica().then((m) => { if (m) document.documentElement.dataset.mica = ''; });

const root = createRoot(document.getElementById('root')!);

load()
  .then(initSync)
  .then(startDailyCheck)
  .then(initApple)
  .then(() => root.render(<React.StrictMode><App /></React.StrictMode>))
  .then(() => initCapture())
  .catch((e) => root.render(<p className="fatal">Nextly couldn’t open its local database: {String(e)}</p>));

/**
 * Tasks with a start date (including the next copy of a repeating task) move
 * into Today on that day: check at launch, when the app comes back to the
 * front, after each sync, and every minute in case the date rolls over while
 * it's open. Not before this device has synced since launch: moving a stale
 * copy would undo newer edits from other devices (say, a task finished there).
 */
function startDailyCheck() {
  const check = () => { if (inStep()) promoteDue(); };
  check();
  setOnSynced(check);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  setInterval(check, 60_000);
}
