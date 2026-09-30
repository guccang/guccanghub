/** 独立演示入口，宿主也可直接嵌入 RuntimePanel。 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimePanel } from './RuntimePanel.js';
import '@xyflow/react/dist/style.css';
import './style.css';
import './demo.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><RuntimePanel /></React.StrictMode>);
