import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { DialogProvider } from './dialog.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <DialogProvider>
    <App />
  </DialogProvider>,
);
