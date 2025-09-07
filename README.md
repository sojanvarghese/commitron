# CommitX

AI-powered Git commit assistant that analyzes your code changes and generates meaningful commit messages using Gemini AI.

## Features

- **Smart Analysis**: Automatically understands code changes and generates contextual commit messages
- **Multiple Styles**: Support for conventional, descriptive, and minimal commit message formats
- **Individual Processing**: Commits files individually with tailored messages
- **Interactive Mode**: Choose from AI-generated suggestions or write custom messages


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
   yarn cx:setup
   ```

2. **Commit changes**:
   ```bash
   yarn commit
   ```

## Usage

### Commands
```bash
yarn commit                  # Process files individually with AI
yarn commit:all              # Stage all files and commit together
yarn commit:dry              # Preview commits without executing
yarn status                  # Show repository status
yarn diff                    # Show changes summary
yarn cx:config               # View configuration
yarn cx:setup                # Interactive setup
yarn cx:help                 # Show usage examples
```

### Configuration
```bash
# Set configuration values
yarn cx:config:set style conventional
yarn cx:config:set model gemini-1.5-flash

# View configuration
yarn cx:config
```

### Yarn Scripts
All commands are available as convenient yarn scripts:

| Script | Description |
|--------|-------------|
| `yarn commit` | Process files individually with AI |
| `yarn commit:all` | Stage all files and commit together |
| `yarn commit:dry` | Preview commits without executing |
| `yarn status` | Show repository status |
| `yarn diff` | Show changes summary |
| `yarn cx:config` | View configuration |
| `yarn cx:config:set` | Set configuration values |
| `yarn cx:config:reset` | Reset to defaults |
| `yarn cx:setup` | Interactive setup |
| `yarn cx:help` | Show usage examples |
| `yarn cx` | Direct CLI access |

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
