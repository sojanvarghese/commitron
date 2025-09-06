.PHONY: build install clean dev test lint format help

# Default target
help:
	@echo "CommitX - AI-Powered Git Commit Assistant"
	@echo "========================================="
	@echo ""
	@echo "Available targets:"
	@echo "  build     - Compile TypeScript to JavaScript"
	@echo "  install   - Install dependencies"
	@echo "  clean     - Remove build artifacts"
	@echo "  dev       - Run in development mode"
	@echo "  test      - Run tests"
	@echo "  lint      - Run ESLint"
	@echo "  format    - Format code with Prettier"
	@echo "  setup     - Install dependencies and build"
	@echo ""

# Build the project
build:
	@echo "🔧 Building TypeScript..."
	yarn build
	chmod +x dist/cli.js

# Install dependencies
install:
	@echo "📦 Installing dependencies with Yarn..."
	yarn install

# Clean build artifacts
clean:
	@echo "🧹 Cleaning build artifacts..."
	rm -rf dist/
	rm -rf node_modules/

# Development mode
dev:
	@echo "🚀 Starting development mode..."
	yarn dev

# Run linter
lint:
	@echo "🔍 Running ESLint..."
	yarn lint

# Format code
format:
	@echo "✨ Formatting code..."
	yarn format

# Setup (install + build)
setup: install build
	@echo "✅ Setup complete!"
	@echo ""
	@echo "Next steps:"
	@echo "1. Set your API key: export GEMINI_API_KEY=your_key"
	@echo "2. Run: yarn start or node dist/cli.js"
