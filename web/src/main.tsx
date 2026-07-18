import React from 'react';
import ReactDOM from 'react-dom/client';
import './tokens.css';
import { AppProvider } from './state';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
