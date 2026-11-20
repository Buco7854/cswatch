import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Let the viewer's dynamic Scene import keep renderer dependencies out of the app entry.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:8000', '/map-assets': 'http://localhost:8000' },
  },
});
