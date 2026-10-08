FROM node:20-slim

# Install Python3, pip, openssl, and build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    openssl \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package definition and install Node dependencies
COPY package.json ./
RUN npm install --production

# Copy application files
COPY resolver.py ./
COPY src/ ./src/

# Create folders for auth state and temporary downloads
RUN mkdir -p /app/auth_info /app/temp

ENV NODE_ENV=production
ENV BOT_PHONE=94760372547
ENV TARGET_GROUP_JID=120363419930344447@g.us
ENV AUTH_DIR=/app/auth_info

CMD ["node", "src/index.js"]
