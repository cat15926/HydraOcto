import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import CollaborationApp from './CollaborationApp';

const legacy = new URLSearchParams(window.location.search).get('legacy') === '1';
void (legacy ? import('./styles.css') : import('./collaboration.css')).then(() => {
  createRoot(document.getElementById('root')!).render(<React.StrictMode>{legacy ? <App /> : <CollaborationApp />}</React.StrictMode>);
});
