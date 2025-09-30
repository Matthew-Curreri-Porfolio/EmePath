module.exports = {
  root: true,
  env: { es2022: true, node: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  extends: ['eslint:recommended', 'plugin:import/recommended'],
  plugins: ['import'],
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-undef': 'error',
    'no-console': 'off',
    'import/order': ['warn', { 'newlines-between': 'always' }],
  },
  ignorePatterns: ['node_modules/', 'dist/', 'build/'],
};
