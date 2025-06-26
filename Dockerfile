FROM node:20-slim

# Install necessary system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and lock file (if it exists)
COPY package.json ./
COPY package-lock.json ./

# Install dependencies (includes Puppeteer + Chromium)
RUN npm install

# Copy the rest of the app
COPY . .

# Expose app port
EXPOSE 3000

# Run the server
CMD ["npm", "start"]
