# Release Process

This document explains how to release new versions of Commitron using our automated CI/CD workflow.

## 🚀 Automated Release Workflow

Our release process is fully automated using GitHub Actions. When a Pull Request is merged to the `main` branch with specific labels, it automatically:

1. **Bumps the version** in `package.json`
2. **Creates a Git tag**
3. **Commits the version bump**
4. **Publishes to npm**
5. **Creates a GitHub Release**

## 📋 How to Release

### Step 1: Create a Pull Request
Create a PR with your changes as usual.

### Step 2: Add Release Label
Add **exactly one** of these labels to your PR:

| Label | Version Bump | Example | Use Case |
|-------|-------------|---------|----------|
| `patch` | 1.0.0 → 1.0.1 | Bug fixes, small improvements |
| `minor` | 1.0.0 → 1.1.0 | New features, non-breaking changes |
| `major` | 1.0.0 → 2.0.0 | Breaking changes |

### Step 3: Merge the PR
When you merge the PR, the release workflow automatically triggers.

### Step 4: Release is Published
- ✅ Version bumped in `package.json`
- ✅ Git tag created (e.g., `v1.0.1`)
- ✅ Package published to npm
- ✅ GitHub Release created

## 🔧 Manual Release (Local)

If you need to release manually for testing:

```bash
# Patch release (1.0.0 → 1.0.1)
yarn release:patch

# Minor release (1.0.0 → 1.1.0)
yarn release:minor

# Major release (1.0.0 → 2.0.0)
yarn release:major
```

## 📋 Prerequisites

### GitHub Repository Settings
1. **NPM_TOKEN**: Add your npm publish token to repository secrets
   - Go to Settings → Secrets and variables → Actions
   - Add `NPM_TOKEN` with your npm token

### NPM Token Setup
```bash
# Create npm token (run locally)
npm login
npm token create --read-only=false
```

## 🏷️ Creating Labels

Create these labels in your GitHub repository:

```bash
# Using GitHub CLI
gh label create "patch" --color "d4edda" --description "Patch release (bug fixes)"
gh label create "minor" --color "fff3cd" --description "Minor release (new features)"
gh label create "major" --color "f8d7da" --description "Major release (breaking changes)"
```

Or manually in GitHub:
1. Go to Issues → Labels
2. Create labels: `patch`, `minor`, `major`

## ⚠️ Important Notes

- **Only one release label** per PR
- **No label = No release** - PR merges without triggering release
- **Release happens on merge** - Not when PR is created
- **Main branch only** - Releases only from `main` branch
- **Automatic versioning** - Don't manually edit version in `package.json`

## 🔍 Troubleshooting

### Release Didn't Trigger
- Check if PR has correct label (`patch`, `minor`, or `major`)
- Verify PR was merged (not just closed)
- Check GitHub Actions tab for workflow runs

### NPM Publish Failed
- Verify `NPM_TOKEN` is correctly set in repository secrets
- Check if version already exists on npm
- Ensure npm token has publish permissions

### Git Push Failed
- Check if `GITHUB_TOKEN` has sufficient permissions
- Verify branch protection rules allow the workflow to push

## 📊 Workflow Status

You can monitor release progress:
1. Go to **Actions** tab in GitHub
2. Look for "Release Package" workflow
3. Check logs for any errors

## 🎯 Examples

### Bug Fix Release
1. Create PR with bug fixes
2. Add `patch` label
3. Merge PR
4. Result: `1.0.0 → 1.0.1`

### New Feature Release
1. Create PR with new features
2. Add `minor` label
3. Merge PR
4. Result: `1.0.0 → 1.1.0`

### Breaking Change Release
1. Create PR with breaking changes
2. Add `major` label
3. Merge PR
4. Result: `1.0.0 → 2.0.0`
