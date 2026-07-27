import React from 'react';
import ReactDOM from 'react-dom/client';
import './tokens.css';
import { AppProvider } from './state';
import App from './App';
import { loadTestify } from './testify';

// No-op unless a Testify tester session is recording — see web/src/testify.ts.
loadTestify();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
