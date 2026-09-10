#!/bin/bash
# Phoenix Music Maker UI Setup Script

set -e

echo "=================================="
echo "  Phoenix Music Maker UI Setup"
echo "=================================="

# Check if Phoenix Engine exists
ACESTEP_PATH="${ACESTEP_PATH:-../Phoenix-Engine}"

if [ ! -d "$ACESTEP_PATH" ]; then
    echo "Error: Phoenix Engine not found at $ACESTEP_PATH"
    echo ""
    echo "Please clone Phoenix Engine first:"
    echo "  cd .."
    echo "  git clone <your-phoenix-engine-mirror-or-install> Phoenix-Engine"
    echo "  cd Phoenix-Engine"
    echo "  uv venv && uv pip install -e ."
    echo "  cd ../Phoenix-Music-Maker-UI"
    echo "  ./setup.sh"
    exit 1
fi

if [ ! -d "$ACESTEP_PATH/.venv" ]; then
    echo "Error: Phoenix Engine venv not found. Please set up Phoenix Engine first:"
    echo "  cd $ACESTEP_PATH"
    echo "  uv venv && uv pip install -e ."
    exit 1
fi

echo "Found Phoenix Engine at: $ACESTEP_PATH"

# Get absolute path
ACESTEP_PATH=$(cd "$ACESTEP_PATH" && pwd)

# Create .env file
echo "Creating .env file..."
cat > .env << EOF
# Phoenix Music Maker UI Configuration

# Path to Phoenix Engine installation
ACESTEP_PATH=$ACESTEP_PATH

# Server ports
PORT=3001
FRONTEND_PORT=3000

# Database
DATABASE_PATH=./server/data/phoenix.db
EOF

# Install frontend dependencies
echo ""
echo "Installing frontend dependencies..."
npm install

# Install server dependencies
echo ""
echo "Installing server dependencies..."
cd server
npm install
cd ..

# Initialize database
echo ""
echo "Initializing database..."
cd server
npm run migrate 2>/dev/null || echo "Migration script not found, skipping..."
cd ..

echo ""
echo "=================================="
echo "  Setup Complete!"
echo "=================================="
echo ""
echo "To start the application:"
echo ""
echo "  # Terminal 1 - Start backend"
echo "  cd server && npm run dev"
echo ""
echo "  # Terminal 2 - Start frontend"
echo "  npm run dev"
echo ""
echo "Then open http://localhost:3000"
echo ""
