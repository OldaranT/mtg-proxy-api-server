# Base image
FROM node:20-slim

# Set Puppeteer cache location
ENV PUPPETEER_CACHE_DIR=/usr/local/share/.cache/puppeteer

# Install dependencies required by Chromium
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
  libgbm1 \
  xdg-utils \
  --no-install-recommends && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy dependency files first to leverage Docker cache
COPY package.json package-lock.json ./

# Install NPM packages (this includes Puppeteer + Chromium)
RUN npm install

# Copy application files
COPY . .

# Ensure Puppeteer's Chromium stays in cache
RUN mkdir -p /usr/local/share/.cache/puppeteer && \
    chown -R root:root /usr/local/share/.cache/puppeteer

# Expose port
EXPOSE 3000

# Start app
CMD ["npm", "start"]
