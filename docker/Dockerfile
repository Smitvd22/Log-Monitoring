FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY backend/package.json ./
RUN npm install --production

# Copy source
COPY backend/src ./src

# Create logs directory
RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "src/app.js"]
