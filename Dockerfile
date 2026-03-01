# Use the official Node.js image as the base image
FROM node:21

COPY . .

ENV NODE_ENV=production

# Install system dependencies required for native modules (canvas, etc.)
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies
RUN npm install

# Expose the port on which the server will run
EXPOSE 3001

# Start the server
CMD ["npm", "start"]