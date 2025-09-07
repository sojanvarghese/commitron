# CommitX

AI-powered Git commit assistant that analyzes your code changes and generates meaningful commit messages using Gemini AI.

## Features

- **Smart Analysis**: Automatically understands code changes and generates contextual commit messages
- **Multiple Styles**: Support for conventional, descriptive, and minimal commit message formats
- **Individual Processing**: Commits files individually with tailored messages
- **Interactive Mode**: Choose from AI-generated suggestions or write custom messages
- **E2E Test Support**: Special handling for Playwright and testing files

## Installation

### Prerequisites
- Node.js 20.0.0 or higher
- Yarn package manager
- Git repository
- Gemini AI API key ([Get one here](https://makersuite.google.com/app/apikey))

### Install
```bash
git clone https://github.com/sojanvarghese/commit-x.git
cd commit-x
yarn install
yarn build
yarn global add file:.
```

## Quick Start

1. **Setup**:
   ```bash
   commit-x setup
   ```

2. **Commit changes**:
   ```bash
   commit-x commit
   ```

## Usage

### Commands
```bash
commit-x commit              # Process files individually with AI
commit-x commit --all        # Stage all files and commit together
commit-x commit -m "message" # Use custom message
commit-x status              # Show repository status
commit-x diff                # Show changes summary
commit-x config get          # View configuration
commit-x setup               # Interactive setup
```

### Configuration
```bash
# Set configuration values
commit-x config set style conventional
commit-x config set model gemini-1.5-flash

# View configuration
commit-x config get
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | - | Gemini AI API key |
| `model` | string | `gemini-1.5-flash` | AI model to use |
| `style` | string | `conventional` | Commit message style (`conventional`, `descriptive`, `minimal`) - length is automatically adjusted per style |

Configuration is stored in `~/.commit-x/config.json`.

## Commit Message Styles

### Conventional
```
feat(auth): Added OAuth2 integration with Google provider
fix(api): Resolved null pointer exception in user validation
```

### Descriptive
```
Implemented comprehensive error handling with retry logic for API requests
Refactored user authentication system to use JWT tokens for better scalability
```

### Minimal
```
Added user validation
Fixed login bug
```

## Development

### Build from Source

```bash
# Install dependencies
yarn install

# Build TypeScript to dist/
yarn build

# Run in development mode (ts-node)
yarn dev

# Run built CLI
yarn start

# Lint TypeScript files
yarn lint

# Format TypeScript files with Prettier
yarn format

# Clean dependencies and lock file
yarn clean
```

## License

MIT License - see [LICENSE](LICENSE) file for details.
