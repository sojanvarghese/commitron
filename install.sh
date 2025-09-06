#!/bin/bash

# CommitX Installation Script
set -e

echo "🚀 Installing CommitX - AI-Powered Git Commit Assistant"
echo "=================================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 16+ first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
    echo "❌ Node.js 16+ is required. Current version: $(node -v)"
    exit 1
fi

echo "✅ Node.js $(node -v) detected"

# Check if npm is available
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not available. Please install npm."
    exit 1
fi

echo "✅ npm $(npm -v) detected"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Build the project
echo ""
echo "🔧 Building TypeScript..."
npm run build

# Make CLI executable
echo ""
echo "🔗 Setting up CLI..."
chmod +x dist/cli.js

# Optionally link globally
echo ""
read -p "🌍 Link CommitX globally? This allows you to use 'commit-x' from anywhere (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    npm link
    echo "✅ CommitX linked globally"
    echo "   You can now use: commit-x or cx"
else
    echo "ℹ️  To use CommitX, run: npm start or node dist/cli.js"
fi

# Check for API key
echo ""
echo "🔑 API Key Setup"
if [ -f ".env" ]; then
    echo "✅ .env file found"
else
    echo "⚠️  No .env file found"
    read -p "   Create .env file with your Gemini API key? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        read -p "   Enter your Gemini API key: " API_KEY
        echo "GEMINI_API_KEY=$API_KEY" > .env
        echo "✅ .env file created"
    else
        echo "   You can set your API key later with:"
        echo "   export GEMINI_API_KEY=your_api_key"
        echo "   or run: commit-x setup"
    fi
fi

echo ""
echo "🎉 Installation complete!"
echo ""
echo "Next steps:"
echo "1. Get your Gemini API key: https://makersuite.google.com/app/apikey"
echo "2. Run: commit-x setup (for interactive configuration)"
echo "3. Navigate to a git repository"
echo "4. Run: commit-x (to start making AI-powered commits)"
echo ""
echo "Examples:"
echo "  commit-x                    # Process files individually"
echo "  commit-x commit --all       # Traditional workflow"
echo "  commit-x status             # Show repository status"
echo "  commit-x help-examples      # Show more examples"
echo ""
echo "Happy committing! 🚀"
