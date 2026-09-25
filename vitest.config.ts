import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        // Integration tests share one PostgREST/Redis setup
        fileParallelism: false,
    },
});
