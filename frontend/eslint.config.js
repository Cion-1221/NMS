// ESLint 9 flat config：TypeScript 推荐规则 + React Hooks 检查。
// 运行：npm run lint（CI 不阻塞构建；本地提交前自查用）。
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 项目现状取舍：antd charts 的配置对象与部分 API 响应体使用 any 断言
      //（图表库 v2 的 prop 类型与运行时不完全一致），不作为错误。
      '@typescript-eslint/no-explicit-any': 'off',
      // 未使用变量降为警告；_ 前缀参数（有意占位）不报
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
