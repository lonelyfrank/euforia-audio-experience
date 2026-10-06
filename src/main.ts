import { App } from './app/App';
import '@fontsource-variable/geist';
import './ui/tokens.css';
import './ui/app.css';

const root = document.getElementById('app');
if (!root) throw new Error('#app root element missing');

const app = new App(root);
void app.start();

// Handy for debugging from the devtools console during development.
if (import.meta.env.DEV) Object.assign(window, { app });
