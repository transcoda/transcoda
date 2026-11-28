import '@fontsource/bricolage-grotesque/400.css';
import '@fontsource/bricolage-grotesque/500.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthProvider.tsx';
import { ToastProvider } from './components/Toast.tsx';
import { installClientErrors, reactRootOptions } from './lib/client-errors/client-errors.ts';
import { applyTheme, cachedTheme } from './lib/theme.ts';

// The last server theme, before the first paint (auth.me confirms or changes it): no flash.
applyTheme(cachedTheme() ?? 'system');

// Errors the page hits go to this Transcoda server's log, scrubbed (docs/dev/web-ui.md).
installClientErrors();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root, reactRootOptions()).render(
  <StrictMode>
    <AuthProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AuthProvider>
  </StrictMode>,
);
