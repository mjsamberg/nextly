FROM node:24-alpine
WORKDIR /app
COPY package.json server.js live.js tasks.js repeat.js capture.html ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
