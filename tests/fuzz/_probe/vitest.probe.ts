import base from '../../../vitest.config';
const config = { ...base, test: { ...base.test, include: ['tests/fuzz/_probe/*.spec.ts'], exclude: [] } };
export default config;
