import { queryUseCase } from './usecases/query.js';

const mockReq = { body: { q: 'test term', k: 5 } };
const mockRes = {
  status: (s) => ({
    json: (j) => {
      console.log('status', s, j);
    },
  }),
  json: (j) => {
    console.log('json', j);
  },
};

const deps = {
  escapeRe: (s) => s.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'),
  getIndex: () => ({
    root: '/tmp',
    files: [
      {
        path: 'a.txt',
        text: 'This is a test term. Test_term and test-term. test123',
      },
    ],
  }),
  makeSnippets: (text, terms) => ['snippet'],
};

(async () => {
  await queryUseCase(mockReq, mockRes, deps);
})();
