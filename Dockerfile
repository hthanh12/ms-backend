
# Stage 1: Build the TypeScript application
FROM node:20-alpine AS builder

# Set the working directory in the container
WORKDIR /app

# Install build-base, g++, and necessary FFmpeg dependencies.
# 'build-base' and 'g++' are crucial for compiling native Node.js modules (like sharp).
# 'ffmpeg' is for video conversion.
# 'libx264-dev' and 'libvpx-dev' provide H.264 and VP8/VP9 codecs for FFmpeg.
# 'ca-certificates' is often good practice for SSL/TLS connections.
RUN apk add --no-cache \
    vips-dev \
    fftw-dev \
    build-base \
    g++ \
    ffmpeg \
    libx264-dev \
    libvpx-dev \
    ca-certificates \
    && rm -rf /var/cache/apk/* # Clean up apk cache

# Install pnpm globally in the container.
RUN npm install -g pnpm

# Copy package.json and pnpm-lock.yaml.
COPY package.json pnpm-lock.yaml ./

# Install ALL dependencies (including devDependencies) for the build stage.
# This is crucial because 'pnpm run build' often needs devDependencies like 'typescript'.
RUN pnpm install # <--- REMOVED --prod --no-optional HERE

# Copy the TypeScript source code and configuration.
COPY tsconfig.json ./
COPY src ./src

# Build the TypeScript code into JavaScript.
RUN pnpm run build

# Stage 2: Create the final lightweight production image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Install FFmpeg and other runtime dependencies needed for sharp, etc.
RUN apk add --no-cache \
    vips-dev \
    ffmpeg \
    libx264 \
    libvpx \
    ca-certificates \
    && rm -rf /var/cache/apk/* # Clean up apk cache

# Create a temporary directory if it doesn't exist and ensure permissions.
RUN mkdir -p /tmp/converted-videos && chmod 777 /tmp/converted-videos

# Copy only the necessary compiled files and production node_modules from the builder stage.
# We copy 'node_modules' as a whole because pnpm creates a content-addressable store.
# However, the final image needs only *production* dependencies. This could be optimized further
# by explicitly copying only production dependencies if pnpm's structure allows easier filtering.
# For simplicity and robust build, copy all then rely on --prod in builder.
# A more advanced pnpm Docker pattern might involve `pnpm deploy --prod`
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Expose the port the Express app runs on.
EXPOSE 3001

# Set environment variables for production.
ENV NODE_ENV=production

# Command to run the compiled JavaScript application.
CMD ["pnpm", "start"]
