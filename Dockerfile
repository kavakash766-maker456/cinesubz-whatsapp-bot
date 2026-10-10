FROM node:20-slim

# Install Python3, pip, openssl, ffmpeg and system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    openssl \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install required Python packages for movie and gdown resolvers
RUN pip3 install --no-cache-dir --break-system-packages requests beautifulsoup4 gdown pycryptodome cryptography

WORKDIR /app

# Copy package definition and install Node dependencies
COPY package.json ./
RUN npm install --production

# Copy application files and resolver data
COPY resolver.py gdrive_resolver.py ./
COPY src/ ./src/
COPY data/ ./data/

# Create folders for auth state and temporary downloads
RUN mkdir -p /app/auth_info /app/temp

ENV NODE_ENV=production
ENV BOT_PHONE=94760372547
ENV TARGET_GROUP_JID=120363419930344447@g.us
ENV AUTH_DIR=/app/auth_info
ENV PORT=7860

EXPOSE 7860

CMD ["node", "src/index.js"]
