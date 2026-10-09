import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { applyTheme, readTheme } from './lib/theme';

// Restore appearance before mounting; keep scripts external for the strict CSP.
applyTheme(readTheme());
mount(App, { target: document.getElementById('app')! });
