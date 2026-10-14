import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { HamlibProvider } from 'hamlib-wasm/react';

import { App } from './App';
import './style.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('the example markup is missing #root');
}

createRoot(container).render(
  <StrictMode>
    <HamlibProvider>
      <App />
    </HamlibProvider>
  </StrictMode>,
);
