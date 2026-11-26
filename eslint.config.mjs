import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: ['build/', 'node_modules/', 'test/', '*.config.mjs', 'admin/'],
    },
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['*.mjs'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // Comments where they help, not on every member
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
            'jsdoc/require-returns': 'off',
        },
    },
];
