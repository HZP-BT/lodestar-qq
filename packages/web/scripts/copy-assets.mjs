import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
cpSync('public/index.html', 'dist/index.html');
cpSync('public/styles.css', 'dist/styles.css');
cpSync('public/logo.jpg', 'dist/logo.jpg');
