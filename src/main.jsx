import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './index.css';

const authFragments = [window.location.search.slice(1), window.location.hash.replace(/^#/, ''), window.location.hash.split('?').slice(1).join('?')];
if (authFragments.some(fragment => new URLSearchParams(fragment).get('type') === 'recovery')) {
  try { sessionStorage.setItem('questtask:password-recovery', 'true'); } catch { /* optional session marker */ }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode><HashRouter><App /></HashRouter></React.StrictMode>,
);
