import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import { OfflineIndicator } from './components/OfflineIndicator';
import { staticPreview } from './lib/deployment';
import './index.css';

if (!staticPreview) registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    {!staticPreview && <OfflineIndicator />}
  </>
);
