import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/mulish/400.css';
import '@fontsource/mulish/600.css';
import '@fontsource/mulish/800.css';
import '@fontsource/oswald/500.css';
import '@fontsource/oswald/600.css';
import './styles.css';
import App from './App';
import { load } from './store';
import { initSync } from './sync';
import { initApple } from './apple';
import { platform } from './net';

document.documentElement.dataset.platform = platform;

const root = createRoot(document.getElementById('root')!);

load()
  .then(initSync)
  .then(initApple)
  .then(() => root.render(<React.StrictMode><App /></React.StrictMode>))
  .catch((e) => root.render(<p className="fatal">Nextly couldn’t open its local database: {String(e)}</p>));
