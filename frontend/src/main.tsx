import React from 'react';
import ReactDOM from 'react-dom/client';
// 自托管字体（替代 Google Fonts 外链）：满足严格 CSP 的 font-src 'self'，也不再把
// 访问者 IP 交给第三方。字体文件随 Vite 打包进 dist/assets。
import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/plus-jakarta-sans/800.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
