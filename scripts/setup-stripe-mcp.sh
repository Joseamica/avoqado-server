#!/bin/bash

# Setup Stripe MCP for Claude Code
# This script updates claude_desktop_config.json with Stripe API key

CONFIG_FILE="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
STRIPE_KEY="sk_test_a5qO2sn2n6AYZEge444HVrXU00v1RQv7qr"

echo "🔧 Setting up Stripe MCP for Claude Code..."

# Create directory if it doesn't exist
mkdir -p "$HOME/Library/Application Support/Claude"

# Check if config file exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo "📝 Creating new config file..."
  cat > "$CONFIG_FILE" <<EOF
{
  "mcpServers": {
    "stripe": {
      "command": "npx",
      "args": ["-y", "@stripe/mcp", "--tools=all"],
      "env": {
        "STRIPE_SECRET_KEY": "$STRIPE_KEY"
      }
    }
  }
}
EOF
  echo "✅ Config file created!"
else
  echo "⚠️  Config file already exists at:"
  echo "   $CONFIG_FILE"
  echo ""
  echo "📋 Add this configuration manually:"
  echo ""
  cat <<EOF
{
  "mcpServers": {
    "stripe": {
      "command": "npx",
      "args": ["-y", "@stripe/mcp", "--tools=all"],
      "env": {
        "STRIPE_SECRET_KEY": "$STRIPE_KEY"
      }
    }
  }
}
EOF
fi

echo ""
echo "🔄 Next steps:"
echo "   1. Quit Claude Code completely"
echo "   2. Reopen Claude Code"
echo "   3. Start a new conversation"
echo "   4. I'll be able to use Stripe MCP tools!"
