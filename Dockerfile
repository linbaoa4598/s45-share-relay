FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 TCP_PORT=9999
COPY --chown=node:node package.json server.js protocol.js app.js index.html map.png ./
COPY --chown=node:node heroes ./heroes
USER node
EXPOSE 8888 9999
CMD ["node", "server.js"]
