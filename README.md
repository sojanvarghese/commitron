# CommitX

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> AI-powered Git commit assistant that intelligently analyzes your code changes and generates clear, concise, and context-aware commit messages using Google's Gemini AI.

## ✨ Features

- 🤖 **Smart Analysis** - Automatically understands code changes and generates contextual commit messages
- 📝 **Multiple Workflows** - Individual file processing or traditional batch commits
- 🎯 **Intelligent Fallbacks** - Summary messages for large files, lock files, and build artifacts
- 🔧 **Interactive Mode** - Choose from AI-generated suggestions or write custom messages
- 🔒 **Security-First** - Path validation, input sanitization, and secure API key handling
- ⚡ **Fast & Reliable** - Optimized performance with retry logic and error recovery

## 🚀 Quick Start

### Prerequisites
- Node.js 20.0.0+
- Yarn package manager
- Git repository
- [Gemini AI API key](https://makersuite.google.com/app/apikey)

### Installation

```bash
# Clone and install locally
git clone https://github.com/sojanvarghese/commit-x.git
cd commit-x
yarn install
yarn build

# Install globally (after building)
yarn global add file:.
```

### Setup

```bash
# Interactive setup
commit-x setup

# Or set API key directly
export GEMINI_API_KEY="your_api_key_here"
```

### Usage

```bash
# Process files individually (recommended)
commit-x

# Traditional workflow
commit-x commit --all

# Preview changes
commit-x commit --dry-run
```

## 📖 Commands

| Command | Description |
|---------|-------------|
| `commit-x` | Process files individually with AI |
| `commit-x commit --all` | Stage all files and commit together |
| `commit-x commit --dry-run` | Preview commits without executing |
| `commit-x status` | Show repository status |
| `commit-x diff` | Show changes summary (staged changes only) |
| `commit-x config` | View configuration |
| `commit-x config set <key> <value>` | Set configuration value |
| `commit-x config reset` | Reset configuration to defaults |
| `commit-x setup` | Interactive setup |

## ⚙️ Configuration

```bash
# View current configuration
commit-x config

# Set configuration values
commit-x config set model gemini-1.5-flash

# Reset to defaults
commit-x config reset
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | - | Gemini AI API key (use environment variable) |
| `model` | string | `gemini-1.5-flash` | AI model to use |


### Available Scripts

| Script | Description |
|--------|-------------|
| `yarn build` | Compile TypeScript |
| `yarn dev` | Run in development mode |
| `yarn lint` | Run ESLint |
| `yarn format` | Format code with Prettier |
| `yarn commit` | Process files individually |
| `yarn commit:all` | Stage all files and commit together |

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Google Gemini AI](https://ai.google.dev/) for the AI capabilities
- [Simple Git](https://github.com/steveukx/git-js) for Git operations
- [Commander.js](https://github.com/tj/commander.js) for CLI interface
