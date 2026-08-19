"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LSP_LANGUAGE_REGISTRY = void 0;
exports.getLspLanguageRegistry = getLspLanguageRegistry;
exports.getLspLanguageDefinition = getLspLanguageDefinition;
const PYRIGHT_INSTALL_COMMAND = process.platform === 'win32'
    ? 'py -3 -m pip install pyright'
    : 'python3 -m pip install pyright';
exports.LSP_LANGUAGE_REGISTRY = [
    {
        id: 'typescript',
        displayName: 'TypeScript / JavaScript',
        monacoLanguageIds: ['typescript', 'javascript'],
        fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
        rootMarkers: ['tsconfig.json', 'package.json'],
        serverBinary: 'typescript-language-server',
        detectArgs: ['--version'],
        install: {
            tier: 'system',
            systemHint: 'npm install -g typescript typescript-language-server',
            command: 'npm install -g typescript typescript-language-server',
        },
        capabilities: {
            completion: true,
            hover: true,
            diagnostics: true,
            definition: true,
        },
    },
    {
        id: 'go',
        displayName: 'Go',
        monacoLanguageIds: ['go'],
        fileExtensions: ['.go'],
        rootMarkers: ['go.work', 'go.mod'],
        serverBinary: 'gopls',
        detectArgs: ['version'],
        install: {
            tier: 'standalone',
            sizeHint: '~25 MB',
            systemHint: 'go install golang.org/x/tools/gopls@latest',
            command: 'go install golang.org/x/tools/gopls@latest',
        },
        capabilities: {
            completion: true,
            hover: true,
            diagnostics: true,
            definition: true,
        },
    },
    {
        id: 'rust',
        displayName: 'Rust',
        monacoLanguageIds: ['rust'],
        fileExtensions: ['.rs'],
        rootMarkers: ['Cargo.toml'],
        serverBinary: 'rust-analyzer',
        detectArgs: ['--version'],
        install: {
            tier: 'standalone',
            sizeHint: '~80 MB',
            systemHint: 'rustup component add rust-analyzer',
            command: 'rustup component add rust-analyzer',
        },
        capabilities: {
            completion: true,
            hover: true,
            diagnostics: true,
            definition: true,
        },
    },
    {
        id: 'python',
        displayName: 'Python',
        monacoLanguageIds: ['python'],
        fileExtensions: ['.py'],
        rootMarkers: ['pyproject.toml', 'requirements.txt', 'setup.py'],
        serverBinary: 'pyright-langserver',
        // pyright-langserver does not expose a reliable version command. Starting
        // it without a transport just to detect it also produces a false failure,
        // so the installer validates the resolved executable itself instead.
        detectArgs: [],
        install: {
            tier: 'system',
            systemHint: PYRIGHT_INSTALL_COMMAND,
            command: PYRIGHT_INSTALL_COMMAND,
        },
        capabilities: {
            completion: true,
            hover: true,
            diagnostics: true,
            definition: true,
        },
    },
    {
        id: 'cpp',
        displayName: 'C / C++',
        monacoLanguageIds: ['cpp', 'c'],
        fileExtensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'],
        rootMarkers: ['compile_commands.json', '.clangd'],
        serverBinary: 'clangd',
        detectArgs: ['--version'],
        install: {
            tier: 'standalone',
            sizeHint: '~60 MB',
            systemHint: 'Install clangd from LLVM or your package manager',
        },
        capabilities: {
            completion: true,
            hover: true,
            diagnostics: true,
            definition: true,
        },
    },
    {
        id: 'ruby',
        displayName: 'Ruby',
        monacoLanguageIds: ['ruby'],
        fileExtensions: ['.rb'],
        rootMarkers: ['Gemfile', '.ruby-version'],
        serverBinary: 'solargraph',
        detectArgs: ['--version'],
        install: {
            tier: 'system',
            systemHint: 'gem install solargraph',
            command: 'gem install solargraph',
        },
        capabilities: {
            completion: true,
            hover: true,
            diagnostics: true,
            definition: true,
        },
    },
    {
        id: 'php',
        displayName: 'PHP',
        monacoLanguageIds: ['php'],
        fileExtensions: ['.php'],
        rootMarkers: ['composer.json'],
        serverBinary: 'intelephense',
        // Intelephense treats --version as language-server input and can dump its
        // bundled source before exiting with an error. Executable validation is the
        // safe detection probe for this server.
        detectArgs: [],
        install: {
            tier: 'system',
            systemHint: 'npm install -g intelephense',
            command: 'npm install -g intelephense',
        },
        capabilities: {
            completion: true,
            hover: true,
            diagnostics: true,
            definition: true,
        },
    },
    {
        id: 'swift',
        displayName: 'Swift',
        monacoLanguageIds: ['swift'],
        fileExtensions: ['.swift'],
        rootMarkers: ['Package.swift'],
        serverBinary: 'sourcekit-lsp',
        detectArgs: ['version'],
        install: {
            tier: 'system',
            systemHint: 'Install the Swift toolchain to get sourcekit-lsp',
        },
        capabilities: {
            completion: true,
            hover: true,
            diagnostics: true,
            definition: true,
        },
    },
    {
        id: 'csharp',
        displayName: 'C# / .NET',
        monacoLanguageIds: ['csharp'],
        fileExtensions: ['.cs', '.csx'],
        rootMarkers: ['global.json', 'Directory.Build.props', 'Directory.Packages.props'],
        serverBinary: 'csharp-ls',
        detectArgs: ['--version'],
        install: {
            tier: 'system',
            systemHint: 'dotnet tool install --global csharp-ls',
            command: 'dotnet tool install --global csharp-ls',
        },
        capabilities: {
            completion: true,
            hover: true,
            diagnostics: true,
            definition: true,
        },
    },
];
function getLspLanguageRegistry() {
    return exports.LSP_LANGUAGE_REGISTRY;
}
function getLspLanguageDefinition(languageId) {
    return exports.LSP_LANGUAGE_REGISTRY.find((language) => language.id === languageId);
}
