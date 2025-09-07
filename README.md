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
   yarn setup
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
yarn config                  # View configuration
yarn config:set              # Set configuration values
yarn config:reset            # Reset configuration to defaults
yarn setup                   # Interactive setup
yarn help                    # Show usage examples
yarn cx                      # Direct CLI access
```

### Configuration
```bash
# Set configuration values
yarn config:set style conventional
yarn config:set model gemini-1.5-flash

# View configuration
yarn config
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
| `yarn config` | View configuration |
| `yarn config:set` | Set configuration values |
| `yarn config:reset` | Reset to defaults |
| `yarn setup` | Interactive setup |
| `yarn help` | Show usage examples |
| `yarn cx` | Direct CLI access |

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | - | Gemini AI API key |
| `model` | string | `gemini-1.5-flash` | AI model to use |

```
Implemented comprehensive error handling with retry logic for API requests
Refactored user authentication system to use JWT tokens for better scalability
```
