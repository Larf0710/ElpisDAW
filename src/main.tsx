import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { consumeLocalEngineBootstrap } from './localEngineBootstrap';
import './styles.css';

const localEngineBootstrap = consumeLocalEngineBootstrap(window.location, window.history);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App engineBootstrap={localEngineBootstrap} />
  </React.StrictMode>,
);
