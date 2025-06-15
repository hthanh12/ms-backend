# Use an official Node.js runtime as a parent image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Install libvips-dev globally for sharp dependency (important for Alpine)
# See: https://sharp.pixelplumbing.com/install#alpine-linux
RUN apk add --no-cache vips-dev fftw-dev build-base g++

# Install pnpm globally in the container
RUN npm install -g pnpm

# Copy package.json and pnpm-lock.yaml (pnpm's lockfile)
# to install dependencies
COPY package.json pnpm-lock.yaml ./

# Install dependencies using pnpm
RUN pnpm install --prod --no-optional

# Build the TypeScript code
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build # Use pnpm run build

# Expose the port the app runs on
EXPOSE 3001

# Run the compiled JavaScript application
CMD ["pnpm", "start"] # Use pnpm start