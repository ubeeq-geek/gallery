import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { initializeAppearance } from './appearance';
import { brand } from './brand';
import './styles.css';

document.title = brand.productName;
document.documentElement.dataset.productBrand = brand.id;
initializeAppearance();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
