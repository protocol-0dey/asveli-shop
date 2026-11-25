import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/inter';
import '@fontsource-variable/manrope';
import './styles.css';
import App from './App';
import { AppProvider, AuthProvider, CartProvider } from './state';

createRoot(document.getElementById('root')!).render(
  <StrictMode><BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AppProvider><AuthProvider><CartProvider><App /></CartProvider></AuthProvider></AppProvider></BrowserRouter></StrictMode>
);
