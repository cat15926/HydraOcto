import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import CollaborationApp from './CollaborationApp';

import ObserverPage from './ObserverPage';

const observer = new URLSearchParams(window.location.search).get('observe');
const legacy = observer === null && new URLSearchParams(window.location.search).get('legacy') === '1';
void (legacy ? import('./styles.css') : import('./collaboration.css')).then(() => {
  createRoot(document.getElementById('root')!).render(<React.StrictMode>{observer !== null ? <ObserverPage room={observer} /> : legacy ? <App /> : <CollaborationApp />}</React.StrictMode>);
});
