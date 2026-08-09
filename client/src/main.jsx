import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/theme.css';
import './styles/base.css';

/**
 * StrictMode is deliberately not used.
 *
 * It double-invokes effects in development, which mounted two animation
 * drainers over the single event queue. Both walked the same token one square
 * at a time, so a roll of 2 visibly travelled about 5 squares. The animator is
 * now guarded module-wide as well, but rendering once keeps the game loop
 * honest and matches how it behaves in production.
 */
createRoot(document.getElementById('root')).render(<App />);
