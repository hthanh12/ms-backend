# image-converter-backend/Dockerfile

# Stage 1: Build the TypeScript application
FROM node:20-alpine AS builder

# Set the working directory in the container
WORKDIR /app

# Ensure repositories are updated and 'community' repo is enabled for multimedia packages.
RUN apk update && \
    apk add --no-cache \
    vips-dev \
    fftw-dev \
    build-base \
    g++ \
    ffmpeg \
    x264-dev \ 
    libvpx-dev \
    ca-certificates \
    && rm -rf /var/cache/apk/* # Clean up apk cache

# Install pnpm globally in the container.
RUN npm install -g pnpm

# Copy package.json and pnpm-lock.yaml.
COPY package.json pnpm-lock.yaml ./

# Install ALL dependencies (including devDependencies) for the build stage.
RUN pnpm install

# Copy the TypeScript source code and configuration.
COPY tsconfig.json ./
COPY src ./src

# Build the TypeScript code into JavaScript.
RUN pnpm run build

# Stage 2: Create the final lightweight production image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Ensure repositories are updated for the final image.
# Install runtime dependencies for FFmpeg and Sharp.
RUN apk update && \
    apk add --no-cache \
    vips-dev \
    ffmpeg \
    x264 \
    libvpx \
    ca-certificates \
    && rm -rf /var/cache/apk/* 

# Create a temporary directory if it doesn't exist and ensure permissions.
RUN mkdir -p /tmp/converted-videos && chmod 777 /tmp/converted-videos

# Copy only the necessary compiled files and production node_modules from the builder stage.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Expose the port the Express app runs on.
EXPOSE 3001

# Set environment variables for production.
ENV NODE_ENV=production

# Command to run the compiled JavaScript application.
# This should directly execute the Node.js application, not call pnpm.
CMD ["node", "dist/index.js"]
